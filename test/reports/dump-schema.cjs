const Database = require('better-sqlite3');
const db = new Database('/workspace/data/platform.db', { readonly: true });
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
console.log('--- schema ---');
console.log(JSON.stringify(schema, null, 2));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (const { name } of tables) {
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get();
  console.log(`${name}: ${cnt.c} rows`);
}
