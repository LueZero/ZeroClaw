/**
 * 全面驗證：同一個容器服務多使用者、多 session 對話。
 *
 * 涵蓋情境：
 *   A. 容器共用：同一 group/agent 下，序列建立多個 session 應落在同一個容器
 *   B. 同使用者多 session 隔離：同一個 user 的 sessionA 與 sessionB 對話互不污染
 *   C. 不同使用者多 session 隔離：sessionA(userA) 與 sessionB(userB) 對話互不污染
 *   D. 同容器並行對話：同容器內多 session 同時發訊息，事件不互相干擾、不排隊
 *   E. 跨 session 記憶不洩漏：在 sessionA 寫入 SECRET_X，在 sessionB 詢問
 *      不應拿到 SECRET_X（除非模型自己亂猜，需以「不出現確切字串」為門檻）
 *
 * 報告輸出：
 *   test/reports/comprehensive.md
 *   test/reports/comprehensive.json
 *
 * 注意：本測試刻意避開「重新登入同 user 同 group 同 agent → reuses session」的設計
 *       （session-manager 沒有針對同 (user, group, agent) 進行 dedup，每次 POST /sessions
 *        都建立新 session — 測試會以「sessionId 不同」為前提）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const REPORT_DIR = resolve(process.cwd(), 'test', 'reports');

interface SessionInfo {
  userId: string;
  token: string;
  sessionId: string;
  containerId: string;
  ws: WebSocket;
}

interface ChatTrace {
  label: string;
  userId: string;
  sessionId: string;
  containerId: string;
  prompt: string;
  reply: string;
  events: { t: number; type: string; sessionId?: string; payload: Record<string, unknown> }[];
  tSent: number;
  tFirstEvent?: number;
  tDone?: number;
  finalState: 'done' | 'error' | 'timeout';
  errorMsg?: string;
}

const allTraces: ChatTrace[] = [];
const allSessions: SessionInfo[] = [];

// ────────────────── helpers ──────────────────

async function api(path: string, init?: RequestInit & { token?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.token) headers['authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function login(userId: string): Promise<string> {
  const { status, body } = await api('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ userId, role: 'member' }),
  });
  if (status !== 200) throw new Error(`login failed: ${status} ${JSON.stringify(body)}`);
  return (body as { token: string }).token;
}

async function createSession(token: string): Promise<{ sessionId: string; containerId: string }> {
  const { status, body } = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ groupId: 'support', agentId: 'faq-bot' }),
    token,
  });
  if (status !== 200) throw new Error(`createSession failed: ${status} ${JSON.stringify(body)}`);
  return body as { sessionId: string; containerId: string };
}

async function getSession(token: string, sessionId: string): Promise<{ containerId: string }> {
  const { body } = await api(`/api/sessions/${sessionId}`, { token });
  return body as { containerId: string };
}

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:3000/ws?token=${encodeURIComponent(token)}`);
    ws.once('open', () => res(ws));
    ws.once('error', rej);
    setTimeout(() => rej(new Error('ws connect timeout')), 10000);
  });
}

function subscribe(ws: WebSocket, sessionId: string): Promise<void> {
  return new Promise((res, rej) => {
    const handler = (raw: Buffer) => {
      const m = JSON.parse(raw.toString()) as { type: string; sessionId?: string };
      if (m.type === 'subscribed' && m.sessionId === sessionId) {
        ws.off('message', handler);
        res();
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    setTimeout(() => { ws.off('message', handler); rej(new Error('subscribe timeout')); }, 8000);
  });
}

async function setupSession(userId: string): Promise<SessionInfo> {
  const token = await login(userId);
  const created = await createSession(token);
  // Wait for container to be assigned (first message triggers ensureContainer; here we
  // do an immediate dummy GET to confirm session record exists, container arrives on first chat)
  const ws = await connectWs(token);
  await subscribe(ws, created.sessionId);
  const info: SessionInfo = {
    userId,
    token,
    sessionId: created.sessionId,
    containerId: created.containerId, // may be null until first message
    ws,
  };
  allSessions.push(info);
  return info;
}

/** 送一則訊息並收齊事件，回傳 trace */
function chat(label: string, info: SessionInfo, prompt: string, timeoutMs = 90_000): Promise<ChatTrace> {
  return new Promise((resolveOk) => {
    const trace: ChatTrace = {
      label,
      userId: info.userId,
      sessionId: info.sessionId,
      containerId: info.containerId,
      prompt,
      reply: '',
      events: [],
      tSent: 0,
      finalState: 'timeout',
    };

    const handler = (raw: Buffer) => {
      const t = Date.now();
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const type = String(msg.type ?? '');
      const sid = msg.sessionId as string | undefined;
      // 只接收屬於本 session 的 agent.* 事件
      if (sid && sid !== info.sessionId) return;
      if (type === 'subscribed' || type === 'unsubscribed' || type === 'connected') return;

      trace.events.push({ t, type, sessionId: sid, payload: msg });
      if (trace.tFirstEvent === undefined) trace.tFirstEvent = t;

      if (type === 'agent.chunk') {
        trace.reply += String((msg as { delta?: string }).delta ?? '');
      } else if (type === 'agent.done') {
        trace.tDone = t;
        trace.finalState = 'done';
        info.ws.off('message', handler);
        resolveOk(trace);
      } else if (type === 'agent.error') {
        trace.tDone = t;
        trace.finalState = 'error';
        trace.errorMsg = JSON.stringify((msg as { error?: unknown }).error);
        info.ws.off('message', handler);
        resolveOk(trace);
      }
    };

    info.ws.on('message', handler);
    trace.tSent = Date.now();
    info.ws.send(JSON.stringify({ type: 'user.message', sessionId: info.sessionId, text: prompt }));

    setTimeout(() => {
      if (trace.finalState === 'timeout') {
        trace.tDone = Date.now();
        info.ws.off('message', handler);
        resolveOk(trace);
      }
    }, timeoutMs);
  });
}

async function refreshContainerId(info: SessionInfo): Promise<void> {
  // After first message, server records containerId. Re-fetch.
  const s = await getSession(info.token, info.sessionId);
  if (s.containerId) info.containerId = s.containerId;
}

// ────────────────── tests ──────────────────

describe('Comprehensive multi-session / multi-user / shared-container', () => {
  beforeAll(async () => {
    expect((await api('/healthz')).status).toBe(200);
  });

  afterAll(() => {
    for (const s of allSessions) try { s.ws.close(); } catch { /* noop */ }
    try {
      mkdirSync(REPORT_DIR, { recursive: true });
      const report = buildReport();
      writeFileSync(resolve(REPORT_DIR, 'comprehensive.json'), JSON.stringify(report.json, null, 2));
      writeFileSync(resolve(REPORT_DIR, 'comprehensive.md'), report.md);
      // eslint-disable-next-line no-console
      console.log('\n===== COMPREHENSIVE REPORT =====\n' + report.md);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to write report', e);
    }
  });

  // ─── A. 容器共用 ───
  it('A: sequential sessions for same group share one container', async () => {
    const userA = `compr-A-${Date.now()}`;
    const s1 = await setupSession(userA);
    const s2 = await setupSession(userA);
    const s3 = await setupSession(userA);

    // 觸發容器啟動：對每個 session 發一則訊息
    const t1 = await chat('A.s1.warmup', s1, 'Reply with: WARMUP_S1');
    await refreshContainerId(s1);
    const t2 = await chat('A.s2.warmup', s2, 'Reply with: WARMUP_S2');
    await refreshContainerId(s2);
    const t3 = await chat('A.s3.warmup', s3, 'Reply with: WARMUP_S3');
    await refreshContainerId(s3);

    allTraces.push(t1, t2, t3);

    // 三個 session 應該落在同一個 container
    expect(s1.containerId).toBeTruthy();
    expect(s2.containerId).toBe(s1.containerId);
    expect(s3.containerId).toBe(s1.containerId);

    // 三個 session id 不同
    expect(new Set([s1.sessionId, s2.sessionId, s3.sessionId]).size).toBe(3);
  }, 5 * 60_000);

  // ─── B. 同使用者多 session 隔離 ───
  it('B: same user, two sessions in same container — context isolated', async () => {
    const userB = `compr-B-${Date.now()}`;
    const sX = await setupSession(userB);
    const sY = await setupSession(userB);

    // 在 sX 寫入秘密
    const tX1 = await chat('B.sX.write', sX,
      'Remember this code for later: BLUE_HORSE_777. Reply with exactly: ACK_X');
    await refreshContainerId(sX);
    const tY1 = await chat('B.sY.write', sY,
      'Remember this code for later: GREEN_FOX_999. Reply with exactly: ACK_Y');
    await refreshContainerId(sY);

    // 兩個 session 落在同一個容器
    expect(sX.containerId).toBe(sY.containerId);

    // 在 sX 詢問，理應只記得 BLUE_HORSE_777
    const tX2 = await chat('B.sX.recall', sX,
      'What was the code I asked you to remember? Reply with just the code, nothing else.');
    // 在 sY 詢問，理應只記得 GREEN_FOX_999
    const tY2 = await chat('B.sY.recall', sY,
      'What was the code I asked you to remember? Reply with just the code, nothing else.');

    allTraces.push(tX1, tY1, tX2, tY2);

    // 強制斷言：sX 不應提到 GREEN_FOX_999；sY 不應提到 BLUE_HORSE_777
    expect(tX2.reply).not.toContain('GREEN_FOX_999');
    expect(tY2.reply).not.toContain('BLUE_HORSE_777');

    // 期望（軟）：sX 至少提到 BLUE_HORSE 部份；sY 提到 GREEN_FOX 部份
    // 不強制 — 模型可能拒答或回 "I don't know"，那也算隔離成功
  }, 10 * 60_000);

  // ─── C. 不同使用者多 session 隔離 ───
  it('C: different users in same container — context isolated', async () => {
    const userC1 = `compr-C1-${Date.now()}`;
    const userC2 = `compr-C2-${Date.now()}`;
    const sC1 = await setupSession(userC1);
    const sC2 = await setupSession(userC2);

    const tC1a = await chat('C.user1.write', sC1,
      'My favourite color is purple-magenta-XYZ123. Reply with: ACK_C1');
    await refreshContainerId(sC1);
    const tC2a = await chat('C.user2.write', sC2,
      'My favourite color is yellow-cyan-ABC987. Reply with: ACK_C2');
    await refreshContainerId(sC2);

    // 同一容器
    expect(sC1.containerId).toBe(sC2.containerId);

    const tC1b = await chat('C.user1.recall', sC1,
      'What is my favourite color? Reply with just the color string.');
    const tC2b = await chat('C.user2.recall', sC2,
      'What is my favourite color? Reply with just the color string.');

    allTraces.push(tC1a, tC2a, tC1b, tC2b);

    // 跨使用者隔離：user1 不應出現 user2 的 token，反之亦然
    expect(tC1b.reply).not.toContain('ABC987');
    expect(tC1b.reply).not.toContain('yellow-cyan');
    expect(tC2b.reply).not.toContain('XYZ123');
    expect(tC2b.reply).not.toContain('purple-magenta');
  }, 10 * 60_000);

  // ─── D. 同容器並行對話不互相干擾 ───
  it('D: concurrent messages on different sessions in same container', async () => {
    const userD1 = `compr-D1-${Date.now()}`;
    const userD2 = `compr-D2-${Date.now()}`;
    const userD3 = `compr-D3-${Date.now()}`;
    const sD1 = await setupSession(userD1);
    const sD2 = await setupSession(userD2);
    const sD3 = await setupSession(userD3);

    // 先 warmup 取得 containerId
    await chat('D.warmup1', sD1, 'Reply: 1');
    await refreshContainerId(sD1);
    await chat('D.warmup2', sD2, 'Reply: 2');
    await refreshContainerId(sD2);
    await chat('D.warmup3', sD3, 'Reply: 3');
    await refreshContainerId(sD3);

    expect(sD1.containerId).toBe(sD2.containerId);
    expect(sD1.containerId).toBe(sD3.containerId);

    // 真正的並行測試
    const wallStart = Date.now();
    const [tD1, tD2, tD3] = await Promise.all([
      chat('D.parallel1', sD1, 'Reply with the literal text: PARA_ONE'),
      chat('D.parallel2', sD2, 'Reply with the literal text: PARA_TWO'),
      chat('D.parallel3', sD3, 'Reply with the literal text: PARA_THREE'),
    ]);
    const wall = Date.now() - wallStart;

    allTraces.push(tD1, tD2, tD3);

    // 各 session 的回覆中不應出現其他 session 的 token（驗證沒有 cross-stream 污染）
    expect(tD1.reply).not.toContain('PARA_TWO');
    expect(tD1.reply).not.toContain('PARA_THREE');
    expect(tD2.reply).not.toContain('PARA_ONE');
    expect(tD2.reply).not.toContain('PARA_THREE');
    expect(tD3.reply).not.toContain('PARA_ONE');
    expect(tD3.reply).not.toContain('PARA_TWO');

    // 並行驗證：wall < sum(durations) * 0.7
    const sum = (tD1.tDone! - tD1.tSent) + (tD2.tDone! - tD2.tSent) + (tD3.tDone! - tD3.tSent);
    // eslint-disable-next-line no-console
    console.log(`[D] wall=${wall}ms sum=${sum}ms ratio=${(sum/wall).toFixed(2)}`);
    expect(sum / wall).toBeGreaterThan(1.3);

    // events 隔離：每筆 trace 的事件 sessionId 應只屬於該 session
    for (const t of [tD1, tD2, tD3]) {
      const otherIds = t.events
        .map(e => e.sessionId)
        .filter((s): s is string => Boolean(s) && s !== t.sessionId);
      expect(otherIds).toHaveLength(0);
    }
  }, 10 * 60_000);

  // ─── E. 跨 user 並行 + 同容器 + 內容互不洩漏 ───
  it('E: cross-user parallel chat in same container — no content leak via timing', async () => {
    const ue1 = `compr-E1-${Date.now()}`;
    const ue2 = `compr-E2-${Date.now()}`;
    const sE1 = await setupSession(ue1);
    const sE2 = await setupSession(ue2);

    await chat('E.warmup1', sE1, 'Reply: warmup');
    await refreshContainerId(sE1);
    await chat('E.warmup2', sE2, 'Reply: warmup');
    await refreshContainerId(sE2);

    expect(sE1.containerId).toBe(sE2.containerId);

    // 並行送出，分別包含獨特 marker
    const [tE1, tE2] = await Promise.all([
      chat('E.par.user1', sE1,
        'I am UserAlpha. My SECRET marker is APPLE_777. Reply with the literal text: ACK_ALPHA'),
      chat('E.par.user2', sE2,
        'I am UserBeta. My SECRET marker is BANANA_888. Reply with the literal text: ACK_BETA'),
    ]);

    // 接著各別追問 — 在另一個 turn 確保 context 沒被混用
    const [tE1q, tE2q] = await Promise.all([
      chat('E.recall.user1', sE1,
        'What was my SECRET marker? Reply only the marker token.'),
      chat('E.recall.user2', sE2,
        'What was my SECRET marker? Reply only the marker token.'),
    ]);

    allTraces.push(tE1, tE2, tE1q, tE2q);

    expect(tE1q.reply).not.toContain('BANANA_888');
    expect(tE2q.reply).not.toContain('APPLE_777');
    expect(tE1q.reply).not.toContain('UserBeta');
    expect(tE2q.reply).not.toContain('UserAlpha');
  }, 10 * 60_000);

  // ─── F. 多元對話內容（同容器、不同 session 各跑不同領域） ───
  it('F: diverse dialogue types — math / code / translation / role-play / multi-turn', async () => {
    const userF = `compr-F-${Date.now()}`;

    // 五個 session 各跑不同主題，再各做一次追問
    const sMath = await setupSession(userF);
    const sCode = await setupSession(userF);
    const sTrans = await setupSession(userF);
    const sRole = await setupSession(userF);
    const sLong = await setupSession(userF);

    // 第一回合（並行）
    const [fMath1, fCode1, fTrans1, fRole1, fLong1] = await Promise.all([
      chat('F.math.q1', sMath,
        'Compute step by step: (17 * 23) + (144 / 12). Show your work, then give the final number on a line starting with "ANSWER:".'),
      chat('F.code.q1', sCode,
        'Write a JavaScript function `fizzbuzz(n)` that returns an array of strings 1..n following classic FizzBuzz. Reply with only the code in a fenced ```js block.'),
      chat('F.trans.q1', sTrans,
        'Translate the following sentence into Traditional Chinese, French, and Japanese. Sentence: "The quick brown fox jumps over the lazy dog at midnight." Format as three lines, each prefixed with the language name in English, e.g. "Chinese: …".'),
      chat('F.role.q1', sRole,
        'You are a polite English butler named JEEVES. From now on, every reply must start with "Indeed, sir," and end with the signature "— Jeeves." First task: tell me the time of day if it were 09:30 in London.'),
      chat('F.long.q1', sLong,
        'Explain in 4 short bullet points why TCP needs a 3-way handshake. Each bullet must start with "- ".'),
    ]);

    // 第二回合 — 追問前文（測試各 session 的對話記憶獨立）
    const [fMath2, fCode2, fTrans2, fRole2, fLong2] = await Promise.all([
      chat('F.math.q2', sMath,
        'Now subtract 50 from your previous ANSWER and call the result DELTA. Reply with a single line "DELTA: <number>".'),
      chat('F.code.q2', sCode,
        'Now extend that function so that for multiples of 7 it appends "Bazz" to whatever it would otherwise output. Reply only with the updated code in a ```js block.'),
      chat('F.trans.q2', sTrans,
        'Now also add the German translation, keeping the same line format. Reply with just the German line, prefixed "German: …".'),
      chat('F.role.q2', sRole,
        'How would you politely refuse to bring me a third martini? Stay in character.'),
      chat('F.long.q2', sLong,
        'Now compress your 4 bullets into a single sentence of at most 25 words.'),
    ]);

    allTraces.push(fMath1, fCode1, fTrans1, fRole1, fLong1, fMath2, fCode2, fTrans2, fRole2, fLong2);

    // 容器共用 — 5 個 session 都應該在同一個容器
    await refreshContainerId(sMath);
    await refreshContainerId(sCode);
    await refreshContainerId(sTrans);
    await refreshContainerId(sRole);
    await refreshContainerId(sLong);
    const cids = new Set([sMath.containerId, sCode.containerId, sTrans.containerId, sRole.containerId, sLong.containerId]);
    expect(cids.size).toBe(1);

    // ─── 內容檢查（軟硬兼施）─────────────────────────────

    // F.math: 17*23 + 144/12 = 391 + 12 = 403
    expect(fMath1.reply).toMatch(/403/);
    // DELTA = 403 - 50 = 353 — 但允許模型回 "DELTA: 353" 或夾雜文字
    expect(fMath2.reply).toMatch(/353/);

    // F.code: 應出現 fizz / buzz 字樣與 fence
    expect(/fizz/i.test(fCode1.reply)).toBe(true);
    expect(/buzz/i.test(fCode1.reply)).toBe(true);
    expect(fCode1.reply).toMatch(/```/);
    // 第二回合應提到 Bazz 且仍是程式碼
    expect(/bazz/i.test(fCode2.reply)).toBe(true);

    // F.trans: 三個語言關鍵字至少各出現一次
    expect(fTrans1.reply).toMatch(/chinese|中文/i);
    expect(fTrans1.reply).toMatch(/french|fran|français/i);
    expect(fTrans1.reply).toMatch(/japanese|日本/i);
    // 第二回合至少要含 German
    expect(/german|deutsch/i.test(fTrans2.reply)).toBe(true);

    // F.role: 角色一致性 — 第一回 / 第二回都應以 Jeeves 風格回覆
    // 軟性：兩個回合任一個出現 "Jeeves" 或 "Indeed" 即視為角色維持
    const roleHits = [fRole1, fRole2].filter(t => /jeeves|indeed/i.test(t.reply));
    expect(roleHits.length).toBeGreaterThanOrEqual(1);

    // F.long: 第一回應有多個 "- " bullet，第二回則應該變短（壓成一句）
    const bulletCount = (fLong1.reply.match(/^[-*]\s/gm) ?? []).length;
    expect(bulletCount).toBeGreaterThanOrEqual(2); // 至少看得出 bullet
    expect(fLong2.reply.length).toBeLessThan(fLong1.reply.length);

    // 跨 session 不洩漏：math session 的回覆裡不應有 "FizzBuzz" / "Jeeves" / "Chinese"；
    //                  反之 code session 不應有 ANSWER:/DELTA:
    expect(/fizzbuzz/i.test(fMath2.reply)).toBe(false);
    expect(/jeeves/i.test(fMath2.reply)).toBe(false);
    expect(/answer:|delta:/i.test(fCode2.reply)).toBe(false);
    expect(/jeeves/i.test(fTrans2.reply)).toBe(false);
  }, 15 * 60_000);

  // ─── G. 連續多輪同 session（記憶累積與引用）───
  it('G: multi-turn within one session — accumulating context', async () => {
    const userG = `compr-G-${Date.now()}`;
    const sG = await setupSession(userG);

    // 模擬一段「角色扮演＋逐步資訊累加」的對話
    const tG1 = await chat('G.turn1', sG,
      'Let\'s play a game. I will give you facts; you remember them. Fact 1: my favourite city is Reykjavik. Reply just with: NOTED.');
    await refreshContainerId(sG);

    const tG2 = await chat('G.turn2', sG,
      'Fact 2: my favourite number is 137. Reply just with: NOTED.');
    const tG3 = await chat('G.turn3', sG,
      'Fact 3: my pet is a tortoise named Atlas. Reply just with: NOTED.');

    // 引用第一筆事實
    const tG4 = await chat('G.recall.city', sG,
      'What is my favourite city? Reply with just the city name, no extra words.');
    // 引用第二筆事實
    const tG5 = await chat('G.recall.number', sG,
      'What is my favourite number? Reply with only the number.');
    // 綜合題：用三項事實寫一句話
    const tG6 = await chat('G.compose', sG,
      'Now write ONE sentence that mentions my favourite city, my favourite number, and my pet by name. Keep it under 30 words.');

    allTraces.push(tG1, tG2, tG3, tG4, tG5, tG6);

    expect(/reykjavik/i.test(tG4.reply)).toBe(true);
    expect(/137/.test(tG5.reply)).toBe(true);
    // 綜合題：三個關鍵字應全出現
    expect(/reykjavik/i.test(tG6.reply)).toBe(true);
    expect(/137/.test(tG6.reply)).toBe(true);
    expect(/atlas/i.test(tG6.reply)).toBe(true);
  }, 10 * 60_000);
});

// ────────────────── report ──────────────────

function buildReport() {
  const containers = new Set(allSessions.map(s => s.containerId).filter(Boolean));
  const users = new Set(allSessions.map(s => s.userId));
  const sessionsCnt = allSessions.length;

  // 按 container 分組
  const perContainer: Record<string, { sessions: string[]; users: Set<string> }> = {};
  for (const s of allSessions) {
    if (!s.containerId) continue;
    if (!perContainer[s.containerId]) perContainer[s.containerId] = { sessions: [], users: new Set() };
    perContainer[s.containerId]!.sessions.push(s.sessionId);
    perContainer[s.containerId]!.users.add(s.userId);
  }

  const json = {
    capturedAt: new Date().toISOString(),
    api_base: API_BASE,
    summary: {
      totalSessions: sessionsCnt,
      totalUsers: users.size,
      totalContainers: containers.size,
      sessionsPerContainer: Object.fromEntries(
        Object.entries(perContainer).map(([k, v]) => [k, { sessions: v.sessions.length, users: v.users.size }]),
      ),
    },
    traces: allTraces.map(t => ({
      label: t.label,
      userId: t.userId,
      sessionId: t.sessionId,
      containerId: t.containerId,
      prompt: t.prompt,
      reply: t.reply,
      finalState: t.finalState,
      errorMsg: t.errorMsg,
      durationMs: t.tDone !== undefined ? t.tDone - t.tSent : null,
      firstEventLatencyMs: t.tFirstEvent !== undefined ? t.tFirstEvent - t.tSent : null,
      eventCount: t.events.length,
    })),
  };

  const lines: string[] = [];
  lines.push(`# 全面驗證報告：同容器 / 多使用者 / 多 session`);
  lines.push('');
  lines.push(`- 採集時間：${new Date().toISOString()}`);
  lines.push(`- API：${API_BASE}`);
  lines.push(`- 總 session 數：**${sessionsCnt}**`);
  lines.push(`- 總使用者數：**${users.size}**`);
  lines.push(`- 啟動的容器數：**${containers.size}**`);
  lines.push('');
  lines.push('## 容器使用分佈');
  lines.push('');
  lines.push('| containerId | sessions | distinct users |');
  lines.push('|---|---:|---:|');
  for (const [cid, v] of Object.entries(perContainer)) {
    lines.push(`| \`${cid}\` | ${v.sessions.length} | ${v.users.size} |`);
  }
  lines.push('');
  lines.push('## 對話追蹤');
  lines.push('');
  lines.push('| label | user | session | container | duration | reply (前 160 字) | state |');
  lines.push('|---|---|---|---|---:|---|---|');
  for (const t of allTraces) {
    const dur = t.tDone !== undefined ? `${t.tDone - t.tSent} ms` : 'n/a';
    const replyShort = (t.reply || t.errorMsg || '').replace(/\n/g, ' ').slice(0, 160);
    lines.push(
      `| ${t.label} | ${t.userId.split('-').pop()} | ${t.sessionId.slice(0, 8)} | ${t.containerId?.slice(-12) ?? '?'} | ${dur} | ${replyShort.replace(/\|/g, '\\|')} | ${t.finalState} |`,
    );
  }

  // 隔離判定
  lines.push('');
  lines.push('## 隔離性判定');
  const checks: { name: string; ok: boolean; note?: string }[] = [];

  // B 隔離
  const bX = allTraces.find(t => t.label === 'B.sX.recall');
  const bY = allTraces.find(t => t.label === 'B.sY.recall');
  if (bX && bY) {
    checks.push({ name: 'B.sX.recall 不含 GREEN_FOX_999 (對方 secret)', ok: !bX.reply.includes('GREEN_FOX_999') });
    checks.push({ name: 'B.sY.recall 不含 BLUE_HORSE_777 (對方 secret)', ok: !bY.reply.includes('BLUE_HORSE_777') });
  }

  // C 隔離
  const c1 = allTraces.find(t => t.label === 'C.user1.recall');
  const c2 = allTraces.find(t => t.label === 'C.user2.recall');
  if (c1 && c2) {
    checks.push({ name: 'C.user1 不含 yellow-cyan / ABC987', ok: !c1.reply.includes('ABC987') && !c1.reply.includes('yellow-cyan') });
    checks.push({ name: 'C.user2 不含 purple-magenta / XYZ123', ok: !c2.reply.includes('XYZ123') && !c2.reply.includes('purple-magenta') });
  }

  // D parallel 隔離
  for (const lbl of ['D.parallel1', 'D.parallel2', 'D.parallel3']) {
    const t = allTraces.find(tt => tt.label === lbl);
    if (!t) continue;
    const others = ['PARA_ONE', 'PARA_TWO', 'PARA_THREE'].filter(p => {
      const own = lbl === 'D.parallel1' ? 'PARA_ONE' : lbl === 'D.parallel2' ? 'PARA_TWO' : 'PARA_THREE';
      return p !== own;
    });
    const leak = others.find(o => t.reply.includes(o));
    checks.push({ name: `${lbl} 不含其他 session 的 token`, ok: !leak, note: leak ? `leaked=${leak}` : undefined });
  }

  // E 隔離
  const e1q = allTraces.find(t => t.label === 'E.recall.user1');
  const e2q = allTraces.find(t => t.label === 'E.recall.user2');
  if (e1q && e2q) {
    checks.push({ name: 'E.user1 不含 BANANA_888 / UserBeta', ok: !e1q.reply.includes('BANANA_888') && !e1q.reply.includes('UserBeta') });
    checks.push({ name: 'E.user2 不含 APPLE_777 / UserAlpha', ok: !e2q.reply.includes('APPLE_777') && !e2q.reply.includes('UserAlpha') });
  }

  // F 多元對話內容檢核
  const fMath1 = allTraces.find(t => t.label === 'F.math.q1');
  const fMath2 = allTraces.find(t => t.label === 'F.math.q2');
  const fCode1 = allTraces.find(t => t.label === 'F.code.q1');
  const fCode2 = allTraces.find(t => t.label === 'F.code.q2');
  const fTrans1 = allTraces.find(t => t.label === 'F.trans.q1');
  const fTrans2 = allTraces.find(t => t.label === 'F.trans.q2');
  const fRole1 = allTraces.find(t => t.label === 'F.role.q1');
  const fRole2 = allTraces.find(t => t.label === 'F.role.q2');
  const fLong1 = allTraces.find(t => t.label === 'F.long.q1');
  const fLong2 = allTraces.find(t => t.label === 'F.long.q2');
  if (fMath1 && fMath2) {
    checks.push({ name: 'F.math 第一回算出 403', ok: /403/.test(fMath1.reply) });
    checks.push({ name: 'F.math 追問得 DELTA=353', ok: /353/.test(fMath2.reply) });
  }
  if (fCode1 && fCode2) {
    checks.push({ name: 'F.code 第一回包含 fizz/buzz 與 fence', ok: /fizz/i.test(fCode1.reply) && /buzz/i.test(fCode1.reply) && /```/.test(fCode1.reply) });
    checks.push({ name: 'F.code 追問加入 Bazz', ok: /bazz/i.test(fCode2.reply) });
  }
  if (fTrans1 && fTrans2) {
    checks.push({ name: 'F.trans 第一回含 Chinese/French/Japanese', ok: /chinese|中文/i.test(fTrans1.reply) && /french|fran/i.test(fTrans1.reply) && /japanese|日本/i.test(fTrans1.reply) });
    checks.push({ name: 'F.trans 追問補上 German', ok: /german|deutsch/i.test(fTrans2.reply) });
  }
  if (fRole1 && fRole2) {
    checks.push({ name: 'F.role 至少一回維持 Jeeves 角色', ok: /jeeves|indeed/i.test(fRole1.reply) || /jeeves|indeed/i.test(fRole2.reply) });
  }
  if (fLong1 && fLong2) {
    const bullets = (fLong1.reply.match(/^[-*]\s/gm) ?? []).length;
    checks.push({ name: 'F.long 第一回有 ≥2 個 bullet', ok: bullets >= 2, note: `bullets=${bullets}` });
    checks.push({ name: 'F.long 追問壓縮較短', ok: fLong2.reply.length < fLong1.reply.length });
  }
  // F 跨 session 不洩漏（math vs code vs trans）
  if (fMath2 && fCode2 && fTrans2) {
    checks.push({ name: 'F.math 回覆不含 FizzBuzz/Jeeves', ok: !/fizzbuzz/i.test(fMath2.reply) && !/jeeves/i.test(fMath2.reply) });
    checks.push({ name: 'F.code 回覆不含 ANSWER:/DELTA:', ok: !/answer:|delta:/i.test(fCode2.reply) });
    checks.push({ name: 'F.trans 回覆不含 Jeeves', ok: !/jeeves/i.test(fTrans2.reply) });
  }

  // G 多輪記憶累積
  const gCity = allTraces.find(t => t.label === 'G.recall.city');
  const gNum = allTraces.find(t => t.label === 'G.recall.number');
  const gComp = allTraces.find(t => t.label === 'G.compose');
  if (gCity && gNum && gComp) {
    checks.push({ name: 'G.recall.city 含 Reykjavik', ok: /reykjavik/i.test(gCity.reply) });
    checks.push({ name: 'G.recall.number 含 137', ok: /137/.test(gNum.reply) });
    checks.push({ name: 'G.compose 同時含 Reykjavik / 137 / Atlas', ok: /reykjavik/i.test(gComp.reply) && /137/.test(gComp.reply) && /atlas/i.test(gComp.reply) });
  }

  for (const c of checks) {
    lines.push(`- ${c.ok ? '✅' : '❌'} ${c.name}${c.note ? ` (${c.note})` : ''}`);
  }

  // 並行統計
  const parallelTraces = allTraces.filter(t => t.label.startsWith('D.parallel') || t.label.startsWith('E.par.'));
  if (parallelTraces.length > 0) {
    lines.push('');
    lines.push('## 並行性指標');
    for (const t of parallelTraces) {
      const dur = t.tDone !== undefined ? t.tDone - t.tSent : 0;
      const first = t.tFirstEvent !== undefined ? t.tFirstEvent - t.tSent : 0;
      lines.push(`- ${t.label}: firstEvent=${first}ms total=${dur}ms`);
    }
  }

  // F / G 完整對話節錄（讓使用者讀真實模型輸出）
  const verbatim = allTraces.filter(t => t.label.startsWith('F.') || t.label.startsWith('G.'));
  if (verbatim.length > 0) {
    lines.push('');
    lines.push('## 多元對話完整節錄（F / G）');
    for (const t of verbatim) {
      lines.push('');
      lines.push(`### ${t.label}`);
      lines.push('');
      lines.push(`**Prompt：**`);
      lines.push('');
      lines.push('```');
      lines.push(t.prompt);
      lines.push('```');
      lines.push('');
      lines.push(`**Reply (${t.reply.length} chars, ${t.tDone !== undefined ? t.tDone - t.tSent : '?'} ms)：**`);
      lines.push('');
      lines.push('```');
      lines.push(t.reply || t.errorMsg || '(empty)');
      lines.push('```');
    }
  }

  const allOk = checks.every(c => c.ok);
  lines.push('');
  lines.push(`## 總結`);
  lines.push(`- 隔離檢查：${checks.filter(c => c.ok).length}/${checks.length} 通過`);
  lines.push(`- 整體判定：${allOk ? '✅ 同容器多 session 隔離正常' : '❌ 有隔離洩漏，請檢視上方詳情'}`);

  return { json, md: lines.join('\n') };
}
