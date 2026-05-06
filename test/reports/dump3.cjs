const Database = require('better-sqlite3');
const db = new Database('/workspace/data/platform.db');
db.pragma('wal_checkpoint(FULL)');
const cnt = db.prepare("SELECT COUNT(*) as c FROM messages").get();
console.log('messages count after checkpoint:', cnt.c);
const recent = db.prepare("SELECT id, session_id, role, substr(content,1,200) as content, created_at FROM messages ORDER BY created_at DESC LIMIT 20").all();
console.log(JSON.stringify(recent, null, 2));
db.close();
