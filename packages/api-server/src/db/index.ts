/**
 * DB factory — selects PostgreSQL or SQLite based on DB_DRIVER env.
 *
 * PostgreSQL is the recommended production driver.
 * SQLite is kept for local development / testing.
 */

import type { DbStore } from './db-store.js';

export type { DbStore, PairingCode, FindMessagingSessionParams } from './db-store.js';

export async function createDb(opts: {
  driver: 'sqlite' | 'postgres';
  databaseUrl?: string;
  sqlitePath?: string;
}): Promise<DbStore> {
  if (opts.driver === 'postgres') {
    if (!opts.databaseUrl) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL to be set');
    }
    const { createPgDbStore } = await import('./pg-store.js');
    return createPgDbStore(opts.databaseUrl);
  }

  // SQLite (sync-wrapped as async)
  if (!opts.sqlitePath) {
    throw new Error('DB_DRIVER=sqlite requires SQLITE_PATH to be set');
  }
  const { createDbStore } = await import('./db-store.js');
  return createDbStore(opts.sqlitePath);
}
