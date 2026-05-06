/**
 * Copilot AgentRuntime — 容器內 JSON-RPC over TCP 服務
 *
 * 一條 TCP 連線（newline-delimited JSON）服務 API Server。
 * Methods：
 *   session.create
 *   session.close
 *   session.switchAgent
 *   session.sendMessage   ← 啟動 agent loop，事件以 agent.event 通知回送
 *   session.abort
 *   session.approval
 *   session.elicit
 *   ping
 *
 * Agent loop 透過 @github/copilot-sdk 啟動 Copilot session，
 * 並把 SDK 事件映射為 AgentEvent（chunk / tool.call / tool.result / approval / done …）。
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopilotClient } from '@github/copilot-sdk';

// Force stdout/stderr to be blocking so docker logs always sees our output
// (PID 1 in container with piped stdout defaults to non-blocking → log loss).
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream._handle?.setBlocking === 'function') {
    stream._handle.setBlocking(true);
  }
}

const PORT = parseInt(process.env.ZEROCLAW_RUNTIME_PORT ?? '7080', 10);
const AGENT_DIR = process.env.ZEROCLAW_AGENT_DIR ?? '/workspace/agent';

// ─── BYOK (Bring Your Own Key) ───────────────────────
const BYOK_PROVIDER = (() => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.BYOK_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.BYOK_MODEL || 'gpt-5-mini';
  console.log(`[copilot-runtime] BYOK enabled: model=${model}, baseUrl=${baseUrl}`);
  return { type: 'openai', baseUrl, apiKey };
})();
const BYOK_MODEL = process.env.BYOK_MODEL || 'gpt-5-mini';

// ─── Per-session state ───────────────────────────────
/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {Set<net.Socket>} */
const clients = new Set();

// ─── TCP Server ──────────────────────────────────────
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  clients.add(socket);
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        void handleRequest(socket, msg);
      } catch {
        // ignore malformed JSON
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(PORT, () => {
  console.log(`[copilot-runtime] listening on ${PORT}, agentDir=${AGENT_DIR}`);
});

// ─── JSON-RPC helpers ────────────────────────────────
function sendReply(socket, id, result) {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(socket, id, message) {
  socket.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n',
  );
}
function notify(socket, method, params) {
  socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// ─── Request handler ─────────────────────────────────
async function handleRequest(socket, msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'ping':
        return sendReply(socket, id, { pong: true });

      case 'session.create':
        return await handleSessionCreate(socket, id, params);

      case 'session.close':
        return await handleSessionClose(socket, id, params);

      case 'session.switchAgent': {
        const s = sessions.get(params.sdkSessionId);
        if (!s) return sendError(socket, id, 'session not found');
        s.subAgent = params.subAgent;
        return sendReply(socket, id, { ok: true });
      }

      case 'session.sendMessage':
        return await handleSendMessage(socket, id, params);

      case 'session.abort': {
        const s = sessions.get(params.sdkSessionId);
        s?.currentAbort?.abort();
        return sendReply(socket, id, { ok: true });
      }

      case 'session.approval': {
        const s = sessions.get(params.sdkSessionId);
        if (!s) return sendError(socket, id, 'session not found');
        const resolver = s.pendingApprovals.get(params.requestId);
        if (resolver) {
          resolver(params.approved ? { kind: 'approve-once' } : { kind: 'denied-interactively-by-user' });
          s.pendingApprovals.delete(params.requestId);
        }
        return sendReply(socket, id, { ok: true });
      }

      case 'session.elicit': {
        const s = sessions.get(params.sdkSessionId);
        if (!s) return sendError(socket, id, 'session not found');
        const resolver = s.pendingElicit.get(params.requestId);
        if (resolver) {
          resolver(params.answer);
          s.pendingElicit.delete(params.requestId);
        }
        return sendReply(socket, id, { ok: true });
      }

      default:
        return sendError(socket, id, `unknown method ${method}`);
    }
  } catch (e) {
    return sendError(socket, id, String(e?.message ?? e));
  }
}

// ─── Load .agents/*.md as customAgents ───────────────
function loadCustomAgents() {
  const agentsDir = path.join(AGENT_DIR, '.agents');
  if (!fs.existsSync(agentsDir)) return [];
  const agents = [];
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const name = path.basename(file, '.md');
    const prompt = fs.readFileSync(path.join(agentsDir, file), 'utf8');
    agents.push({
      name,
      displayName: name,
      description: `Agent: ${name}`,
      prompt,
      tools: null, // all tools available
      infer: true,
    });
  }
  return agents;
}

// ─── Load hooks from hooks/*.js ──────────────────────
async function loadHooks() {
  const hooksDir = path.join(AGENT_DIR, 'hooks');
  if (!fs.existsSync(hooksDir)) return {};
  const hooks = {};
  for (const file of fs.readdirSync(hooksDir)) {
    if (!file.endsWith('.js')) continue;
    try {
      const mod = await import(path.join(hooksDir, file));
      for (const [key, fn] of Object.entries(mod.default ?? mod)) {
        if (typeof fn === 'function') hooks[key] = fn;
      }
    } catch (err) {
      console.warn(`[copilot-runtime] failed to load hook ${file}:`, err.message);
    }
  }
  return hooks;
}

// ─── Session create ──────────────────────────────────
async function handleSessionCreate(socket, id, params) {
  const sdkSessionId = randomUUID();
  try {
    // Validate token format
    const token = process.env.GITHUB_TOKEN;
    if (token && token.startsWith('ghp_')) {
      console.warn('[copilot-runtime] WARNING: ghp_ classic PATs are NOT supported by Copilot SDK.');
      console.warn('[copilot-runtime] Use gho_ (OAuth), github_pat_ (fine-grained PAT), or BYOK mode instead.');
    }
    if (!token && !BYOK_PROVIDER) {
      console.warn('[copilot-runtime] WARNING: No GITHUB_TOKEN and no BYOK provider configured.');
    }

    const client = new CopilotClient({
      useStdio: true,
      gitHubToken: token || undefined,
    });
    await client.start();

    const customAgents = loadCustomAgents();
    const hooks = await loadHooks();
    const pendingApprovals = new Map();

    // Forward permission requests to the api-server
    const onPermissionRequest = (request) => {
      return new Promise((resolve) => {
        const requestId = randomUUID();
        pendingApprovals.set(requestId, resolve);
        notify(socket, 'agent.event', {
          sdkSessionId,
          event: {
            type: 'approval.required',
            requestId,
            tool: request.kind,
            args: { toolCallId: request.toolCallId },
            description: `Permission required: ${request.kind}`,
          },
        });
      });
    };

    const sessionOpts = {
      streaming: true,
      onPermissionRequest,
      workingDirectory: AGENT_DIR,
    };
    // BYOK: inject provider + model when OPENAI_API_KEY is set
    if (BYOK_PROVIDER) {
      sessionOpts.provider = BYOK_PROVIDER;
      sessionOpts.model = BYOK_MODEL;
    }
    if (customAgents.length > 0) sessionOpts.customAgents = customAgents;
    if (Object.keys(hooks).length > 0) sessionOpts.hooks = hooks;
    if (params.subAgent) sessionOpts.agent = params.subAgent;

    const sdkSession = await client.createSession(sessionOpts);

    const state = {
      sdkSessionId,
      userId: params.userId,
      agentId: params.agentId,
      subAgent: params.subAgent,
      socket,
      client,
      sdkSession,
      pendingApprovals,
      pendingElicit: new Map(),
      lastUsage: undefined,
      currentAbort: undefined,
      unsubscribers: [],
    };
    sessions.set(sdkSessionId, state);
    subscribeToEvents(state);
    sendReply(socket, id, { sdkSessionId });
  } catch (err) {
    console.error('[copilot-runtime] session.create failed:', err);
    sendError(socket, id, `Failed to create Copilot session: ${err.message}`);
  }
}

// ─── Event subscription & mapping ────────────────────
function subscribeToEvents(state) {
  const { sdkSession, socket, sdkSessionId } = state;
  const emit = (event) =>
    notify(socket, 'agent.event', { sdkSessionId, event });

  const sub = (type, handler) => {
    state.unsubscribers.push(sdkSession.on(type, handler));
  };

  sub('assistant.turn_start', () => emit({ type: 'turn.start' }));

  sub('assistant.message_delta', (ev) => {
    const delta = ev.data.deltaContent;
    state.lastText = (state.lastText ?? '') + (delta ?? '');
    emit({ type: 'chunk', delta });
  });

  sub('tool.execution_start', (ev) =>
    emit({
      type: 'tool.call',
      tool: ev.data.toolName,
      args: ev.data.arguments ?? {},
      callId: ev.data.toolCallId,
      status: 'running',
    }));

  sub('tool.execution_complete', (ev) => {
    const d = ev.data;
    emit({
      type: 'tool.result',
      tool: d.toolCallId,
      callId: d.toolCallId,
      result: d.result?.content ?? d.error?.message ?? '',
      status: d.success ? 'completed' : 'error',
    });
  });

  sub('subagent.started', (ev) =>
    emit({ type: 'subagent.started', agentName: ev.data?.agentName ?? 'unknown' }));

  sub('subagent.completed', (ev) =>
    emit({
      type: 'subagent.completed',
      agentName: ev.data?.agentName ?? 'unknown',
      summary: ev.data?.agentDisplayName ?? '',
    }));

  sub('assistant.usage', (ev) => {
    state.lastUsage = {
      model: ev.data.model ?? 'unknown',
      inputTokens: ev.data.inputTokens ?? 0,
      outputTokens: ev.data.outputTokens ?? 0,
      reasoningTokens: ev.data.reasoningTokens ?? 0,
    };
  });

  // Reasoning / extended thinking events
  sub('assistant.reasoning_delta', (ev) => {
    // First delta in a reasoning block → signal step start
    if (!state._reasoningActive) {
      state._reasoningActive = true;
      emit({ type: 'step.start' });
    }
  });

  sub('assistant.reasoning', (ev) => {
    // Complete reasoning block — emit step.finish
    state._reasoningActive = false;
    emit({ type: 'step.finish' });
  });

  sub('assistant.turn_end', () => emit({ type: 'turn.end' }));

  sub('session.idle', () => {
    emit({
      type: 'done',
      messageId: randomUUID(),
      usage: state.lastUsage ?? { model: 'unknown', inputTokens: 0, outputTokens: 0 },
    });
    if (state.lastText) {
      const preview = state.lastText.length > 500
        ? state.lastText.slice(0, 500) + `… (+${state.lastText.length - 500} chars)`
        : state.lastText;
      console.log(
        `[copilot-runtime] reply (${state.lastText.length} chars, ${state.lastUsage?.outputTokens ?? '?'} tokens) sid=${sdkSessionId}:`,
        JSON.stringify(preview),
      );
    }
    state.lastText = '';
    state.lastUsage = undefined;
    state.currentAbort = undefined;
  });

  sub('session.error', (ev) => {
    console.error(`[copilot-runtime] session.error: [${ev.data.errorType ?? 'UNKNOWN'}] ${ev.data.message ?? 'Unknown error'}`);
    emit({
      type: 'error',
      code: ev.data.errorType ?? 'UNKNOWN',
      message: ev.data.message ?? 'Unknown error',
      recoverable: true,
    });
  });
}

// ─── Send message ────────────────────────────────────
async function handleSendMessage(socket, id, params) {
  const s = sessions.get(params.sdkSessionId);
  if (!s) return sendError(socket, id, 'session not found');

  // Acknowledge immediately — events stream via agent.event notifications
  sendReply(socket, id, { ok: true });

  try {
    const ac = new AbortController();
    s.currentAbort = ac;
    s.lastText = '';
    s._reasoningActive = false;
    const promptPreview = String(params.text ?? '').slice(0, 200);
    console.log(
      `[copilot-runtime] sending prompt sid=${s.sdkSessionId} (${String(params.text ?? '').length} chars):`,
      JSON.stringify(promptPreview),
    );
    await s.sdkSession.send({
      prompt: params.text,
      attachments: params.attachments ?? [],
    });
  } catch (err) {
    console.error('[copilot-runtime] sendMessage error:', err);
    notify(socket, 'agent.event', {
      sdkSessionId: s.sdkSessionId,
      event: {
        type: 'error',
        code: 'SEND_FAILED',
        message: err.message,
        recoverable: false,
      },
    });
  }
}

// ─── Session close ───────────────────────────────────
async function handleSessionClose(socket, id, params) {
  const s = sessions.get(params.sdkSessionId);
  if (s) {
    for (const unsub of s.unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    try { await s.sdkSession.disconnect(); } catch { /* ignore */ }
    try { await s.client.stop(); } catch { /* ignore */ }
    sessions.delete(params.sdkSessionId);
  }
  sendReply(socket, id, { ok: true });
}
