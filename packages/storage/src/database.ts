import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodeSqliteClient } from './node-sqlite';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema>;
/** The database itself, or a transaction scope of it. Repositories accept either. */
export type DbHandle = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'run' | 'get' | 'all' | 'values'>;

export interface OpenedDatabase {
  db: Db;
  client: NodeSqliteClient;
  close(): void;
}

export interface OpenOptions {
  /** Folder containing drizzle migration files (`meta/_journal.json` + *.sql). */
  migrationsFolder: string;
}

/**
 * Build a Drizzle database over `node:sqlite`. We deliberately avoid
 * `drizzle-orm/better-sqlite3`'s driver module (it imports the native
 * `better-sqlite3` package) and assemble the same pieces directly.
 */
function constructDb(client: NodeSqliteClient): Db {
  const dialect = new SQLiteSyncDialect();
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const schemaConfig = { fullSchema: schema, schema: tablesConfig.tables, tableNamesMap: tablesConfig.tableNamesMap };
  // BetterSQLiteSession only needs the better-sqlite3 subset implemented by NodeSqliteClient.
  const session = new BetterSQLiteSession(client as never, dialect, schemaConfig, {});
  const db = new (class extends BaseSQLiteDatabase<'sync', unknown, Schema> {})('sync', dialect, session as never, schemaConfig as never);
  return db as unknown as Db;
}

/** Open (and migrate) a SQLite database. `path` may be `:memory:`. */
export function openDatabase(path: string, options: OpenOptions): OpenedDatabase {
  const client = new NodeSqliteClient(path);
  client.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') {
    client.exec('PRAGMA journal_mode = WAL');
    client.exec('PRAGMA synchronous = NORMAL');
  }
  client.exec('PRAGMA busy_timeout = 5000');
  const db = constructDb(client);
  migrate(db, { migrationsFolder: options.migrationsFolder });
  return { db, client, close: () => client.close() };
}
