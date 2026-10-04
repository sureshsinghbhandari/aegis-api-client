import { asc, eq } from 'drizzle-orm';
import { AppError, newId, type Environment, type VariableEntry, type Workspace } from '@aegis/core';
import type { DbHandle } from '../database';
import { collections, environments, workspaces } from '../schema';
import type { SecretMode } from '../vault';
import type { CollectionRepository } from './collections';
import { likePattern } from './common';
import type { VariableStores } from './variables';
import { and, sql } from 'drizzle-orm';

type EnvRow = typeof environments.$inferSelect;

export class WorkspaceRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly collectionsRepo: CollectionRepository,
    private readonly vars: VariableStores,
    private readonly now: () => string,
  ) {}

  list(): Workspace[] {
    return this.db.select().from(workspaces).orderBy(asc(workspaces.createdAt), asc(workspaces.name)).all();
  }

  get(id: string): Workspace | null {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get() ?? null;
  }

  require(id: string): Workspace {
    const w = this.get(id);
    if (!w) throw new AppError('NOT_FOUND', 'Workspace not found.', { id });
    return w;
  }

  create(name: string, description = ''): Workspace {
    const id = newId();
    const ts = this.now();
    this.db.insert(workspaces).values({ id, name, description, createdAt: ts, updatedAt: ts }).run();
    return this.require(id);
  }

  update(id: string, patch: Partial<Pick<Workspace, 'name' | 'description'>>): Workspace {
    this.require(id);
    this.db.update(workspaces).set({ ...patch, updatedAt: this.now() }).where(eq(workspaces.id, id)).run();
    return this.require(id);
  }

  search(term: string): Workspace[] {
    const pattern = likePattern(term.trim());
    return this.db
      .select()
      .from(workspaces)
      .where(sql`${workspaces.name} like ${pattern} escape '\\'`)
      .all();
  }

  /** Deletes a workspace and everything in it, including secrets. */
  delete(id: string): void {
    this.require(id);
    for (const c of this.db.select({ id: collections.id }).from(collections).where(eq(collections.workspaceId, id)).all()) {
      this.collectionsRepo.purgeCollectionSecrets(c.id);
    }
    for (const e of this.db.select({ id: environments.id }).from(environments).where(eq(environments.workspaceId, id)).all()) {
      this.vars.environment.purgeSecretsFor([e.id]);
    }
    this.vars.global.purgeSecretsFor([id]);
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

export class EnvironmentRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly vars: VariableStores,
    private readonly now: () => string,
  ) {}

  private map(r: EnvRow): Environment {
    return { id: r.id, workspaceId: r.workspaceId, name: r.name, description: r.description, isActive: r.isActive, isProduction: r.isProduction, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  list(workspaceId: string): Environment[] {
    return this.db.select().from(environments).where(eq(environments.workspaceId, workspaceId)).orderBy(asc(environments.name)).all().map((r) => this.map(r));
  }

  get(id: string): Environment | null {
    const r = this.db.select().from(environments).where(eq(environments.id, id)).get();
    return r ? this.map(r) : null;
  }

  require(id: string): Environment {
    const e = this.get(id);
    if (!e) throw new AppError('NOT_FOUND', 'Environment not found.', { id });
    return e;
  }

  getActive(workspaceId: string): Environment | null {
    const r = this.db.select().from(environments).where(and(eq(environments.workspaceId, workspaceId), eq(environments.isActive, true))).get();
    return r ? this.map(r) : null;
  }

  create(workspaceId: string, input: { name: string; description?: string; isProduction?: boolean }, variables: VariableEntry[] = []): Environment {
    const id = newId();
    const ts = this.now();
    this.db
      .insert(environments)
      .values({ id, workspaceId, name: input.name, description: input.description ?? '', isActive: false, isProduction: input.isProduction ?? false, createdAt: ts, updatedAt: ts })
      .run();
    if (variables.length) this.vars.environment.replaceAll(id, variables);
    return this.require(id);
  }

  update(id: string, patch: Partial<Pick<Environment, 'name' | 'description' | 'isProduction'>>): Environment {
    this.require(id);
    this.db.update(environments).set({ ...patch, updatedAt: this.now() }).where(eq(environments.id, id)).run();
    return this.require(id);
  }

  /** Activate an environment (or deactivate all when `id` is null). */
  setActive(workspaceId: string, id: string | null): void {
    this.db.update(environments).set({ isActive: false }).where(eq(environments.workspaceId, workspaceId)).run();
    if (id) {
      this.require(id);
      this.db.update(environments).set({ isActive: true }).where(eq(environments.id, id)).run();
    }
  }

  duplicate(id: string): Environment {
    const src = this.require(id);
    const variables = this.vars.environment.list(id, 'resolve').map(({ id: _i, ...rest }) => rest);
    return this.create(src.workspaceId, { name: `${src.name} Copy`, description: src.description, isProduction: src.isProduction }, variables);
  }

  delete(id: string): void {
    this.require(id);
    this.vars.environment.purgeSecretsFor([id]);
    this.db.delete(environments).where(eq(environments.id, id)).run();
  }

  variables(id: string, mode: SecretMode = 'refs'): VariableEntry[] {
    return this.vars.environment.list(id, mode);
  }

  setVariables(id: string, entries: VariableEntry[]): VariableEntry[] {
    this.require(id);
    const result = this.vars.environment.replaceAll(id, entries);
    this.db.update(environments).set({ updatedAt: this.now() }).where(eq(environments.id, id)).run();
    return result;
  }
}
