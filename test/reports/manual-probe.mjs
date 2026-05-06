/**
 * 直接送一個訊息給已存在的 session，並觀察：
 *  - WS 收到的事件
 *  - api-server messages table
 *  - 容器 runtime 是否真的執行 chat()
 */
import WebSocket from 'ws';

const SESSION = process.env.SESSION_ID ?? '1162f883-2b0d-4efd-ae65-c2a833983d5f';
const USER = process.env.USER_ID ?? 'concurrent-1777420466285-u0';
const TEXT = process.env.TEXT ?? 'Reply with the literal text: TESTMARKER_42';

const loginRes = await fetch('http://localhost:3000/api/auth/dev-login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: USER, role: 'member' }),
});
const { token } = await loginRes.json();
console.log('token len=', token.length);

const ws = new WebSocket(`ws://localhost:3000/ws?token=${encodeURIComponent(token)}`);
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});
console.log('ws open');

const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  events.push(m);
  console.log(JSON.stringify(m).slice(0, 300));
});

ws.send(JSON.stringify({ type: 'subscribe', sessionId: SESSION }));
await new Promise((r) => setTimeout(r, 500));
ws.send(JSON.stringify({ type: 'user.message', sessionId: SESSION, text: TEXT }));

await new Promise((r) => setTimeout(r, 30000));
ws.close();

console.log('\n--- TOTAL EVENTS:', events.length);
const types = {};
for (const e of events) types[e.type] = (types[e.type] ?? 0) + 1;
console.log('types:', types);

// Now query messages table via REST
const msgRes = await fetch(`http://localhost:3000/api/sessions/${SESSION}/messages`, {
  headers: { authorization: `Bearer ${token}` },
});
const msgs = await msgRes.json();
console.log('\n--- DB MESSAGES for session:', msgs.length);
for (const m of msgs) console.log(m.role, ':', String(m.content).slice(0, 200));
