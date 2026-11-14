import { randomUUID } from 'node:crypto';
import {
  getPersonalGoal,
  GoalConflict,
  patchPersonalGoal,
} from '../personal-agent/goal-store.js';
import { getWebDeps } from '../web-context.js';
import { rsiDb } from './schema.js';

export type RsiBranchTrigger = 'manual' | 'auto';
export type RsiBranchStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface RsiBranch {
  id: string;
  goal_id: string;
  owner_user_id: string;
  ordinal: number;
  approach: string;
  trigger: RsiBranchTrigger;
  status: RsiBranchStatus;
  fail_kind: string | null;
  retryable: boolean | null;
  run_id: string | null;
  started_at: string;
  finished_at: string | null;
}

type RsiBranchRow = Omit<RsiBranch, 'retryable'> & {
  retryable: number | null;
};

export const DEFAULT_RSI_APPROACH = '沿用原任务重新执行';

export { bindRsiDatabase, rsiDb } from './schema.js';

function mapBranch(row: RsiBranchRow): RsiBranch {
  return {
    ...row,
    retryable: row.retryable === null ? null : row.retryable === 1,
  };
}

function requireOwnedGoal(ownerId: string, goalId: string) {
  const goal = getPersonalGoal(ownerId, goalId);
  if (!goal) {
    throw new GoalConflict('GOAL_NOT_FOUND', 'Goal not found');
  }
  return goal;
}

function requireOwnedBranch(ownerId: string, branchId: string): RsiBranchRow {
  const row = rsiDb()
    .prepare('SELECT * FROM rsi_branches WHERE id = ?')
    .get(branchId) as RsiBranchRow | undefined;
  if (!row || row.owner_user_id !== ownerId) {
    throw new GoalConflict('GOAL_NOT_FOUND', 'RSI branch not found');
  }
  requireOwnedGoal(ownerId, row.goal_id);
  return row;
}

export function listBranches(ownerId: string, goalId: string): RsiBranch[] {
  requireOwnedGoal(ownerId, goalId);
  const rows = rsiDb()
    .prepare(
      'SELECT * FROM rsi_branches WHERE goal_id = ? AND owner_user_id = ? ORDER BY ordinal ASC',
    )
    .all(goalId, ownerId) as RsiBranchRow[];
  return rows.map(mapBranch);
}

export function startBranch(
  ownerId: string,
  goalId: string,
  input: { approach: string; trigger: RsiBranchTrigger },
): RsiBranch {
  return rsiDb().transaction(() => {
    requireOwnedGoal(ownerId, goalId);
    const active = rsiDb()
      .prepare(
        "SELECT 1 FROM rsi_branches WHERE goal_id = ? AND status = 'running' LIMIT 1",
      )
      .get(goalId);
    if (active) {
      throw new GoalConflict('RSI_BRANCH_RUNNING', 'branch already running');
    }
    const nextRow = rsiDb()
      .prepare(
        'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM rsi_branches WHERE goal_id = ?',
      )
      .get(goalId) as { next_ordinal: number };
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    rsiDb()
      .prepare(
        `INSERT INTO rsi_branches (
          id, goal_id, owner_user_id, ordinal, approach, trigger, status,
          fail_kind, retryable, run_id, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        id,
        goalId,
        ownerId,
        nextRow.next_ordinal,
        input.approach,
        input.trigger,
        startedAt,
      );
    const created = rsiDb()
      .prepare('SELECT * FROM rsi_branches WHERE id = ?')
      .get(id) as RsiBranchRow;
    return mapBranch(created);
  })();
}

export function attachRun(
  ownerId: string,
  branchId: string,
  runId: string,
): RsiBranch {
  return rsiDb().transaction(() => {
    const row = requireOwnedBranch(ownerId, branchId);
    if (row.status !== 'running') {
      throw new Error('Cannot attach run to a finished RSI branch');
    }
    const charged = rsiDb()
      .prepare(
        'SELECT 1 FROM personal_goal_charges WHERE run_id = ? AND goal_id = ?',
      )
      .get(runId, row.goal_id);
    if (!charged) {
      throw new Error('Run has not been charged to personal_goal_charges');
    }
    rsiDb()
      .prepare(
        "UPDATE rsi_branches SET run_id = ? WHERE id = ? AND status = 'running'",
      )
      .run(runId, branchId);
    const updated = rsiDb()
      .prepare('SELECT * FROM rsi_branches WHERE id = ?')
      .get(branchId) as RsiBranchRow;
    return mapBranch(updated);
  })();
}

export function finishBranch(
  ownerId: string,
  branchId: string,
  outcome: {
    status: 'succeeded' | 'failed' | 'stopped';
    failKind: string | null;
    retryable: boolean | null;
  },
): RsiBranch {
  return rsiDb().transaction(() => {
    const row = requireOwnedBranch(ownerId, branchId);
    if (row.status !== 'running') {
      throw new Error('RSI branch is already terminal');
    }
    const finishedAt = new Date().toISOString();
    const retryableVal =
      outcome.retryable === null ? null : outcome.retryable ? 1 : 0;
    rsiDb()
      .prepare(
        "UPDATE rsi_branches SET status = ?, fail_kind = ?, retryable = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(
        outcome.status,
        outcome.failKind,
        retryableVal,
        finishedAt,
        branchId,
      );
    const updated = rsiDb()
      .prepare('SELECT * FROM rsi_branches WHERE id = ?')
      .get(branchId) as RsiBranchRow;
    return mapBranch(updated);
  })();
}

export function beginRetry(
  ownerId: string,
  goalId: string,
  trigger: RsiBranchTrigger,
): RsiBranch {
  const goal = requireOwnedGoal(ownerId, goalId);
  if (goal.status !== 'failed') {
    throw new GoalConflict('GOAL_NOT_FAILED', 'Goal is not failed');
  }
  const taskRow = rsiDb()
    .prepare(
      `SELECT t.id
       FROM personal_goal_tasks gt
       JOIN scheduled_tasks t ON t.id = gt.task_id
       WHERE gt.goal_id = ?
         AND t.created_by = ?
         AND t.chat_jid = ?
         AND t.deleted_at IS NULL
       ORDER BY gt.automatic DESC, gt.linked_at ASC, gt.task_id ASC
       LIMIT 1`,
    )
    .get(goalId, goal.owner_user_id, goal.workspace_jid) as
    | { id: string }
    | undefined;
  if (!taskRow) {
    throw new Error('No linked task found for Goal retry');
  }
  const deps = getWebDeps();
  if (!deps?.triggerTaskRun) {
    throw new Error('Scheduler not available');
  }
  const branch = startBranch(ownerId, goalId, {
    approach: DEFAULT_RSI_APPROACH,
    trigger,
  });

  const restoreGoalFailed = () => {
    const current = getPersonalGoal(ownerId, goalId);
    if (current && current.status === 'pending') {
      patchPersonalGoal(ownerId, goalId, {
        expected_revision: current.revision,
        status: 'failed',
      });
    }
  };

  try {
    patchPersonalGoal(ownerId, goalId, {
      expected_revision: goal.revision,
      status: 'pending',
    });
  } catch (error) {
    finishBranch(ownerId, branch.id, {
      status: 'stopped',
      failKind: null,
      retryable: null,
    });
    throw error;
  }

  let triggered: { success: boolean; error?: string; runId?: string };
  try {
    triggered = deps.triggerTaskRun(
      taskRow.id,
      `rsi:${goalId}:${branch.id}`,
    );
  } catch (error) {
    finishBranch(ownerId, branch.id, {
      status: 'stopped',
      failKind: null,
      retryable: null,
    });
    restoreGoalFailed();
    throw error;
  }

  if (!triggered.success || !triggered.runId) {
    finishBranch(ownerId, branch.id, {
      status: 'stopped',
      failKind: null,
      retryable: null,
    });
    restoreGoalFailed();
    throw new Error(triggered.error || 'Failed to start retry task run');
  }

  try {
    return attachRun(ownerId, branch.id, triggered.runId);
  } catch (error) {
    finishBranch(ownerId, branch.id, {
      status: 'stopped',
      failKind: null,
      retryable: null,
    });
    restoreGoalFailed();
    throw error;
  }
}
