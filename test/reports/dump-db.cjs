const Database = require('better-sqlite3');
const db = new Database('/workspace/data/platform.db', { readonly: true });
const rows = db.prepare(
  "SELECT sessionId, role, agentId, substr(content,1,300) as content, createdAt FROM messages ORDER BY createdAt DESC LIMIT 20"
).all();
console.log(JSON.stringify(rows, null, 2));
const sessions = db.prepare(
  "SELECT sessionId, userId, sdkSessionId, containerId, status, messageCount FROM sessions ORDER BY createdAt DESC LIMIT 10"
).all();
console.log('--- sessions ---');
console.log(JSON.stringify(sessions, null, 2));
