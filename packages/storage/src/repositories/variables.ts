import { and, eq, inArray } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { newId, type VariableEntry } from '@aegis/core';
import { SECRET_REF_PREFIX, isSecretRef, secretRefKey } from '@aegis/security';
import type { DbHandle } from '../database';
import { environmentVariables, collectionVariables, folderVariables, globalVariables } from '../schema';
import type { SecretMode, SecretVault } from '../vault';

interface VariableTable extends SQLiteTable {
  id: SQLiteColumn;
  key: SQLiteColumn;
  initialValue: SQLiteColumn;
  currentValue: SQLiteColumn;
  isSecret: SQLiteColumn;
  enabled: SQLiteColumn;
  description: SQLiteColumn;
  type: SQLiteColumn;
  sortOrder: SQLiteColumn;
}

interface Row {
  id: string;
  key: string;
  initialValue: string;
  currentValue: string | null;
  isSecret: boolean;
  enabled: boolean;
  description: string;
  type: string | null;
  sortOrder: number;
}

/**
 * Generic store for the four variable scopes (global, environment, collection,
 * folder). Secret variables keep their values in secret storage; the row holds
 * only an empty value. Rows keep stable ids so secret references survive edits.
 */
export class VariableStore {
  constructor(
    private readonly db: DbHandle,
    private readonly vault: SecretVault,
    private readonly table: VariableTable,
    private readonly ownerColumn: SQLiteColumn,
    private readonly ownerField: string,
    private readonly scopeName: string,
  ) {}

  private vaultKey(rowId: string, which: 'initial' | 'current'): string {
    return `var:${this.scopeName}:${rowId}:${which}`;
  }

  list(ownerId: string, mode: SecretMode = 'refs'): VariableEntry[] {
    const rows = this.db.select().from(this.table).where(eq(this.ownerColumn, ownerId)).orderBy(this.table.sortOrder).all() as unknown as Row[];
    return rows.map((r) => this.toEntry(r, mode));
  }

  private toEntry(r: Row, mode: SecretMode): VariableEntry {
    const entry: VariableEntry = {
      id: r.id,
      key: r.key,
      initialValue: r.initialValue,
      isSecret: r.isSecret,
      enabled: r.enabled,
    };
    if (r.currentValue !== null) entry.currentValue = r.currentValue;
    if (r.description) entry.description = r.description;
    if (r.type) entry.type = r.type;
    if (r.isSecret) {
      const initial = this.vault.storage.getSync(this.vaultKey(r.id, 'initial'));
      const current = this.vault.storage.getSync(this.vaultKey(r.id, 'current'));
      if (mode === 'resolve') {
        entry.initialValue = initial ?? '';
        if (current !== null) entry.currentValue = current;
        else delete entry.currentValue;
      } else if (mode === 'refs') {
        entry.initialValue = initial !== null ? SECRET_REF_PREFIX + this.vaultKey(r.id, 'initial') : '';
        if (current !== null) entry.currentValue = SECRET_REF_PREFIX + this.vaultKey(r.id, 'current');
        else delete entry.currentValue;
      } else {
        entry.initialValue = '';
        delete entry.currentValue;
      }
    }
    return entry;
  }

  /** Replace all variables of an owner. Entries carrying an existing `id` keep their secrets. */
  replaceAll(ownerId: string, entries: readonly VariableEntry[]): VariableEntry[] {
    const existing = this.db.select({ id: this.table.id }).from(this.table).where(eq(this.ownerColumn, ownerId)).all() as unknown as Array<{ id: string }>;
    const existingIds = new Set(existing.map((e) => e.id));
    const keptIds = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];

    // Resolve secrets that are being kept BEFORE deleting anything.
    const secretValues = new Map<string, { initial: string | null; current: string | null }>();
    entries.forEach((e, index) => {
      const id = e.id && existingIds.has(e.id) && !keptIds.has(e.id) ? e.id : newId();
      keptIds.add(id);
      if (e.isSecret) {
        secretValues.set(id, {
          initial: this.resolveIncoming(e.initialValue),
          current: e.currentValue === undefined ? null : this.resolveIncoming(e.currentValue),
        });
      }
      rows.push({
        id,
        [this.ownerField]: ownerId,
        key: e.key,
        initialValue: e.isSecret ? '' : e.initialValue,
        currentValue: e.isSecret ? null : (e.currentValue ?? null),
        isSecret: e.isSecret,
        enabled: e.enabled,
        description: e.description ?? '',
        type: e.type ?? null,
        sortOrder: index,
      });
    });

    for (const id of existingIds) {
      this.vault.storage.deleteSync(this.vaultKey(id, 'initial'));
      this.vault.storage.deleteSync(this.vaultKey(id, 'current'));
    }
    this.db.delete(this.table).where(eq(this.ownerColumn, ownerId)).run();
    for (let i = 0; i < rows.length; i += 200) {
      this.db.insert(this.table).values(rows.slice(i, i + 200) as never).run();
    }
    for (const [id, v] of secretValues) {
      if (v.initial) this.vault.storage.setSync(this.vaultKey(id, 'initial'), v.initial);
      if (v.current) this.vault.storage.setSync(this.vaultKey(id, 'current'), v.current);
    }
    return this.list(ownerId, 'refs');
  }

  /** A secret value coming from the UI is either a reference to an existing secret or a new literal. */
  private resolveIncoming(value: string): string | null {
    if (value === '') return null;
    if (isSecretRef(value)) return this.vault.storage.getSync(secretRefKey(value));
    return value;
  }

  /** Update only the runtime (current) values by key, e.g. from `pm.environment.set`. */
  setCurrentValues(ownerId: string, changes: { set: Record<string, string>; unset: string[]; cleared: boolean }): void {
    const rows = this.db.select().from(this.table).where(eq(this.ownerColumn, ownerId)).all() as unknown as Row[];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    if (changes.cleared) {
      for (const r of rows) this.clearCurrent(r);
    }
    for (const key of changes.unset) {
      const r = byKey.get(key);
      if (r) this.clearCurrent(r);
    }
    let order = rows.length;
    for (const [key, value] of Object.entries(changes.set)) {
      const r = byKey.get(key);
      if (r) {
        if (r.isSecret) this.vault.storage.setSync(this.vaultKey(r.id, 'current'), value);
        else this.db.update(this.table).set({ currentValue: value } as never).where(eq(this.table.id, r.id)).run();
      } else {
        this.db
          .insert(this.table)
          .values({
            id: newId(),
            [this.ownerField]: ownerId,
            key,
            initialValue: '',
            currentValue: value,
            isSecret: false,
            enabled: true,
            description: '',
            type: null,
            sortOrder: order++,
          } as never)
          .run();
      }
    }
  }

  private clearCurrent(r: Row): void {
    if (r.isSecret) this.vault.storage.deleteSync(this.vaultKey(r.id, 'current'));
    else this.db.update(this.table).set({ currentValue: null } as never).where(eq(this.table.id, r.id)).run();
  }

  /** Delete every variable (and secret) of an owner. */
  deleteAll(ownerId: string): void {
    const rows = this.db.select({ id: this.table.id }).from(this.table).where(eq(this.ownerColumn, ownerId)).all() as unknown as Array<{ id: string }>;
    for (const r of rows) {
      this.vault.storage.deleteSync(this.vaultKey(r.id, 'initial'));
      this.vault.storage.deleteSync(this.vaultKey(r.id, 'current'));
    }
    this.db.delete(this.table).where(eq(this.ownerColumn, ownerId)).run();
  }

  /** Remove secrets for a set of owners that are about to be cascade-deleted. */
  purgeSecretsFor(ownerIds: readonly string[]): void {
    if (ownerIds.length === 0) return;
    const rows = this.db
      .select({ id: this.table.id })
      .from(this.table)
      .where(and(inArray(this.ownerColumn, [...ownerIds]), eq(this.table.isSecret, true)))
      .all() as unknown as Array<{ id: string }>;
    for (const r of rows) {
      this.vault.storage.deleteSync(this.vaultKey(r.id, 'initial'));
      this.vault.storage.deleteSync(this.vaultKey(r.id, 'current'));
    }
  }
}

export function createVariableStores(db: DbHandle, vault: SecretVault) {
  return {
    environment: new VariableStore(db, vault, environmentVariables as unknown as VariableTable, environmentVariables.environmentId, 'environmentId', 'env'),
    global: new VariableStore(db, vault, globalVariables as unknown as VariableTable, globalVariables.workspaceId, 'workspaceId', 'global'),
    collection: new VariableStore(db, vault, collectionVariables as unknown as VariableTable, collectionVariables.collectionId, 'collectionId', 'collection'),
    folder: new VariableStore(db, vault, folderVariables as unknown as VariableTable, folderVariables.folderId, 'folderId', 'folder'),
  };
}

export type VariableStores = ReturnType<typeof createVariableStores>;
