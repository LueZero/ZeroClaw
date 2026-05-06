/**
 * Auto Router — LLM-based agent classifier
 *
 * 根據使用者訊息內容，自動判斷應路由到哪個 agent。
 * 使用 OpenAI 或 Anthropic API 進行分類。
 */

import type { AgentMetadata, IncomingMessage } from '@zeroclaw/shared';
import type { Logger } from 'pino';

export interface AutoRouterOptions {
  logger: Logger;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  fetch?: typeof fetch;
}

export interface AutoRouter {
  classify(
    message: IncomingMessage,
    candidates: AgentMetadata[],
    model?: string,
  ): Promise<string>;
}

export function createAutoRouter(opts: AutoRouterOptions): AutoRouter {
  const fetchFn = opts.fetch ?? fetch;
  const { logger } = opts;

  async function classify(
    message: IncomingMessage,
    candidates: AgentMetadata[],
    model?: string,
  ): Promise<string> {
    if (candidates.length <= 1) {
      return candidates[0]?.id ?? '';
    }

    const agentDescriptions = candidates
      .map((a, i) => `${i + 1}. ID: "${a.id}" — ${a.displayName}${a.description ? `: ${a.description}` : ''}`)
      .join('\n');

    const systemPrompt = `You are an intelligent message router. Based on the user's message, determine which agent is best suited to handle it.

Available agents:
${agentDescriptions}

Respond with ONLY the agent ID (no quotes, no explanation). If unsure, respond with the first agent's ID.`;

    const userContent = message.text;

    try {
      // 優先使用 OpenAI
      if (opts.openaiApiKey) {
        return await classifyWithOpenAI(systemPrompt, userContent, model ?? 'gpt-5-mini');
      }
      // 其次 Anthropic
      if (opts.anthropicApiKey) {
        return await classifyWithAnthropic(systemPrompt, userContent, model ?? 'claude-sonnet-4-20250514');
      }
    } catch (err) {
      logger.warn({ err }, 'Auto-classify failed, falling back to first candidate');
    }

    // fallback
    return candidates[0]!.id;
  }

  async function classifyWithOpenAI(
    system: string,
    user: string,
    model: string,
  ): Promise<string> {
    const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 50,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content?.trim() ?? '';
  }

  async function classifyWithAnthropic(
    system: string,
    user: string,
    model: string,
  ): Promise<string> {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.anthropicApiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 50,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content[0]?.text?.trim() ?? '';
  }

  return { classify };
}
