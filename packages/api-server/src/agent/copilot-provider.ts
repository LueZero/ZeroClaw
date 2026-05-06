/**
 * Copilot AgentProvider — JSON-RPC over TCP 對 CopilotAgentRuntime 通訊
 *
 * 協議：每行一個 JSON-RPC 2.0 訊息（換行分隔）
 *
 * Methods（client → runtime）：
 *   session.create   { sessionId, userId, agentId, subAgent? }  → { sdkSessionId }
 *   session.close    { sdkSessionId }
 *   session.switchAgent  { sdkSessionId, subAgent }
 *   session.sendMessage  { sdkSessionId, text, attachments? }   ← 啟動串流
 *   session.abort    { sdkSessionId }
 *   session.approval { sdkSessionId, requestId, approved }
 *   session.elicit   { sdkSessionId, requestId, answer }
 *   ping
 *
 * Notifications（runtime → client）：
 *   agent.event { sdkSessionId, event: AgentEvent }
 */

import { Socket } from 'node:net';
import { Errors } from '@zeroclaw/shared';
import type { AgentEvent, ChatMessage } from '@zeroclaw/shared';
import type {
  AgentProvider,
  AgentProviderConnectionInfo,
  CreateSessionOptions,
  SendMessageOptions,
  SessionHandle,
} from './agent-provider.js';

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface RpcResponseSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result: T;
}
interface RpcResponseError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}
interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

type RpcInbound = RpcResponseSuccess | RpcResponseError | RpcNotification;

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface CopilotProviderOptions {
  host: string;
  port: number;
}

export class CopilotAgentProvider implements AgentProvider {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly streams = new Map<string, AgentEventStream>();
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly opts: CopilotProviderOptions) {}

  static connectionInfo(host: string, port: number): AgentProviderConnectionInfo {
    return { host, port, protocol: 'jsonrpc-tcp' };
  }

  async isReady(): Promise<boolean> {
    try {
      await this.connect();
      await this.call<unknown>('ping', {});
      return true;
    } catch {
      return false;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    await this.connect();
    const result = await this.call<{ sdkSessionId: string }>('session.create', options);
    return { sdkSessionId: result.sdkSessionId, sessionId: options.sessionId };
  }

  async ensureSession(options: CreateSessionOptions): Promise<SessionHandle> {
    return this.createSession(options);
  }

  async closeSession(sdkSessionId: string): Promise<void> {
    await this.connect();
    await this.call('session.close', { sdkSessionId });
  }

  async switchAgent(sdkSessionId: string, subAgent: string): Promise<void> {
    await this.connect();
    await this.call('session.switchAgent', { sdkSessionId, subAgent });
  }

  async *sendMessage(
    sdkSessionId: string,
    options: SendMessageOptions,
  ): AsyncIterable<AgentEvent> {
    await this.connect();

    const stream = new AgentEventStream();
    this.streams.set(sdkSessionId, stream);

    const onAbort = () => {
      void this.abortTurn(sdkSessionId);
      stream.close();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // 啟動串流（runtime 將以 agent.event 通知回送）
      await this.call('session.sendMessage', {
        sdkSessionId,
        text: options.text,
        attachments: options.attachments,
      });

      for await (const ev of stream) {
        yield ev;
        if (ev.type === 'done' || ev.type === 'error') break;
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.streams.delete(sdkSessionId);
    }
  }

  async abortTurn(sdkSessionId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.call('session.abort', { sdkSessionId });
    } catch {
      // 忽略
    }
  }

  async resolveApproval(
    sdkSessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    await this.connect();
    await this.call('session.approval', { sdkSessionId, requestId, approved });
  }

  async resolveElicitation(
    sdkSessionId: string,
    requestId: string,
    answer: string,
  ): Promise<void> {
    await this.connect();
    await this.call('session.elicit', { sdkSessionId, requestId, answer });
  }

  async dispose(): Promise<void> {
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    for (const p of this.pending.values()) {
      p.reject(new Error('Provider disposed'));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
  }

  /**
   * T-1: Inject history into a newly created SDK session.
   * Uses session.prompt RPC to send formatted history.
   */
  async injectHistory(sdkSessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;

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

    await this.connect();
    await this.call('session.prompt', { sdkSessionId, text: historyText });
  }

  // ──────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      sock.setNoDelay(true);
      sock.setEncoding('utf8');

      sock.on('data', (chunk) => this.onData(String(chunk)));
      sock.on('error', (err) => {
        if (this.connectPromise) reject(err);
        this.handleDisconnect();
      });
      sock.on('close', () => this.handleDisconnect());

      sock.connect(this.opts.port, this.opts.host, () => {
        this.socket = sock;
        resolve();
      });
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private handleDisconnect(): void {
    for (const p of this.pending.values()) {
      p.reject(Errors.containerLaunchFailed('Connection lost'));
    }
    this.pending.clear();
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RpcInbound;
        this.handleInbound(msg);
      } catch {
        // 忽略無效訊息
      }
    }
  }

  private handleInbound(msg: RpcInbound): void {
    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) {
        pending.reject(Errors.containerLaunchFailed(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'agent.event') {
      const params = msg.params as { sdkSessionId: string; event: AgentEvent };
      this.streams.get(params.sdkSessionId)?.push(params.event);
    }
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('Not connected'));
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.socket!.write(JSON.stringify(req) + '\n');
    });
  }
}

// ──────────────────────────────────────────────
// AgentEventStream — 將 push-based 通知轉成 AsyncIterable
// ──────────────────────────────────────────────

class AgentEventStream implements AsyncIterable<AgentEvent> {
  private readonly queue: AgentEvent[] = [];
  private waiter: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  private closed = false;

  push(ev: AgentEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: ev, done: false });
    } else {
      this.queue.push(ev);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as AgentEvent, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
