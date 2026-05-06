/**
 * WebSocket 協議型別
 */

import type { AgentEvent } from './events.js';
import type { Attachment, TokenUsage } from './types.js';

// ────────────────────────────────────────────────────────────────────
// Client → Server
// ────────────────────────────────────────────────────────────────────

export type WsClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | {
      type: 'user.message';
      sessionId: string;
      text: string;
      attachments?: Attachment[];
    }
  | { type: 'user.abort'; sessionId: string }
  | { type: 'user.switchAgent'; sessionId: string; agentId: string; subAgent?: string }
  | {
      type: 'user.approval';
      sessionId: string;
      requestId: string;
      approved: boolean;
    }
  | {
      type: 'user.elicitation';
      sessionId: string;
      requestId: string;
      answer: string;
    };

export type WsClientMessageType = WsClientMessage['type'];

// ────────────────────────────────────────────────────────────────────
// Server → Client
// ────────────────────────────────────────────────────────────────────

interface BaseServerEvent {
  sessionId: string;
  messageId?: string;
}

export type WsServerMessage =
  | (BaseServerEvent & { type: 'agent.chunk'; delta: string })
  | (BaseServerEvent & {
      type: 'agent.toolCall';
      tool: string;
      args: Record<string, unknown>;
      callId: string;
      status: 'running';
    })
  | (BaseServerEvent & {
      type: 'agent.toolResult';
      tool: string;
      callId: string;
      result: string;
      status: 'completed' | 'error';
    })
  | (BaseServerEvent & { type: 'agent.stepStart' })
  | (BaseServerEvent & {
      type: 'agent.stepFinish';
      usage?: { reasoningTokens: number; inputTokens: number; outputTokens: number; cost: number };
    })
  | (BaseServerEvent & { type: 'agent.subagentStarted'; agentName: string })
  | (BaseServerEvent & {
      type: 'agent.subagentCompleted';
      agentName: string;
      summary: string;
    })
  | (BaseServerEvent & {
      type: 'agent.approvalRequired';
      requestId: string;
      tool: string;
      args: Record<string, unknown>;
      description: string;
    })
  | (BaseServerEvent & {
      type: 'agent.elicitationRequired';
      requestId: string;
      question: string;
      options?: string[];
    })
  | (BaseServerEvent & { type: 'agent.done'; usage: TokenUsage })
  | (BaseServerEvent & {
      type: 'agent.error';
      error: { code: string; message: string };
    })
  | (BaseServerEvent & {
      type: 'session.agentSwitched';
      previousAgent: string;
      currentAgent: string;
    })
  | { type: 'subscribed'; sessionId: string }
  | { type: 'unsubscribed'; sessionId: string }
  | { type: 'pong' };

export type WsServerMessageType = WsServerMessage['type'];

/**
 * 將 AgentEvent 轉成 WsServerMessage
 */
export function agentEventToWs(
  sessionId: string,
  event: AgentEvent,
  messageId?: string,
): WsServerMessage {
  const base = { sessionId, messageId } as const;

  switch (event.type) {
    case 'chunk':
      return { ...base, type: 'agent.chunk', delta: event.delta };

    case 'tool.call':
      return {
        ...base,
        type: 'agent.toolCall',
        tool: event.tool,
        args: event.args,
        callId: event.callId,
        status: 'running',
      };

    case 'tool.result':
      return {
        ...base,
        type: 'agent.toolResult',
        tool: event.tool,
        callId: event.callId,
        result: event.result,
        status: event.status,
      };

    case 'step.start':
      return { ...base, type: 'agent.stepStart' };

    case 'step.finish':
      return { ...base, type: 'agent.stepFinish', usage: event.usage };

    case 'subagent.started':
      return { ...base, type: 'agent.subagentStarted', agentName: event.agentName };

    case 'subagent.completed':
      return {
        ...base,
        type: 'agent.subagentCompleted',
        agentName: event.agentName,
        summary: event.summary,
      };

    case 'approval.required':
      return {
        ...base,
        type: 'agent.approvalRequired',
        requestId: event.requestId,
        tool: event.tool,
        args: event.args,
        description: event.description,
      };

    case 'elicitation.required':
      return {
        ...base,
        type: 'agent.elicitationRequired',
        requestId: event.requestId,
        question: event.question,
        options: event.options,
      };

    case 'done':
      return { ...base, type: 'agent.done', usage: event.usage, messageId: event.messageId };

    case 'error':
      return {
        ...base,
        type: 'agent.error',
        error: { code: event.code, message: event.message },
      };

    // 不直接對外的事件（內部追蹤用）
    case 'message':
    case 'turn.start':
    case 'turn.end':
    case 'session.idle':
    case 'approval.resolved':
    case 'elicitation.resolved':
      return { ...base, type: 'agent.chunk', delta: '' };
  }
}
