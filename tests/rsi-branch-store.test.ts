import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-branch-store-'));
const store = path.join(root, 'db');
const dbFile = path.join(store, 'messages.db');

vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const rsiBranches = await import('../src/rsi/branch-store.js');
const rsiSettings = await import('../src/rsi/settings.js');

beforeAll(() => {
  db.initDatabase();
  for (const id of ['alice', 'bob']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'unit-test-hash',
      display_name: id,
      role: id === 'bob' ? 'admin' : 'member',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      must_change_password: false,
    });
  }
  for (const [id, owner] of [
    ['project', 'alice'],
    ['private', 'bob'],
  ]) {
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      added_at: new Date().toISOString(),
      created_by: owner,
      executionMode: 'container',
      is_home: false,
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createGoal(budget = 5) {
  return goals.createPersonalGoal('alice', randomUUID(), {
    workspace_jid: 'web:project',
    objective: 'Retryable goal',
    completion_criteria: ['Finish task'],
    budget_max_runs: budget,
  });
}

function createLinkedTask(goal: ReturnType<typeof createGoal>) {
  const id = randomUUID();
  db.createTask({
    id,
    group_folder: 'project',
    chat_jid: 'web:project',
    prompt: 'Run step',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: 'alice',
  });
  goals.linkPersonalGoalTask('alice', goal.id, id, goal.revision);
  return db.getTaskById(id)!;
}

describe('RSI branch store and settings', () => {
  test('isolates branches by ownerId', () => {
    const goal = createGoal();
    expect(() => rsiBranches.listBranches('bob', goal.id)).toThrow(
      'Goal not found',
    );
    expect(rsiBranches.listBranches('alice', goal.id)).toEqual([]);
  });

  test('increments ordinal up to 3 and rejects 4th via CHECK constraint', () => {
    const goal = createGoal();
    for (const expectedOrdinal of [1, 2, 3]) {
      const branch = rsiBranches.startBranch('alice', goal.id, {
        approach: '沿用原任务重新执行',
        trigger: 'manual',
      });
      expect(branch.ordinal).toBe(expectedOrdinal);
      expect(branch.status).toBe('running');
      const finished = rsiBranches.finishBranch('alice', branch.id, {
        status: 'failed',
        failKind: 'provider',
        retryable: true,
      });
      expect(finished.status).toBe('failed');
      expect(finished.finished_at).toBeTruthy();
    }
    expect(() =>
      rsiBranches.startBranch('alice', goal.id, {
        approach: '沿用原任务重新执行',
        trigger: 'manual',
      }),
    ).toThrow(/CHECK constraint failed/i);
  });

  test('rejects startBranch when a branch is already running', () => {
    const goal = createGoal();
    rsiBranches.startBranch('alice', goal.id, {
      approach: '沿用原任务重新执行',
      trigger: 'manual',
    });
    expect(() =>
      rsiBranches.startBranch('alice', goal.id, {
        approach: '沿用原任务重新执行',
        trigger: 'manual',
      }),
    ).toThrow('branch already running');
  });

  test('attachRun requires personal_goal_charges row and rejects uncharged runId', () => {
    const goal = createGoal();
    const task = createLinkedTask(goal);
    const branch = rsiBranches.startBranch('alice', goal.id, {
      approach: '沿用原任务重新执行',
      trigger: 'manual',
    });

    expect(() =>
      rsiBranches.attachRun('alice', branch.id, 'uncharged-run-id'),
    ).toThrow('personal_goal_charges');

    const createdRun = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('rsi-charge-test', 60_000)!;
    expect(claim.id).toBe(createdRun.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);

    const attached = rsiBranches.attachRun('alice', branch.id, createdRun.id);
    expect(attached.run_id).toBe(createdRun.id);
    expect(attached.status).toBe('running');
  });

  test('rejects finishBranch on already terminal branch', () => {
    const goal = createGoal();
    const branch = rsiBranches.startBranch('alice', goal.id, {
      approach: '沿用原任务重新执行',
      trigger: 'manual',
    });
    rsiBranches.finishBranch('alice', branch.id, {
      status: 'succeeded',
      failKind: null,
      retryable: null,
    });
    expect(() =>
      rsiBranches.finishBranch('alice', branch.id, {
        status: 'failed',
        failKind: 'runtime',
        retryable: true,
      }),
    ).toThrow('terminal');
  });

  test('SQLite trigger rejects updating immutable branch identity fields like ordinal', () => {
    const goal = createGoal();
    const branch = rsiBranches.startBranch('alice', goal.id, {
      approach: '沿用原任务重新执行',
      trigger: 'manual',
    });
    expect(() =>
      rsiBranches
        .rsiDb()
        .prepare('UPDATE rsi_branches SET ordinal = 2 WHERE id = ?')
        .run(branch.id),
    ).toThrow('RSI branch identity is immutable');
  });

  test('auto-retry setting defaults to false, persists updates, and rejects missing workspaceJid', () => {
    expect(rsiSettings.getAutoRetry('web:project')).toBe(false);
    rsiSettings.setAutoRetry('web:project', true);
    expect(rsiSettings.getAutoRetry('web:project')).toBe(true);
    rsiSettings.setAutoRetry('web:project', false);
    expect(rsiSettings.getAutoRetry('web:project')).toBe(false);

    expect(() => rsiSettings.setAutoRetry('web:missing', true)).toThrow(
      'Workspace not found',
    );
    expect(() => rsiSettings.getAutoRetry('web:missing')).toThrow(
      'Workspace not found',
    );
  });

  test('migrates a v107 database to v108 and creates rsi_branches automatically', () => {
    expect(db.CURRENT_SCHEMA_VERSION).toBe(108);
    db.closeDatabase();

    const raw = new Database(dbFile);
    raw.exec(`
      DROP TRIGGER IF EXISTS rsi_branch_identity_immutable;
      DROP INDEX IF EXISTS idx_rsi_branches_goal;
      DROP TABLE IF EXISTS rsi_branches;
      UPDATE router_state SET value = '107' WHERE key = 'schema_version';
    `);
    raw.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('108');

    const tableRow = rsiBranches
      .rsiDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rsi_branches'",
      )
      .get() as { name: string } | undefined;
    expect(tableRow?.name).toBe('rsi_branches');

    const backups = fs
      .readdirSync(path.join(store, 'migration-backups'))
      .filter((name) => name.startsWith('messages-v107-to-v108-'));
    expect(backups).toHaveLength(1);
  });
});
