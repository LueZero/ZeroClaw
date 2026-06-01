/**
 * ContainerManager — 管理 Docker 容器生命週期
 *
 * v0.3: 每組 (group, agent) 對應一個共用容器，
 * 容器內可複用多個 SDK session（multiplexing）。
 * `maxSessions` = 容器內最大同時 SDK session 數量上限。
 * API server 啟動時從 DB 恢復已存在的容器（ContainerPool persistence）。
 */

import Docker from 'dockerode';
import { resolve, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { Errors } from '@zeroclaw/shared';
import type {
  ContainerInstance,
  GroupConfig,
  AgentMetadata,
} from '@zeroclaw/shared';
import type { Env } from '../config/env.js';
import type { DbStore } from '../db/db-store.js';
import { CopilotAgentProvider } from '../agent/copilot-provider.js';
import { OpencodeAgentProvider } from '../agent/opencode-provider.js';
import type { AgentProvider } from '../agent/agent-provider.js';

const RUNTIME_PORT = 7080;

interface ContainerEntry {
  instance: ContainerInstance;
  provider: AgentProvider;
  docker: Docker.Container;
  /** SDK session ID */
  sdkSessions: Set<string>;
}

function keyOf(groupId: string, agentId: string): string {
  return `${groupId}::${agentId}`;
}

export interface ContainerManager {
  /** 取得（或啟動）(group, agent) 對應的共用容器，回傳 entry */
  acquire(group: GroupConfig, agent: AgentMetadata): Promise<ContainerEntry>;
  /** 依 containerId 查找對應 entry */
  findEntry(containerId: string): ContainerEntry | undefined;
  /** 列出所有容器 */
  list(): ContainerInstance[];
  /** 停止指定容器 */
  stop(containerId: string): Promise<void>;
  /** 將 SDK session 掛載到容器 */
  attachSession(containerId: string, sdkSessionId: string): void;
  /** 將 SDK session 從容器卸載 */
  detachSession(containerId: string, sdkSessionId: string): void;
  /** 啟動 GC（idle 時自動清理容器） */
  startGc(): void;
  /** 重啟容器（session 遷移由 SessionManager 處理） */
  restart(containerId: string, group: GroupConfig, agent: AgentMetadata): Promise<ContainerEntry>;
  /** 標記容器為無效並移除 entry（僅從記憶體清除，不執行 stop） */
  invalidate(containerId: string): void;
  /** 從 DB 恢復已存在的執行中容器 */
  adoptFromDb(): Promise<void>;
  /** 監聽 unhealthy 事件 */
  onUnhealthy(handler: (cid: string, groupId: string, agentId: string) => void): void;
  /** 強制重新 build agent image 並重啟所有使用該 image 的容器 (T-6) */
  rebuildImage(agent: AgentMetadata, group: GroupConfig): Promise<void>;
  /** 釋放所有資源 */
  dispose(): Promise<void>;
}

export type { ContainerEntry };

export interface CreateContainerManagerOptions {
  env: Env;
  logger: Logger;
  agentsDir: string;
  db: DbStore;
}

export function createContainerManager(
  opts: CreateContainerManagerOptions,
): ContainerManager {
  const { env, logger, agentsDir, db } = opts;
  const docker = new Docker(
    env.DOCKER_SOCKET ? { socketPath: env.DOCKER_SOCKET } : undefined,
  );
  /** key = groupId::agentId → 共用容器，per (group, agent) 一個 */
  const containers = new Map<string, ContainerEntry>();
  /** 防止 (group, agent) 同時啟動多次的 inflight promise */
  const inflight = new Map<string, Promise<ContainerEntry>>();
  let gcTimer: NodeJS.Timeout | null = null;
  let healthTimer: NodeJS.Timeout | null = null;

  const failCounts = new Map<string, number>();
  const HEALTH_INTERVAL_MS = 30_000;
  const MAX_FAIL_COUNT = 3;

  let unhealthyHandler: ((cid: string, groupId: string, agentId: string) => void) | null = null;

  async function acquire(
    group: GroupConfig,
    agent: AgentMetadata,
  ): Promise<ContainerEntry> {
    const key = keyOf(group.id, agent.id);

    // 檢查是否有 running 容器，做 readiness probe
    const existing = containers.get(key);
    if (existing && existing.instance.status === 'running') {
      try {
        const ok = await existing.provider.isReady();
        if (ok) return existing;
        logger.warn({ containerId: existing.instance.containerId }, 'Cached entry failed isReady — re-launching');
      } catch (err) {
        logger.warn({ err, containerId: existing.instance.containerId }, 'Cached entry threw on isReady — invalidating');
      }
      existing.instance.status = 'unhealthy';
      void invalidateInternal(existing.instance.containerId);
    }

    // 防止重複啟動
    const pending = inflight.get(key);
    if (pending) return pending;

    const launch = (async () => {
      try {
        const entry = await launchContainer(group, agent);
        containers.set(key, entry);
        // Persist to DB
        try { await db.upsertContainer(entry.instance); } catch (e) { logger.warn({ err: e }, 'Failed to persist container'); }
        return entry;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, launch);
    return launch;
  }

  async function launchContainer(
    group: GroupConfig,
    agent: AgentMetadata,
  ): Promise<ContainerEntry> {
    // 命名規則：zeroclaw-{group}-{agent}，每 (group, agent) 一個容器
    const containerId = `zeroclaw-${sanitizeDockerName(group.id)}-${sanitizeDockerName(agent.id)}`;
    const imageTag = await ensureAgentImage(group, agent);

    const hostAgentsDir = env.HOST_AGENTS_DIR ?? agentsDir;
    const agentMountPath = hostAgentsDir.includes('\\') || hostAgentsDir.includes(':')
      ? `${hostAgentsDir}\\${agent.id}`
      : `${hostAgentsDir}/${agent.id}`;

    // 嘗試認養已存在的容器
    let container: Docker.Container | null = null;
    let adopted = false;
    try {
      const existing = await docker.listContainers({
        all: true,
        filters: { name: [`^/${containerId}$`] },
      });
      const found = existing.find((c) => c.Names.some((n) => n === `/${containerId}`));
      if (found) {
        const candidate = docker.getContainer(found.Id);
        if (found.State === 'running') {
          logger.info({ containerId }, 'Adopting existing running container');
          container = candidate;
          adopted = true;
        } else {
          logger.info({ containerId, state: found.State }, 'Removing stale container');
          try { await candidate.remove({ force: true }); } catch (e) {
            logger.warn({ err: e, containerId }, 'Failed to remove stale container');
          }
        }
      }
    } catch (err) {
      logger.warn({ err, containerId }, 'Failed to inspect existing containers');
    }

    if (!container) {
      logger.info({ containerId, image: imageTag, agent: agent.id, group: group.id }, 'Launching container');

      const env_ = {
        ...group.container.env,
        ZEROCLAW_AGENT_ID: agent.id,
        ZEROCLAW_GROUP_ID: group.id,
        ZEROCLAW_RUNTIME_PORT: String(RUNTIME_PORT),
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '',
        OPENAI_API_KEY: env.OPENAI_API_KEY ?? '',
        GITHUB_TOKEN: env.GITHUB_TOKEN ?? '',
        BYOK_MODEL: env.BYOK_MODEL ?? '',
        BYOK_BASE_URL: env.BYOK_BASE_URL ?? '',
        OPENCODE_MODEL_ID: env.OPENCODE_MODEL_ID ?? '',
        OPENCODE_PROVIDER_ID: env.OPENCODE_PROVIDER_ID ?? '',
      };

      const binds = buildBinds(
        agentMountPath,
        agent.sdk,
        env.OPENCODE_AUTH_DIR,
        group.container.volumes,
      );

      try {
        container = await docker.createContainer({
          name: containerId,
          Image: imageTag,
          Env: Object.entries(env_).map(([k, v]) => `${k}=${v}`),
          ExposedPorts: { [`${RUNTIME_PORT}/tcp`]: {} },
          HostConfig: {
            AutoRemove: true,
            NetworkMode: env.DOCKER_NETWORK,
            PortBindings: { [`${RUNTIME_PORT}/tcp`]: [{ HostPort: '0' }] },
            Binds: binds,
            Memory: parseMemory(group.container.resources?.memory ?? env.DEFAULT_CONTAINER_MEMORY),
            NanoCpus: parseCpus(group.container.resources?.cpus ?? env.DEFAULT_CONTAINER_CPUS),
          },
          Labels: {
            'zeroclaw.group': group.id,
            'zeroclaw.agent': agent.id,
            'zeroclaw.sdk': agent.sdk,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already in use|Conflict/i.test(msg)) {
          logger.info({ containerId }, 'Container created concurrently — adopting');
          const fresh = await docker.listContainers({
            all: true,
            filters: { name: [`^/${containerId}$`] },
          });
          const found = fresh.find((c) => c.Names.some((n) => n === `/${containerId}`));
          if (!found) throw err;
          container = docker.getContainer(found.Id);
          adopted = true;
        } else {
          throw err;
        }
      }

      if (!adopted) {
        await container.start();
      }
    }

    const host = containerId;
    const hostPort = RUNTIME_PORT;

    const provider: AgentProvider =
      agent.sdk === 'copilot'
        ? new CopilotAgentProvider({ host, port: hostPort })
        : new OpencodeAgentProvider({ host, port: hostPort });

    const ready = await waitForReady(provider, 120_000);
    if (!ready) {
      logger.error({ containerId }, 'Container did not become ready');
      try { await container.stop({ t: 1 }); } catch { /* ignore */ }
      throw Errors.containerLaunchFailed(`Container ${containerId} did not become ready`);
    }

    const instance: ContainerInstance = {
      containerId,
      groupId: group.id,
      agentId: agent.id,
      imageTag,
      host,
      port: hostPort,
      protocol: agent.sdk === 'copilot' ? 'jsonrpc-tcp' : 'http',
      activeSdkSessions: 0,
      maxSessions: group.container.maxSessions,
      status: 'running',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    return { instance, provider, docker: container, sdkSessions: new Set() };
  }

  const builtImages = new Set<string>();

  /** Recursively hash all files in a directory to produce a content-based cache key (T-5) */
  async function computeContextHash(dir: string): Promise<string> {
    const hash = createHash('sha256');
    const entries: string[] = [];

    async function walk(d: string): Promise<void> {
      const items = await readdir(d, { withFileTypes: true });
      for (const item of items) {
        const full = join(d, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else if (item.isFile()) {
          entries.push(full);
        }
      }
    }
    await walk(dir);
    entries.sort(); // deterministic order
    for (const filePath of entries) {
      const rel = filePath.slice(dir.length); // relative path as part of hash
      hash.update(rel);
      const content = await readFile(filePath);
      hash.update(content);
    }
    return hash.digest('hex').slice(0, 12);
  }

  async function ensureAgentImage(group: GroupConfig, agent: AgentMetadata): Promise<string> {
    if (!agent.hasCustomDockerfile) return group.container.baseImage;

    const contextPath = resolve(agentsDir, agent.id);
    const contentHash = await computeContextHash(contextPath);
    const tag = `zeroclaw/agent-${agent.id}:${contentHash}`;

    if (builtImages.has(tag)) return tag;

    const existing = await docker.listImages({ filters: { reference: [tag] } });
    if (existing.length > 0) { builtImages.add(tag); return tag; }

    logger.info({ tag, agent: agent.id, context: contextPath, contentHash }, 'Building custom agent image (content hash miss)');

    try {
      const stream = await docker.buildImage(
        { context: contextPath, src: ['.'] },
        { t: tag, nocache: false },
      );
      await new Promise<void>((res, rej) => {
        docker.modem.followProgress(stream, (err: Error | null) => err ? rej(err) : res(), (e: { stream?: string; error?: string }) => {
          if (e.error) logger.error({ error: e.error }, 'Docker build error');
          else if (e.stream) { const l = e.stream.trim(); if (l) logger.debug({ buildOutput: l }, 'docker build'); }
        });
      });
      builtImages.add(tag);
      logger.info({ tag }, 'Custom agent image built successfully');
    } catch (err) {
      logger.error({ err, tag, agent: agent.id }, 'Failed to build custom agent image');
      throw Errors.containerLaunchFailed(
        `Failed to build image ${tag} for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return tag;
  }

  function list(): ContainerInstance[] {
    return [...containers.values()].map((e) => ({ ...e.instance }));
  }

  async function stop(containerId: string): Promise<void> {
    for (const [key, entry] of containers.entries()) {
      if (entry.instance.containerId !== containerId) continue;
      entry.instance.status = 'stopping';
      try {
        await entry.provider.dispose();
        await entry.docker.stop({ t: 5 });
      } catch (e) {
        logger.warn({ err: e, containerId }, 'Error stopping container');
      }
      containers.delete(key);
      try { await db.removeContainer(containerId); } catch (e) { logger.warn({ err: e }, 'Failed to remove container from DB'); }
      return;
    }
  }

  function findByContainerId(containerId: string): ContainerEntry | undefined {
    for (const entry of containers.values()) {
      if (entry.instance.containerId === containerId) return entry;
    }
    return undefined;
  }

  function attachSession(containerId: string, sdkSessionId: string): void {
    const e = findByContainerId(containerId);
    if (!e) return;
    e.sdkSessions.add(sdkSessionId);
    e.instance.activeSdkSessions = e.sdkSessions.size;
    e.instance.lastActivityAt = new Date();
  }

  function detachSession(containerId: string, sdkSessionId: string): void {
    const e = findByContainerId(containerId);
    if (!e) return;
    e.sdkSessions.delete(sdkSessionId);
    e.instance.activeSdkSessions = e.sdkSessions.size;
    e.instance.lastActivityAt = new Date();
  }

  function startGc(): void {
    if (gcTimer) return;
    gcTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...containers.values()]) {
        const idle =
          entry.sdkSessions.size === 0 &&
          now - entry.instance.lastActivityAt.getTime() > env.CONTAINER_IDLE_TIMEOUT_SEC * 1000;
        if (idle) {
          logger.info({ containerId: entry.instance.containerId }, 'GC idle container');
          void stop(entry.instance.containerId);
        }
      }
    }, 60_000);
    healthTimer = setInterval(() => void runHealthChecks(), HEALTH_INTERVAL_MS);
  }

  async function runHealthChecks(): Promise<void> {
    for (const entry of [...containers.values()]) {
      if (entry.instance.status !== 'running' && entry.instance.status !== 'unhealthy') continue;
      const cid = entry.instance.containerId;
      try {
        const ok = await entry.provider.isReady();
        if (ok) {
          if (entry.instance.status === 'unhealthy') {
            logger.info({ containerId: cid }, 'Container recovered');
            entry.instance.status = 'running';
          }
          failCounts.delete(cid);
        } else {
          handleHealthFailure(entry);
        }
      } catch {
        handleHealthFailure(entry);
      }
    }
  }

  function handleHealthFailure(entry: ContainerEntry): void {
    const cid = entry.instance.containerId;
    const count = (failCounts.get(cid) ?? 0) + 1;
    failCounts.set(cid, count);
    logger.warn({ containerId: cid, failCount: count, max: MAX_FAIL_COUNT }, 'Container health check failed');
    if (count >= MAX_FAIL_COUNT && entry.instance.status !== 'unhealthy') {
      entry.instance.status = 'unhealthy';
      logger.error({ containerId: cid, group: entry.instance.groupId, agent: entry.instance.agentId }, 'Container marked unhealthy');
      unhealthyHandler?.(cid, entry.instance.groupId, entry.instance.agentId);
    }
  }

  async function restart(
    containerId: string,
    group: GroupConfig,
    agent: AgentMetadata,
  ): Promise<ContainerEntry> {
    logger.info({ containerId, group: group.id, agent: agent.id }, 'Restarting container');
    await stop(containerId).catch(() => {});
    failCounts.delete(containerId);
    return acquire(group, agent);
  }

  async function invalidateInternal(containerId: string): Promise<void> {
    failCounts.delete(containerId);
    for (const [key, entry] of containers.entries()) {
      if (entry.instance.containerId === containerId) {
        containers.delete(key);
        try { await db.removeContainer(containerId); } catch { /* ignore */ }
        return;
      }
    }
  }

  async function adoptFromDb(): Promise<void> {
    const persisted = await db.listPersistedContainers();
    if (persisted.length === 0) return;

    let running: Docker.ContainerInfo[] = [];
    try {
      running = await docker.listContainers({ filters: { label: ['zeroclaw.group'] } });
    } catch (err) {
      logger.warn({ err }, 'Failed to list Docker containers during DB adoption');
      return;
    }
    const runningNames = new Set(running.flatMap((c) => c.Names));

    for (const ci of persisted) {
      const isRunning = runningNames.has(`/${ci.containerId}`);
      if (!isRunning) {
        logger.info({ containerId: ci.containerId }, 'Persisted container not running — removing from DB');
        try { await db.removeContainer(ci.containerId); } catch { /* ignore */ }
        continue;
      }
      const key = keyOf(ci.groupId, ci.agentId);
      if (containers.has(key)) continue; // already in memory

      const dockerC = docker.getContainer(ci.containerId);
      const provider: AgentProvider = ci.protocol === 'jsonrpc-tcp'
        ? new CopilotAgentProvider({ host: ci.host, port: ci.port })
        : new OpencodeAgentProvider({ host: ci.host, port: ci.port });

      const entry: ContainerEntry = {
        instance: { ...ci, activeSdkSessions: 0 },
        provider,
        docker: dockerC,
        sdkSessions: new Set(),
      };
      containers.set(key, entry);
      logger.info({ containerId: ci.containerId, groupId: ci.groupId, agentId: ci.agentId }, 'Adopted container from DB');
    }
  }

  async function rebuildImage(agent: AgentMetadata, group: GroupConfig): Promise<void> {
    // Clear all cached tags for this agent (content hash may vary)
    const prefix = `zeroclaw/agent-${agent.id}:`;
    for (const tag of builtImages) {
      if (tag.startsWith(prefix)) builtImages.delete(tag);
    }
    // Force remove old images matching this agent (ignore errors if in use)
    if (agent.hasCustomDockerfile) {
      try {
        const images = await docker.listImages({ filters: { reference: [`${prefix}*`] } });
        for (const img of images) {
          try { await docker.getImage(img.Id).remove({ force: true }); } catch { /* in use */ }
        }
      } catch (e) {
        logger.warn({ err: e, agent: agent.id }, 'Failed to remove old agent images');
      }
    }
    // Re-build (will compute new content hash)
    await ensureAgentImage(group, agent);
    // Restart all containers using this agent
    const key = keyOf(group.id, agent.id);
    const entry = containers.get(key);
    if (entry) {
      logger.info({ containerId: entry.instance.containerId, agent: agent.id }, 'Restarting container after image rebuild');
      await restart(entry.instance.containerId, group, agent);
    }
  }

  async function dispose(): Promise<void> {
    if (gcTimer) clearInterval(gcTimer);
    if (healthTimer) clearInterval(healthTimer);
    gcTimer = null;
    healthTimer = null;
    const all = list();
    await Promise.allSettled(all.map((c) => stop(c.containerId)));
  }

  return {
    acquire,
    findEntry: findByContainerId,
    list,
    stop,
    attachSession,
    detachSession,
    startGc,
    restart,
    invalidate: invalidateInternal,
    adoptFromDb,
    onUnhealthy(handler) { unhealthyHandler = handler; },
    rebuildImage,
    dispose,
  };
}

async function waitForReady(provider: AgentProvider, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await provider.isReady()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function buildBinds(agentMount: string, sdk: string, opencodeAuthDir: string | undefined, extra?: string[]): string[] {
  const binds = [`${agentMount}:/workspace/agent:ro`];
  if (sdk === 'opencode' && opencodeAuthDir) {
    const base = opencodeAuthDir.replace(/[\\/]$/, '');
    const sep = opencodeAuthDir.includes('\\') ? '\\' : '/';
    binds.push(`${base}${sep}auth.json:/root/.local/share/opencode/auth.json:ro`);
  }
  if (extra) binds.push(...extra);
  return binds;
}

function parseMemory(s: string): number {
  const match = /^(\d+(?:\.\d+)?)([kmg]?)$/i.exec(s.trim());
  if (!match) return 512 * 1024 * 1024;
  const n = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const mult = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.floor(n * mult);
}

function parseCpus(s: string): number {
  const n = parseFloat(s);
  if (isNaN(n)) return 1_000_000_000;
  return Math.floor(n * 1_000_000_000);
}

function sanitizeDockerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export { basename };


