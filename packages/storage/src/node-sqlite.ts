/**
 * Minimal better-sqlite3-compatible facade over Node's built-in `node:sqlite`.
 *
 * Why: native modules (better-sqlite3) must be rebuilt per Electron ABI and
 * need a C++ toolchain; `node:sqlite` ships with Node >= 22.5 AND with
 * Electron, so the same code runs in Vitest and in the desktop app.
 * Drizzle's `better-sqlite3` driver only needs: prepare(), stmt.run/get/all/raw(),
 * and transaction(fn).{deferred,immediate,exclusive}(...), which are provided here.
 */
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';

class StatementFacade {
  private rawMode = false;

  constructor(private readonly stmt: StatementSync) {}

  raw(toggle = true): this {
    this.rawMode = toggle;
    return this;
  }

  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(params as SQLInputValue[]));
  }

  get(...params: unknown[]): unknown {
    this.stmt.setReturnArrays(this.rawMode);
    return this.stmt.get(...(params as SQLInputValue[]));
  }

  all(...params: unknown[]): unknown[] {
    this.stmt.setReturnArrays(this.rawMode);
    return this.stmt.all(...(params as SQLInputValue[]));
  }
}

type TransactionBehavior = 'deferred' | 'immediate' | 'exclusive';

export class NodeSqliteClient {
  readonly native: DatabaseSync;

  constructor(path: string) {
    this.native = new DatabaseSync(path);
  }

  prepare(sql: string): StatementFacade {
    return new StatementFacade(this.native.prepare(sql));
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  get inTransaction(): boolean {
    return this.native.isTransaction;
  }

  close(): void {
    if (this.native.isOpen) this.native.close();
  }

  /** better-sqlite3 style: returns a function with `.deferred/.immediate/.exclusive` variants. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const run =
      (behavior: TransactionBehavior) =>
      (...args: A): R => {
        this.native.exec(`BEGIN ${behavior.toUpperCase()}`);
        try {
          const result = fn(...args);
          this.native.exec('COMMIT');
          return result;
        } catch (error) {
          if (this.native.isTransaction) this.native.exec('ROLLBACK');
          throw error;
        }
      };
    const wrapper = run('deferred') as ((...args: A) => R) & Record<TransactionBehavior, (...args: A) => R>;
    wrapper.deferred = run('deferred');
    wrapper.immediate = run('immediate');
    wrapper.exclusive = run('exclusive');
    return wrapper;
  }
}
