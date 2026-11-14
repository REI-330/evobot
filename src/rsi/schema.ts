export interface RsiStatement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface RsiDatabase {
  exec(sql: string): void;
  prepare(sql: string): RsiStatement;
  transaction<T>(fn: () => T): () => T;
}

let database: RsiDatabase | null = null;

export function bindRsiDatabase(value: RsiDatabase | null): void {
  database = value;
}

export function rsiDb(): RsiDatabase {
  if (!database) throw new Error('RSI database is not initialized');
  return database;
}

export function createRsiSchema(connection: RsiDatabase): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS rsi_branches (
      id             TEXT PRIMARY KEY,
      goal_id        TEXT NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
      owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ordinal        INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
      approach       TEXT NOT NULL CHECK(length(approach) BETWEEN 1 AND 200),
      trigger        TEXT NOT NULL CHECK(trigger IN ('manual','auto')),
      status         TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','stopped')),
      fail_kind      TEXT,
      retryable      INTEGER CHECK(retryable IN (0,1)),
      run_id         TEXT,
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      UNIQUE(goal_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_rsi_branches_goal
      ON rsi_branches(goal_id, ordinal);
    CREATE TRIGGER IF NOT EXISTS rsi_branch_identity_immutable
    BEFORE UPDATE OF goal_id, owner_user_id, ordinal, trigger, started_at ON rsi_branches
    WHEN NEW.goal_id != OLD.goal_id OR NEW.owner_user_id != OLD.owner_user_id
      OR NEW.ordinal != OLD.ordinal OR NEW.trigger != OLD.trigger
      OR NEW.started_at != OLD.started_at
    BEGIN SELECT RAISE(ABORT, 'RSI branch identity is immutable'); END;

    CREATE TABLE IF NOT EXISTS rsi_methods (
      id                  TEXT PRIMARY KEY,
      owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      memory_item_id      TEXT NOT NULL UNIQUE REFERENCES personal_memory_entries(item_id) ON DELETE CASCADE,
      source_goal_id      TEXT REFERENCES personal_goals(id) ON DELETE SET NULL,
      source_run_id       TEXT,
      source_kind         TEXT NOT NULL CHECK(source_kind IN ('goal_completed','user_correction')),
      approach            TEXT NOT NULL CHECK(length(approach) BETWEEN 1 AND 200),
      verification        TEXT NOT NULL CHECK(verification IN ('none','passed','failed')),
      verified_at         TEXT,
      last_used_at        TEXT,
      use_count           INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rsi_methods_owner
      ON rsi_methods(owner_user_id, created_at DESC);
  `);
}
