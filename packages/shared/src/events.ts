/**
 * AgentEvent — Agent Loop 事件統一型別
 *
 * 由 AgentRuntime（容器內）發出，經 AgentProvider（API Server 端）
 * 轉發給 WebSocket / 通訊平台 Adapter。
 */

import type { TokenUsage } from './types.js';

export type AgentEvent =
  // ── 內容輸出 ──
  | { type: 'chunk'; delta: string }
  | { type: 'message'; content: string; complete: true }

  // ── 工具執行 ──
  | {
      type: 'tool.call';
      tool: string;
      args: Record<string, unknown>;
      callId: string;
      status: 'running';
    }
  | {
      type: 'tool.result';
      tool: string;
      callId: string;
      result: string;
      status: 'completed' | 'error';
    }

  // ── 步驟（LLM 推理步驟邊界） ──
  | { type: 'step.start' }
  | {
      type: 'step.finish';
      usage?: { reasoningTokens: number; inputTokens: number; outputTokens: number; cost: number };
    }

  // ── 子代理 ──
  | { type: 'subagent.started'; agentName: string }
  | { type: 'subagent.completed'; agentName: string; summary: string }

  // ── 人工互動 ──
  | {
      type: 'approval.required';
      requestId: string;
      tool: string;
      args: Record<string, unknown>;
      description: string;
    }
  | { type: 'approval.resolved'; requestId: string; approved: boolean }
  | {
      type: 'elicitation.required';
      requestId: string;
      question: string;
      options?: string[];
    }
  | { type: 'elicitation.resolved'; requestId: string; answer: string }

  // ── 生命週期 ──
  | { type: 'turn.start' }
  | { type: 'turn.end' }
  | { type: 'session.idle' }

  // ── 錯誤 ──
  | { type: 'error'; code: string; message: string; recoverable: boolean }

  // ── 完成 ──
  | { type: 'done'; messageId: string; usage: TokenUsage };

export type AgentEventType = AgentEvent['type'];

export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
