import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** `%term%` with LIKE wildcards in the user's term neutralised (pair with {@link likeSql}). */
export function likeEscape(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function likeSql(column: SQLiteColumn, pattern: string): SQL {
  return sql`${column} like ${pattern} escape '\\'`;
}
