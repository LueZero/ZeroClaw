/**
 * Opencode AgentProvider — HTTP + SSE 對 OpencodeAgentRuntime 進行通訊
 *
 * 對應協議（容器內 AgentRuntime 實作）：
 *   POST /sessions                        → { sdkSessionId }
 *   DELETE /sessions/:id
 *   POST /sessions/:id/messages           → SSE stream of AgentEvent
 *   POST /sessions/:id/abort
 *   POST /sessions/:id/agent              { subAgent }
 *   POST /sessions/:id/approval           { requestId, approved }
 *   POST /sessions/:id/elicitation        { requestId, answer }
 *   GET  /healthz
 */

import { Errors } from '@zeroclaw/shared';
import type { AgentEvent, ChatMessage } from '@zeroclaw/shared';
import type {
  AgentProvider,
  AgentProviderConnectionInfo,
  CreateSessionOptions,
  SendMessageOptions,
  SessionHandle,
} from './agent-provider.js';

interface OpencodeProviderOptions {
  host: string;
  port: number;
  fetch?: typeof fetch;
}

export class OpencodeAgentProvider implements AgentProvider {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpencodeProviderOptions) {
    this.base = `http://${opts.host}:${opts.port}`;
    this.fetchFn = opts.fetch ?? fetch;
  }

  static connectionInfo(host: string, port: number): AgentProviderConnectionInfo {
    return { host, port, protocol: 'http' };
  }

  async isReady(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.base}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: options.sessionId,
          userId: options.userId,
          agentId: options.agentId,
          subAgent: options.subAgent,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.containerLaunchFailed(`Agent container unreachable: ${msg}`);
    }
    if (!res.ok) {
      throw Errors.containerLaunchFailed(`createSession failed: ${res.status}`);
    }
    const data = (await res.json()) as { sdkSessionId: string };
    return { sdkSessionId: data.sdkSessionId, sessionId: options.sessionId };
  }

  async ensureSession(options: CreateSessionOptions): Promise<SessionHandle> {
    return this.createSession(options); // runtime 內部冪等
  }

  async closeSession(sdkSessionId: string): Promise<void> {
    await this.fetchFn(`${this.base}/sessions/${encodeURIComponent(sdkSessionId)}`, {
      method: 'DELETE',
    });
  }

  async switchAgent(sdkSessionId: string, subAgent: string): Promise<void> {
    const res = await this.fetchFn(
      `${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/agent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subAgent }),
      },
    );
    if (!res.ok) throw Errors.containerLaunchFailed(`switchAgent failed: ${res.status}`);
  }

  async *sendMessage(
    sdkSessionId: string,
    options: SendMessageOptions,
  ): AsyncIterable<AgentEvent> {
    let res: Response;
    try {
      res = await this.fetchFn(
        `${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ text: options.text, attachments: options.attachments }),
          signal: options.signal,
        },
      );
    } catch (err) {
      // AbortError: client disconnected — end the generator cleanly
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      // Container unavailable (stopped, network error, etc.)
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.containerLaunchFailed(`Agent container unreachable: ${msg}`);
    }
    if (!res.ok || !res.body) {
      throw Errors.containerLaunchFailed(`sendMessage failed: ${res.status}`);
    }
    yield* parseSseStream(res.body, options.signal);
  }

  async abortTurn(sdkSessionId: string): Promise<void> {
    await this.fetchFn(`${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/abort`, {
      method: 'POST',
    });
  }

  async resolveApproval(
    sdkSessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    await this.fetchFn(
      `${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/approval`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, approved }),
      },
    );
  }

  async resolveElicitation(
    sdkSessionId: string,
    requestId: string,
    answer: string,
  ): Promise<void> {
    await this.fetchFn(
      `${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/elicitation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, answer }),
      },
    );
  }

  async dispose(): Promise<void> {
    // 連線無持久狀態
  }

  /**
   * T-1: Inject history into a newly created SDK session.
   * Sends formatted chat history as a system prompt so the LLM has prior context.
   */
  async injectHistory(sdkSessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;

    // Format messages into a readable history block
    const historyLines = messages.map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      return `[${role}]: ${m.content}`;
    });
    const historyText = [
      '<conversation_history>',
      '以下是此 session 的歷史對話記錄（容器重啟後自動回放）：',
      '',
      ...historyLines,
      '</conversation_history>',
    ].join('\n');

    // Use the session prompt endpoint to inject history without triggering a response
    const res = await this.fetchFn(
      `${this.base}/sessions/${encodeURIComponent(sdkSessionId)}/prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: historyText }),
      },
    );
    // If the prompt endpoint doesn't exist (404), fall back silently
    if (!res.ok && res.status !== 404) {
      throw new Error(`injectHistory failed: ${res.status}`);
    }
  }
}

/**
 * 解析 text/event-stream
 * 每個事件：data: {json}\n\n
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // T-10c: cancel reader when signal is aborted
  const onAbort = signal
    ? () => { try { reader.cancel(); } catch { /* ignore */ } }
    : undefined;
  if (signal && onAbort) {
    if (signal.aborted) { reader.cancel(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        // AbortError from reader.cancel() — normal client disconnect
        if (err instanceof DOMException && err.name === 'AbortError') break;
        if (err instanceof Error && err.name === 'AbortError') break;
        throw err;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseEvent(chunk);
        if (event) yield event;
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseSseEvent(raw: string): AgentEvent | null {
  const lines = raw.split('\n');
  let data = '';
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data += line.slice(5).trimStart();
    }
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as AgentEvent;
  } catch {
    return null;
  }
}
