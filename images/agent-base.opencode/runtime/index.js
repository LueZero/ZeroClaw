/**
 * Opencode AgentRuntime — 容器內 HTTP + SSE 服務
 *
 * 對外（API Server 端）的端點：
 *   POST /sessions
 *   DELETE /sessions/:id
 *   POST /sessions/:id/messages   ← SSE
 *   POST /sessions/:id/abort
 *   POST /sessions/:id/agent
 *   POST /sessions/:id/approval
 *   POST /sessions/:id/elicitation
 *   GET  /healthz
 *
 * Agent loop：使用 @opencode-ai/sdk 對接容器內的 opencode server，
 * 訂閱 SDK 事件流 (SSE) 並映射為 zeroclaw AgentEvent。
 *
 * 架構：
 *   API Server ─HTTP:7080─→ 本 runtime ─SDK─→ opencode server (localhost:54321)
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createOpencodeClient } from '@opencode-ai/sdk';

/**
 * @opencode-ai/sdk v1.14.x notes:
 * - createOpencodeClient({ baseUrl }) — pure HTTP client (no spawn)
 * - All resource methods take heyapi-style options: { path, body, query }
 * - Default responseStyle is 'fields' → returns { data, error, request, response }
 * - To pick an opencode.json `agent.{name}` block: pass body.agent = name
 * - To pick a model: pass body.model = { providerID, modelID } (omit to use agent's)
 */

// Force stdout/stderr to be line-buffered (blocking) when running as PID 1 in a
// container where docker captures pipes — otherwise console.log calls after the
// initial ones can sit in libuv's pipe buffer and never reach `docker logs`.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream._handle?.setBlocking === 'function') {
    stream._handle.setBlocking(true);
  }
}

// Catch uncaught errors to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[opencode-runtime] FATAL uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[opencode-runtime] FATAL unhandledRejection:', reason);
  process.exit(1);
});

const PORT = parseInt(process.env.ZEROCLAW_RUNTIME_PORT ?? '7080', 10);
const AGENT_DIR = process.env.ZEROCLAW_AGENT_DIR ?? '/workspace/agent';
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? 'http://localhost:54321';

/**
 * @typedef {{
 *   sdkSessionId: string,
 *   opencodeSid: string,
 *   userId: string,
 *   agentId: string,
 *   subAgent?: string,
 *   client: Opencode,
 *   currentAbort?: AbortController,
 *   eventStream?: any,
 *   pendingPermissions: Set<string>,
 *   pendingElicit: Map<string, (answer: string) => void>,
 *   lastMessageId?: string,
 *   lastText: string,
 *   lastUsage?: object,
 * }} SessionState
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map();

// ─── Wait for opencode server to be ready ────────────
async function waitForOpencode(maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${OPENCODE_BASE_URL}/app`);
      if (res.ok) {
        console.log('[opencode-runtime] opencode server is ready');
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('[opencode-runtime] opencode server not ready after 30s, continuing anyway');
}

// ─── HTTP Server ─────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathName = url.pathname;
    const method = req.method ?? 'GET';

    if (pathName === '/healthz') return json(res, 200, { status: 'ok', agentDir: AGENT_DIR });

    if (pathName === '/sessions' && method === 'POST') {
      const body = await readJson(req);
      return await handleSessionCreate(res, body);
    }

    const m = pathName.match(/^\/sessions\/([^/]+)(?:\/(\w+))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const session = sessions.get(id);
      if (!session) return json(res, 404, { error: 'session not found' });

      if (!action && method === 'DELETE') {
        return await handleSessionClose(res, session);
      }
      if (action === 'messages' && method === 'POST') {
        const body = await readJson(req);
        return await runMessageStream(res, session, body);
      }
      if (action === 'abort' && method === 'POST') {
        await handleAbort(session);
        return json(res, 200, { ok: true });
      }
      if (action === 'agent' && method === 'POST') {
        const body = await readJson(req);
        session.subAgent = body.subAgent;
        return json(res, 200, { ok: true });
      }
      if (action === 'approval' && method === 'POST') {
        const body = await readJson(req);
        return await handleApproval(res, session, body);
      }
      if (action === 'elicitation' && method === 'POST') {
        const body = await readJson(req);
        session.pendingElicit.get(body.requestId)?.(body.answer);
        session.pendingElicit.delete(body.requestId);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[opencode-runtime] error:', e);
    return json(res, 500, { error: String(e?.message ?? e) });
  }
});

// ─── Start ───────────────────────────────────────────
await waitForOpencode();

// Dump opencode merged config at startup for debugging — confirms whether
// opencode.json (project-level) is being picked up by the server.
try {
  const bootClient = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
  const cfgRes = await bootClient.config.get();
  if (cfgRes.error) {
    console.warn('[opencode-runtime] boot config.get error:', JSON.stringify(cfgRes.error)?.slice(0, 400));
  } else {
    const cfg = cfgRes.data;
    console.log('┌─── Boot Diagnostics ───────────────────────────────────────');
    console.log('│ Model:    %s', cfg?.model ?? '(not set)');
    console.log('│ Agents:   %s', Object.keys(cfg?.agent ?? {}).join(', ') || '(none)');
    console.log('│ MCP:      %s', Object.keys(cfg?.mcp ?? {}).join(', ') || '(none)');
    console.log('│ Permission: %s', JSON.stringify(cfg?.permission ?? {}));
  }

  // Project / CWD
  try {
    const proj = await bootClient.project.current();
    const projData = proj?.data ?? proj;
    console.log('│ Project:  %s', projData?.path ?? projData?.root ?? JSON.stringify(projData)?.slice(0, 120));
  } catch (e) {
    console.log('│ Project:  (unavailable) %s', e?.message ?? e);
  }

  // Path
  try {
    const pathInfo = await bootClient.path.get();
    const pathData = pathInfo?.data ?? pathInfo;
    console.log('│ Paths:    cwd=%s  config=%s',
      pathData?.cwd ?? '?',
      pathData?.config ?? '?');
  } catch (e) {
    console.log('│ Paths:    (unavailable) %s', e?.message ?? e);
  }

  // Providers — summarize, redact keys
  try {
    const providers = await bootClient.config.providers();
    const pData = providers?.data ?? providers;
    const provList = Array.isArray(pData) ? pData : Object.values(pData ?? {});
    for (const p of provList) {
      const name = p?.name ?? p?.id ?? '?';
      const models = (p?.models ?? []).map(m => m?.name ?? m?.id ?? '?').join(', ');
      console.log('│ Provider: %s  models=[%s]', name, models.slice(0, 100) || '(none)');
    }
  } catch (e) {
    console.log('│ Providers: (unavailable) %s', e?.message ?? e);
  }

  // Agents
  try {
    const agents = await bootClient.app.agents();
    const aData = agents?.data ?? agents;
    const agentList = Array.isArray(aData) ? aData : Object.values(aData ?? {});
    for (const a of agentList) {
      const name = a?.name ?? a?.id ?? '?';
      const mode = a?.mode ?? '?';
      const isDefault = a?.default ? ' (default)' : '';
      console.log('│ Agent:    %s  mode=%s%s', name, mode, isDefault);
    }
  } catch (e) {
    console.log('│ Agents:   (unavailable) %s', e?.message ?? e);
  }

  console.log('└────────────────────────────────────────────────────────────');
} catch (err) {
  console.error('[opencode-runtime] boot config dump failed:', err?.message ?? err);
}

server.listen(PORT, () => {
  console.log(`[opencode-runtime] listening on ${PORT}, agentDir=${AGENT_DIR}, opencode=${OPENCODE_BASE_URL}`);
});

// ─── Graceful shutdown ───────────────────────────────
// When container receives SIGTERM (docker stop), clean up all sessions and
// close the HTTP server gracefully — equivalent to opencode.server.close()
// for the createOpencode() flow, but adapted for our client-only architecture.
async function gracefulShutdown(signal) {
  console.log(`[opencode-runtime] ${signal} received — shutting down gracefully`);

  // 1. Stop accepting new HTTP connections
  server.close();

  // 2. Clean up all active sessions
  const cleanupPromises = [];
  for (const [id, session] of sessions) {
    cleanupPromises.push(
      (async () => {
        try {
          // Abort any in-flight prompt
          session.currentAbort?.abort();
          // Close event stream
          closeStream(session.eventStream);
          // Delete opencode session
          await session.client.session.delete({ path: { id: session.opencodeSid } });
          console.log(`[opencode-runtime] cleaned up session ${id} (opencode=${session.opencodeSid})`);
        } catch (err) {
          console.warn(`[opencode-runtime] cleanup error for session ${id}:`, err?.message ?? err);
        }
      })()
    );
  }

  // Give sessions 5s max to clean up
  await Promise.race([
    Promise.allSettled(cleanupPromises),
    new Promise((r) => setTimeout(r, 5000)),
  ]);

  sessions.clear();
  console.log(`[opencode-runtime] shutdown complete (${cleanupPromises.length} sessions cleaned)`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Session create ──────────────────────────────────
async function handleSessionCreate(res, body) {
  const sdkSessionId = randomUUID();
  try {
    const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });

    // Create an opencode session — SDK error handling per
    // https://opencode.ai/docs/sdk#錯誤處理
    let createRes;
    try {
      createRes = await client.session.create({
        body: { title: `zeroclaw-${body.agentId ?? 'agent'}` },
      });
    } catch (err) {
      // SDK throws on network/HTTP errors when throwOnError is true (default false),
      // but also on actual fetch failures (DNS, connection refused, etc.)
      console.error('[opencode-runtime] session.create threw:', err?.message ?? err, 'status:', err?.status);
      return json(res, 502, {
        error: `opencode server unreachable: ${err?.message ?? err}`,
        code: 'OPENCODE_UNREACHABLE',
      });
    }

    if (createRes.error) {
      const errData = createRes.error;
      const msg = errData?.data?.message ?? errData?.name ?? 'session.create failed';
      console.error('[opencode-runtime] session.create returned error:', JSON.stringify(errData)?.slice(0, 400));
      return json(res, 502, { error: msg, code: errData?.name ?? 'SESSION_CREATE_FAILED' });
    }
    const ocSession = createRes.data;

    const state = {
      sdkSessionId,
      opencodeSid: ocSession.id,
      userId: body.userId,
      agentId: body.agentId,
      subAgent: body.subAgent,
      client,
      pendingPermissions: new Set(),
      pendingElicit: new Map(),
      lastText: '',
    };
    sessions.set(sdkSessionId, state);
    return json(res, 200, { sdkSessionId });
  } catch (err) {
    console.error('[opencode-runtime] session.create failed:', err);
    return json(res, 500, { error: `Failed to create opencode session: ${err.message}` });
  }
}

/**
 * 解析 model 字串 "provider/model" → { providerID, modelID }
 */
function splitModel(full) {
  if (!full || typeof full !== 'string') return null;
  const idx = full.indexOf('/');
  if (idx <= 0) return null;
  return { providerID: full.slice(0, idx), modelID: full.slice(idx + 1) };
}

/**
 * 解析要傳給 session.prompt 的參數
 *
 * 核心原則（per https://opencode.ai/docs/sdk）：
 *   opencode server 已從 opencode.json 載入 model 和 agent 設定。
 *   session.prompt 的 body.model 是**可選的** — 不傳時 server 自動
 *   從 opencode.json 的 model / agent.{name}.model 解析。
 *
 *   所以：
 *     1. 只傳 body.agent（讓 server 知道用哪個 agent block）
 *     2. 不傳 body.model（讓 server 用 opencode.json 的設定）
 *     3. 唯一例外：env OPENCODE_MODEL_ID 明確設定時才覆蓋
 */
function resolveChatParams(session) {
  const subAgent = session.subAgent;

  // env 明確覆蓋（容器層級的 model override，優先於 opencode.json）
  const envModelRaw = process.env.OPENCODE_MODEL_ID;
  if (envModelRaw) {
    const envProviderID = process.env.OPENCODE_PROVIDER_ID;
    const split = splitModel(envModelRaw);
    if (split) return { agent: subAgent, model: split };
    if (envProviderID) return { agent: subAgent, model: { providerID: envProviderID, modelID: envModelRaw } };
  }

  // 不傳 model — 讓 opencode server 從 opencode.json 自行解析
  // server 會按 agent.{name}.model → 頂層 model → provider default 的順序解析
  return { agent: subAgent };
}

// ─── Message stream ──────────────────────────────────
async function runMessageStream(res, session, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const ac = new AbortController();
  session.currentAbort = ac;
  session.lastText = '';
  session.lastUsage = undefined;

  const send = (ev) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  send({ type: 'turn.start' });

  // Subscribe BEFORE sending prompt so we don't miss early events.
  // event.subscribe() returns { stream } — async iterable of SSE events.
  let eventStream;
  try {
    eventStream = await session.client.event.subscribe();
    session.eventStream = eventStream;
  } catch (err) {
    console.error('[opencode-runtime] event.subscribe failed:', err);
    send({ type: 'error', code: 'EVENT_SUBSCRIBE_FAILED', message: err?.message ?? String(err), recoverable: false });
    send({ type: 'turn.end' });
    if (!res.destroyed) res.end();
    return;
  }

  try {
    const { agent, model } = resolveChatParams(session);

    console.log('[opencode-runtime] sending prompt:', {
      sessionId: session.opencodeSid,
      agent,
      model,
      text: body.text?.substring(0, 100),
    });

    // session.prompt — heyapi style: { path, body }
    // Returns { data: { info, parts }, error, ... } in 'fields' style.
    let chatDone = false;
    let chatError = null;
    let chatResult = null;
    const chatPromise = session.client.session.prompt({
      path: { id: session.opencodeSid },
      body: {
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        parts: [{ type: 'text', text: body.text }],
      },
    }).then((result) => {
      chatDone = true;
      if (result.error) {
        chatError = result.error;
        console.error('[opencode-runtime] prompt returned error:', JSON.stringify(result.error)?.slice(0, 400));
        return result;
      }
      chatResult = result.data;
      const msg = chatResult?.info;
      if (msg?.error) {
        chatError = msg.error;
        console.error('[opencode-runtime] assistant message has error:', JSON.stringify(msg.error)?.slice(0, 400));
      } else {
        console.log('[opencode-runtime] prompt completed:', msg?.id, 'parts:', chatResult?.parts?.length ?? 0);
      }
      const tokens = msg?.tokens;
      if (tokens) {
        session.lastUsage = {
          model: msg?.modelID ?? 'unknown',
          inputTokens: (tokens.input ?? 0) + (tokens.cache?.read ?? 0),
          outputTokens: tokens.output ?? 0,
          reasoningTokens: tokens.reasoning ?? 0,
        };
      }
      return result;
    }).catch((err) => {
      chatDone = true;
      chatError = err;
      console.error('[opencode-runtime] prompt promise rejected:',
        err?.message ?? err,
        'status:', err?.status,
        'body:', JSON.stringify(err?.error ?? err?.body)?.substring(0, 300));
    });

    // Track which messageIDs are user messages (to exclude their text parts from streaming)
    const userMessageIds = new Set();
    // Track text parts to compute deltas
    const textParts = new Map(); // partId → last known text
    // Flag: session.idle received → break after processing
    let sessionIdle = false;

    // Process events from the opencode SSE stream
    // Use session.idle as the primary signal to stop (per SDK contract).
    // After prompt() settles, continue draining events for up to 3s to catch
    // any remaining message.part.updated events that arrive after it completes.
    let chatDoneAt = 0;
    const DRAIN_MS = 3000;

    for await (const event of eventStream.stream) {
      if (ac.signal.aborted) break;

      processEvent(event);

      // session.idle is the authoritative "done" signal from opencode
      if (sessionIdle) break;

      // Track when chat settled, but keep draining events briefly
      if (chatDone && !chatDoneAt) {
        chatDoneAt = Date.now();
      }
      if (chatDoneAt && Date.now() - chatDoneAt > DRAIN_MS) {
        console.log('[opencode-runtime] drain timeout after chat settled, breaking');
        break;
      }
    }

    function processEvent(event) {
      if (event.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (!part || part.sessionID !== session.opencodeSid) return;
        // Skip parts belonging to user messages
        if (userMessageIds.has(part.messageID)) return;

        if (part.type === 'text') {
          const partId = part.id;
          const prevText = textParts.get(partId) ?? '';
          const newText = part.text ?? '';
          if (newText.length > prevText.length) {
            const delta = newText.slice(prevText.length);
            send({ type: 'chunk', delta });
            session.lastText += delta;
          }
          textParts.set(partId, newText);
        } else if (part.type === 'tool') {
          const toolState = part.state;
          if (toolState?.status === 'running' || toolState?.status === 'pending') {
            send({
              type: 'tool.call',
              tool: part.tool ?? 'unknown',
              args: toolState?.input ?? {},
              callId: part.callID ?? part.id,
              status: 'running',
            });
          } else if (toolState?.status === 'completed' || toolState?.status === 'error') {
            send({
              type: 'tool.result',
              tool: part.tool ?? 'unknown',
              callId: part.callID ?? part.id,
              result: toolState?.output ?? toolState?.error ?? '',
              status: toolState.status,
            });
          }
        } else if (part.type === 'step-start') {
          send({ type: 'step.start' });
          console.log('[opencode-runtime] step-start (LLM reasoning step began)');
        } else if (part.type === 'step-finish') {
          const t = part.tokens;
          const stepUsage = t ? {
            reasoningTokens: t.reasoning ?? 0,
            inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0),
            outputTokens: t.output ?? 0,
            cost: part.cost ?? 0,
          } : undefined;
          send({ type: 'step.finish', usage: stepUsage });
          // Accumulate reasoning tokens into session usage
          if (stepUsage && stepUsage.reasoningTokens > 0) {
            session.lastReasoningTokens = (session.lastReasoningTokens ?? 0) + stepUsage.reasoningTokens;
          }
          console.log('[opencode-runtime] step-finish reasoning=%d input=%d output=%d cost=%s',
            stepUsage?.reasoningTokens ?? 0, stepUsage?.inputTokens ?? 0,
            stepUsage?.outputTokens ?? 0, stepUsage?.cost ?? 0);
        }
      } else if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (!info || info.sessionID !== session.opencodeSid) return;
        // Track user messages so we can skip their text parts
        if (info.role === 'user') {
          userMessageIds.add(info.id);
        }
        if (info.role === 'assistant' && info.tokens) {
          session.lastUsage = {
            model: info.modelID ?? 'unknown',
            inputTokens: (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0),
            outputTokens: info.tokens.output ?? 0,
            reasoningTokens: info.tokens.reasoning ?? 0,
          };
        }
        // Check for error in the assistant message
        // SDK types: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
        if (info.role === 'assistant' && info.error) {
          const errObj = info.error;
          const errMsg = errObj?.data?.message ?? errObj?.name ?? 'Unknown error';
          console.error('[opencode-runtime] assistant error:', errObj?.name, errMsg);
          send({
            type: 'error',
            code: errObj?.name ?? 'OPENCODE_ERROR',
            message: errMsg,
            recoverable: errObj?.name === 'ProviderAuthError',
          });
        }
      } else if (event.type === 'permission.updated') {
        const props = event.properties;
        if (props.sessionID !== session.opencodeSid) return;
        // props.id IS the permissionID — forward as-is so API Server can echo it back.
        // (Per SDK: POST /session/:id/permissions/:permissionID expects this id in path.)
        const permissionID = props.id;
        if (!permissionID) {
          console.warn('[opencode-runtime] permission.updated missing id, skipping', props);
          return;
        }
        session.pendingPermissions.add(permissionID);
        send({
          type: 'approval.required',
          requestId: permissionID,
          tool: props.title ?? 'unknown',
          args: props.metadata ?? {},
          description: props.title ?? 'Permission required',
        });
      } else if (event.type === 'session.error') {
        // SDK: properties.error is ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
        const props = event.properties;
        if (props.sessionID && props.sessionID !== session.opencodeSid) return;
        const errObj = props.error;
        const errMsg = errObj?.data?.message ?? errObj?.name ?? 'Unknown error';
        const errCode = errObj?.name ?? 'OPENCODE_ERROR';
        console.error('[opencode-runtime] session.error:', errCode, errMsg);
        send({
          type: 'error',
          code: errCode,
          message: errMsg,
          recoverable: true,
        });
      } else if (event.type === 'session.idle') {
        const props = event.properties;
        if (props.sessionID !== session.opencodeSid) return;
        console.log('[opencode-runtime] session.idle received — ending event loop');
        sessionIdle = true;
      }
      // Ignore: session.updated, session.deleted, installation.updated, storage.write, etc.
    }

    // Ensure prompt promise settles
    await chatPromise;

    // Fallback: if SSE events didn't capture the text, extract from prompt result's parts
    if (!session.lastText && chatResult) {
      const parts = chatResult.parts ?? [];
      for (const p of parts) {
        if (p.type === 'text' && p.text) {
          const delta = p.text;
          send({ type: 'chunk', delta });
          session.lastText += delta;
        }
      }
      if (session.lastText) {
        console.log('[opencode-runtime] extracted text from prompt result parts:', session.lastText.length, 'chars');
      }
    }

    if (chatError && !session.lastText) {
      // chatError can be: SDK OpencodeError (HTTP error) or an error object from result.error
      // SDK OpencodeError has .message, .status; result.error has .name and .data.message
      const errMsg = chatError?.data?.message
        ?? chatError?.message
        ?? chatError?.name
        ?? String(chatError);
      const errCode = chatError?.name ?? (chatError?.status ? `HTTP_${chatError.status}` : 'CHAT_ERROR');
      send({
        type: 'error',
        code: errCode,
        message: errMsg,
        recoverable: false,
      });
    }

    send({ type: 'turn.end' });
    send({
      type: 'done',
      messageId: randomUUID(),
      usage: session.lastUsage ?? {
        model: session.lastUsage?.model ?? 'unknown',
        inputTokens: body.text.length,
        outputTokens: session.lastText.length,
      },
    });

    // Log final assistant reply text (truncated) so docker logs shows the LLM output
    if (session.lastText) {
      const preview = session.lastText.length > 500
        ? session.lastText.slice(0, 500) + `… (+${session.lastText.length - 500} chars)`
        : session.lastText;
      console.log(
        `[opencode-runtime] reply (${session.lastText.length} chars, ${session.lastUsage?.outputTokens ?? '?'} tokens) sid=${session.opencodeSid}:`,
        JSON.stringify(preview),
      );
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error('[opencode-runtime] message stream error:', err);
      send({
        type: 'error',
        code: 'STREAM_ERROR',
        message: err.message,
        recoverable: false,
      });
    }
  } finally {
    closeStream(session.eventStream);
    if (!res.destroyed) res.end();
    session.currentAbort = undefined;
    session.eventStream = undefined;
  }
}

// ─── Abort ───────────────────────────────────────────
async function handleAbort(session) {
  session.currentAbort?.abort();
  try {
    await session.client.session.abort({ path: { id: session.opencodeSid } });
  } catch {
    // best effort
  }
  closeStream(session.eventStream);
}

// ─── Approval (forward to opencode server) ───────────
// Per @opencode-ai/sdk: client.postSessionIdPermissionsPermissionId({
//   path: { id, permissionID }, body: { response: 'once' | 'always' | 'reject' }
// })
// API endpoint: POST /session/:id/permissions/:permissionID
async function handleApproval(res, session, body) {
  const permissionID = body?.requestId;
  if (!permissionID || typeof permissionID !== 'string') {
    return json(res, 400, { error: 'requestId required' });
  }
  if (!session.pendingPermissions.has(permissionID)) {
    console.warn(
      '[opencode-runtime] approval for unknown permissionID:',
      permissionID,
      'known:',
      [...session.pendingPermissions],
    );
    // still try forwarding — opencode may know about it even if we missed the event
  }

  // Map our boolean (+ optional remember) to opencode's tri-state response.
  // - approved=true,  remember=false → 'once'
  // - approved=true,  remember=true  → 'always'
  // - approved=false                 → 'reject'
  const response = body.approved
    ? (body.remember ? 'always' : 'once')
    : 'reject';

  try {
    const result = await session.client.postSessionIdPermissionsPermissionId({
      path: { id: session.opencodeSid, permissionID },
      body: { response },
    });
    if (result.error) {
      const msg = result.error?.data?.message ?? result.error?.name ?? 'permission update failed';
      console.error(
        '[opencode-runtime] permission response rejected by server:',
        permissionID,
        '→',
        response,
        msg,
      );
      return json(res, 502, { error: msg, code: 'PERMISSION_FORWARD_FAILED' });
    }
    session.pendingPermissions.delete(permissionID);
    console.log('[opencode-runtime] permission', permissionID, '→', response);
    return json(res, 200, { ok: true });
  } catch (err) {
    console.error(
      '[opencode-runtime] postSessionIdPermissionsPermissionId threw:',
      err?.message ?? err,
      'status:',
      err?.status,
    );
    return json(res, 502, {
      error: `failed to forward permission to opencode: ${err?.message ?? err}`,
      code: 'PERMISSION_FORWARD_FAILED',
    });
  }
}

// ─── Session close ───────────────────────────────────
async function handleSessionClose(res, session) {
  try {
    await session.client.session.delete({ path: { id: session.opencodeSid } });
  } catch { /* ignore */ }
  closeStream(session.eventStream);
  sessions.delete(session.sdkSessionId);
  return json(res, 204, null);
}

/** Close an SSE stream returned by event.subscribe() — supports both heyapi shapes. */
function closeStream(stream) {
  if (!stream) return;
  try {
    if (typeof stream.close === 'function') stream.close();
    else if (stream.controller?.abort) stream.controller.abort();
    else if (stream.stream?.return) stream.stream.return();
  } catch { /* ignore */ }
}

// ─── Utility ─────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === null ? '' : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
