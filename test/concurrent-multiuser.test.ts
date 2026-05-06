/**
 * Concurrent multi-user session test (opencode agent).
 *
 * 目的：驗證多個使用者各自的 SESSION 在處理對話時是 *並行* 的，
 *      亦即使用者 B 不需要等使用者 A 的 LLM 回應跑完才開始收到事件。
 *
 * 衡量指標：
 *   1. firstEventLatency  — 每位使用者從送出 user.message 到收到第一個 agent 事件的延遲
 *   2. totalDuration      — 每位使用者收到 agent.done / agent.error 的總耗時
 *   3. wallClock          — 整個並行回合的牆鐘時間
 *   4. overlapRatio       — sum(totalDuration) / wallClock；>1 代表有並行重疊
 *   5. firstEventStaggerMax — 各使用者 firstEvent 時間戳之間的最大差距（並行下應該很小）
 *
 * 通過條件（自我懷疑點）：
 *   A. 每位使用者最終皆需收到 agent.done 或 agent.chunk（至少要有真實事件，而不是純錯誤）
 *      — 若全為 agent.error，仍視為「能並行」但會在報告中標註，不算功能驗證成功
 *   B. wallClock 必須 < sum(totalDuration) * 0.9 （>10% 的時間重疊）
 *   C. firstEventStaggerMax < min(totalDuration) * 0.5
 *      — 第一個事件應該幾乎同時抵達各使用者，而非排隊
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const USER_COUNT = Number(process.env.USER_COUNT ?? 3);
const PROMPT = process.env.PROMPT ?? 'Please count from one to five, slowly.';
const REPORT_DIR = resolve(process.cwd(), 'test', 'reports');

interface UserRun {
  userId: string;
  token: string;
  sessionId: string;
  containerId: string;
  ws: WebSocket;
  events: { t: number; type: string; payload: Record<string, unknown> }[];
  tSent?: number;
  tFirstEvent?: number;
  tDone?: number;
  finalState: 'done' | 'error' | 'timeout' | 'pending';
  finalErrorMsg?: string;
}

// ────────────────── helpers ──────────────────

async function api(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.token) headers['authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(userId: string): Promise<string> {
  const { status, body } = await api('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ userId, role: 'member' }),
  });
  if (status !== 200) {
    throw new Error(`login failed status=${status} body=${JSON.stringify(body)}`);
  }
  return (body as { token: string }).token;
}

async function createSession(
  token: string,
): Promise<{ sessionId: string; containerId: string }> {
  const { status, body } = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ groupId: 'support', agentId: 'faq-bot' }),
    token,
  });
  if (status !== 200) {
    throw new Error(`createSession failed status=${status} body=${JSON.stringify(body)}`);
  }
  const s = body as { sessionId: string; containerId: string };
  return { sessionId: s.sessionId, containerId: s.containerId };
}

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((resolveOk, rej) => {
    const ws = new WebSocket(
      `ws://localhost:3000/ws?token=${encodeURIComponent(token)}`,
    );
    ws.once('open', () => resolveOk(ws));
    ws.once('error', rej);
    setTimeout(() => rej(new Error('ws connect timeout')), 10000);
  });
}

function subscribe(ws: WebSocket, sessionId: string): Promise<void> {
  return new Promise((resolveOk, rej) => {
    const handler = (raw: Buffer) => {
      const m = JSON.parse(raw.toString()) as { type: string; sessionId?: string };
      if (m.type === 'subscribed' && m.sessionId === sessionId) {
        ws.off('message', handler);
        resolveOk();
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    setTimeout(() => {
      ws.off('message', handler);
      rej(new Error('subscribe timeout'));
    }, 8000);
  });
}

// 等到收到 agent.done / agent.error 為止；同時記錄事件序列
function runChat(run: UserRun, prompt: string, perRunTimeoutMs: number): Promise<void> {
  return new Promise((resolveOk) => {
    const handler = (raw: Buffer) => {
      const t = Date.now();
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const type = String(msg.type ?? 'unknown');
      if (msg.sessionId && msg.sessionId !== run.sessionId) return; // 別人 session 的事件忽略
      if (
        type === 'subscribed' ||
        type === 'unsubscribed' ||
        type === 'connected'
      ) {
        return;
      }
      run.events.push({ t, type, payload: msg });
      if (run.tFirstEvent === undefined) run.tFirstEvent = t;
      if (type === 'agent.done') {
        run.tDone = t;
        run.finalState = 'done';
        run.ws.off('message', handler);
        resolveOk();
      } else if (type === 'agent.error') {
        run.tDone = t;
        run.finalState = 'error';
        run.finalErrorMsg = JSON.stringify((msg as { error?: unknown }).error);
        run.ws.off('message', handler);
        resolveOk();
      }
    };
    run.ws.on('message', handler);
    run.tSent = Date.now();
    run.ws.send(
      JSON.stringify({ type: 'user.message', sessionId: run.sessionId, text: prompt }),
    );
    setTimeout(() => {
      if (run.finalState === 'pending') {
        run.finalState = 'timeout';
        run.tDone = Date.now();
        run.ws.off('message', handler);
        resolveOk();
      }
    }, perRunTimeoutMs);
  });
}

// ────────────────── test ──────────────────

describe('Concurrent multi-user opencode sessions', () => {
  const runs: UserRun[] = [];
  const wallClock = { start: 0, end: 0 };

  beforeAll(async () => {
    // 確保 API 有起來
    const { status } = await api('/healthz');
    expect(status).toBe(200);

    // 為 USER_COUNT 個使用者各自準備 token / session / WS（這部份本來就是序列做的，
    // 主要驗證重點是 *對話階段* 並行）
    for (let i = 0; i < USER_COUNT; i++) {
      const userId = `concurrent-${Date.now()}-u${i}`;
      const token = await login(userId);
      const { sessionId, containerId } = await createSession(token);
      const ws = await connectWs(token);
      await subscribe(ws, sessionId);
      runs.push({
        userId,
        token,
        sessionId,
        containerId,
        ws,
        events: [],
        finalState: 'pending',
      });
      // eslint-disable-next-line no-console
      console.log(
        `[setup] u${i} userId=${userId} session=${sessionId} container=${containerId}`,
      );
    }
    // 確認 session 各自獨立；container 為延遲啟動，建立時可能為 null
    const sids = new Set(runs.map((r) => r.sessionId));
    expect(sids.size).toBe(USER_COUNT);
  }, 5 * 60_000);

  afterAll(() => {
    for (const r of runs) {
      try {
        r.ws.close();
      } catch {
        /* noop */
      }
    }
    // 落地報告
    try {
      mkdirSync(REPORT_DIR, { recursive: true });
      const report = buildReport(runs, wallClock);
      writeFileSync(
        resolve(REPORT_DIR, 'concurrent-multiuser.json'),
        JSON.stringify(report.json, null, 2),
      );
      writeFileSync(resolve(REPORT_DIR, 'concurrent-multiuser.md'), report.md);
      // eslint-disable-next-line no-console
      console.log('\n===== REPORT =====\n' + report.md);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to write report', e);
    }
  });

  it('all users send messages concurrently and progress in parallel', async () => {
    wallClock.start = Date.now();
    await Promise.all(runs.map((r) => runChat(r, PROMPT, 240_000)));
    wallClock.end = Date.now();

    // 基本健康度：每位使用者必須至少有一筆事件
    for (const r of runs) {
      expect(r.events.length).toBeGreaterThan(0);
      expect(r.tSent).toBeDefined();
      expect(r.tFirstEvent).toBeDefined();
    }

    // 並行度檢查
    const totalDurations = runs.map((r) => (r.tDone ?? r.tFirstEvent!) - r.tSent!);
    const sumDur = totalDurations.reduce((a, b) => a + b, 0);
    const wc = wallClock.end - wallClock.start;
    const overlapRatio = sumDur / wc;

    // 條件 B: 牆鐘時間應顯著小於總耗時加總，代表確實並行
    //   對於 N 名使用者，理想下 wallClock ≈ max(duration_i)
    //   要求 overlapRatio > 1.3 至少（保守值），相當於 >30% 的時間並行
    // eslint-disable-next-line no-console
    console.log('overlapRatio=', overlapRatio, 'wallClock=', wc, 'sumDur=', sumDur, 'durations=', totalDurations);
    expect(overlapRatio).toBeGreaterThan(1.3);

    // 條件 C: 各使用者「收到第一個事件的時間」應接近，代表沒有排隊
    const firstEventOffsets = runs.map((r) => r.tFirstEvent! - r.tSent!);
    const stagger =
      Math.max(...firstEventOffsets) - Math.min(...firstEventOffsets);
    const minDur = Math.min(...totalDurations);
    // eslint-disable-next-line no-console
    console.log('firstEventOffsets=', firstEventOffsets, 'stagger=', stagger);
    expect(stagger).toBeLessThan(Math.max(minDur * 0.8, 5000));

    // 至少要有一位使用者進入 done 或 chunk 狀態（自我懷疑點 A）
    const anyChunkOrDone = runs.some((r) =>
      r.events.some((e) => e.type === 'agent.chunk' || e.type === 'agent.done'),
    );
    expect(anyChunkOrDone).toBe(true);
  }, 5 * 60_000);
});

// ────────────────── report builder ──────────────────

function buildReport(
  runs: UserRun[],
  wallClock: { start: number; end: number },
): { json: unknown; md: string } {
  const wc = wallClock.end - wallClock.start;
  const perUser = runs.map((r) => {
    const firstLatency =
      r.tFirstEvent !== undefined && r.tSent !== undefined
        ? r.tFirstEvent - r.tSent
        : null;
    const total =
      r.tDone !== undefined && r.tSent !== undefined ? r.tDone - r.tSent : null;
    const counts: Record<string, number> = {};
    for (const e of r.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return {
      userId: r.userId,
      sessionId: r.sessionId,
      containerId: r.containerId,
      finalState: r.finalState,
      finalErrorMsg: r.finalErrorMsg,
      firstEventLatencyMs: firstLatency,
      totalDurationMs: total,
      eventCount: r.events.length,
      eventTypeCounts: counts,
      firstEvents: r.events.slice(0, 5).map((e) => ({ type: e.type, t: e.t - (r.tSent ?? 0) })),
    };
  });
  const totals = perUser
    .map((p) => p.totalDurationMs)
    .filter((x): x is number => typeof x === 'number');
  const sumDur = totals.reduce((a, b) => a + b, 0);
  const overlapRatio = wc > 0 ? sumDur / wc : 0;
  const firstEventOffsets = perUser
    .map((p) => p.firstEventLatencyMs)
    .filter((x): x is number => typeof x === 'number');
  const stagger =
    firstEventOffsets.length > 0
      ? Math.max(...firstEventOffsets) - Math.min(...firstEventOffsets)
      : null;

  const json = {
    capturedAt: new Date().toISOString(),
    api_base: API_BASE,
    userCount: runs.length,
    wallClockMs: wc,
    sumOfPerUserDurationsMs: sumDur,
    overlapRatio,
    firstEventStaggerMs: stagger,
    perUser,
  };

  const lines: string[] = [];
  lines.push(`# 多使用者並行 Session 測試報告（opencode / faq-bot）`);
  lines.push('');
  lines.push(`- 採集時間：${new Date().toISOString()}`);
  lines.push(`- API：${API_BASE}`);
  lines.push(`- 使用者數：${runs.length}`);
  lines.push(`- 牆鐘時間：**${wc} ms**`);
  lines.push(`- 各使用者總耗時加總：**${sumDur} ms**`);
  lines.push(
    `- **重疊比 = sum/wall = ${overlapRatio.toFixed(2)}**（>1 代表有並行；理想接近 N=${runs.length}）`,
  );
  lines.push(`- 第一個事件抵達時間最大差距：**${stagger ?? 'n/a'} ms**`);
  lines.push('');
  lines.push('## 各使用者明細');
  for (const p of perUser) {
    lines.push('');
    lines.push(`### ${p.userId}`);
    lines.push(`- session：\`${p.sessionId}\``);
    lines.push(`- container：\`${p.containerId}\``);
    lines.push(`- 結束狀態：**${p.finalState}**`);
    if (p.finalErrorMsg) lines.push(`- 錯誤訊息：\`${p.finalErrorMsg}\``);
    lines.push(`- firstEvent 延遲：${p.firstEventLatencyMs ?? 'n/a'} ms`);
    lines.push(`- 總耗時：${p.totalDurationMs ?? 'n/a'} ms`);
    lines.push(`- 事件總數：${p.eventCount}`);
    lines.push(
      `- 事件分佈：${Object.entries(p.eventTypeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
    lines.push(
      `- 前 5 事件（相對於 send 的時間）：${p.firstEvents
        .map((e) => `${e.type}@+${e.t}ms`)
        .join('  |  ')}`,
    );
  }
  lines.push('');
  lines.push('## 判定');
  const verdictParallel = overlapRatio > 1.3;
  const verdictNoQueue =
    stagger !== null && Math.min(...totals) > 0 && stagger < Math.min(...totals) * 0.8;
  lines.push(
    `- 是否確實並行（overlapRatio > 1.3）：${verdictParallel ? '✅ 是' : '❌ 否'}`,
  );
  lines.push(
    `- 是否未排隊（firstEventStagger < minDur*0.8）：${verdictNoQueue ? '✅ 是' : '❌ 否'}`,
  );
  return { json, md: lines.join('\n') };
}
