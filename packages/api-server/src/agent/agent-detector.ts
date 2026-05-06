/**
 * Agent 資料夾偵測器
 *
 * 規則：
 *  1. 存在 opencode.json → SDK = opencode
 *  2. 存在 AGENTS.md     → SDK = copilot
 *  3. 兩者皆無           → 拋錯
 *  4. 兩者皆有           → 以 opencode.json 為準（Opencode 慣例已包含 AGENTS.md）
 *
 * 同時讀取：
 *  - 子代理：.opencode/agents/<n>.md  或  .agents/<n>.md
 *  - 自訂 Dockerfile：./Dockerfile
 *  - 平台 metadata：./.zeroclaw.json （顯示用）
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import matter from 'gray-matter';
import { Errors } from '@zeroclaw/shared';
import type { AgentMetadata, SdkType, SubAgentInfo, AgentMode } from '@zeroclaw/shared';

interface ZeroclawMeta {
  displayName?: string;
  description?: string;
  avatar?: string;
}

export async function detectAgent(agentDir: string): Promise<AgentMetadata> {
  const id = basename(agentDir);
  const sdk = detectSdk(agentDir);
  if (!sdk) {
    throw Errors.agentNotFound(
      `${id} (no opencode.json or AGENTS.md found in ${agentDir})`,
    );
  }

  const meta = await readZeroclawMeta(agentDir);
  const subAgents = await readSubAgents(agentDir, sdk);
  const primaryAgent =
    subAgents.find((a) => a.isDefault)?.name ??
    subAgents.find((a) => a.mode === 'primary')?.name;

  return {
    id,
    sdk,
    displayName: meta.displayName ?? id,
    description: meta.description,
    avatar: meta.avatar,
    subAgents,
    primaryAgent,
    hasCustomDockerfile: existsSync(join(agentDir, 'Dockerfile')),
  };
}

function detectSdk(agentDir: string): SdkType | null {
  if (existsSync(join(agentDir, 'opencode.json'))) return 'opencode';
  if (existsSync(join(agentDir, 'AGENTS.md'))) return 'copilot';
  return null;
}

async function readZeroclawMeta(agentDir: string): Promise<ZeroclawMeta> {
  const file = join(agentDir, '.zeroclaw.json');
  if (!existsSync(file)) return {};
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as ZeroclawMeta;
  } catch {
    return {};
  }
}

async function readSubAgents(agentDir: string, sdk: SdkType): Promise<SubAgentInfo[]> {
  // Opencode 慣例：.opencode/agents/<name>.md
  // Copilot 平台慣例：.agents/<name>.md
  const candidates = [
    join(agentDir, '.opencode', 'agents'),
    join(agentDir, '.agents'),
  ];

  const results: SubAgentInfo[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace(/\.md$/, '');
      try {
        const raw = await readFile(join(dir, file), 'utf8');
        const { data } = matter(raw);
        const mode: AgentMode = data['mode'] === 'subagent' ? 'subagent' : 'primary';
        results.push({
          name,
          displayName: typeof data['displayName'] === 'string' ? data['displayName'] : name,
          description: typeof data['description'] === 'string' ? data['description'] : '',
          mode,
          isDefault: data['default'] === true,
        });
      } catch {
        // 解析失敗則略過
      }
    }
  }
  return results;
}

/**
 * 掃描 agents 目錄底下所有 agent 資料夾
 */
export async function scanAgentsDir(agentsDir: string): Promise<AgentMetadata[]> {
  if (!existsSync(agentsDir)) return [];
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const result: AgentMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    try {
      result.push(await detectAgent(join(agentsDir, entry.name)));
    } catch {
      // 偵測失敗的代理人略過（log 由呼叫端負責）
    }
  }
  return result;
}
