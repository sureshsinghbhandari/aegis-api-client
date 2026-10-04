import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../packages/storage/src/database';
import { workspaces, collections } from '../../packages/storage/src/schema';

const migrationsFolder = path.resolve(__dirname, '../../database/migrations');

describe('node:sqlite drizzle adapter', () => {
  it('migrates, inserts, selects and rolls back transactions', () => {
    const { db, close } = openDatabase(':memory:', { migrationsFolder });
    const now = new Date().toISOString();
    db.insert(workspaces).values({ id: 'w1', name: 'W', createdAt: now, updatedAt: now }).run();
    expect(db.select().from(workspaces).all()).toHaveLength(1);

    expect(() =>
      db.transaction((tx) => {
        tx.insert(collections).values({ id: 'c1', workspaceId: 'w1', name: 'C', uid: 'u', createdAt: now, updatedAt: now }).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.select().from(collections).all()).toHaveLength(0);

    db.transaction((tx) => {
      tx.insert(collections).values({ id: 'c1', workspaceId: 'w1', name: 'C', uid: 'u', createdAt: now, updatedAt: now }).run();
    });
    const row = db.select().from(collections).where(eq(collections.id, 'c1')).get();
    expect(row?.name).toBe('C');
    // foreign keys are enforced and cascade
    db.delete(workspaces).where(eq(workspaces.id, 'w1')).run();
    expect(db.select().from(collections).all()).toHaveLength(0);
    close();
  });
});
