const Database = require('better-sqlite3');
const db = new Database('/workspace/data/platform.db', { readonly: true });
console.log('=== ALL MESSAGES ===');
const msgs = db.prepare(
  "SELECT id, session_id, role, agent_id, substr(content,1,500) as content, usage, created_at FROM messages ORDER BY created_at DESC"
).all();
console.log(JSON.stringify(msgs, null, 2));
console.log('\n=== SESSIONS (last 10) ===');
const sessions = db.prepare(
  "SELECT session_id, user_id, sdk_session_id, container_id, status, message_count, created_at FROM sessions ORDER BY created_at DESC LIMIT 10"
).all();
console.log(JSON.stringify(sessions, null, 2));
