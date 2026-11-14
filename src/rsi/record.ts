import { logger } from '../logger.js';
import type { DurableFailure } from '../personal-agent/durable-failure.js';
import {
  getPersonalGoal,
  recordPersonalGoalEvent,
  type PersonalGoal,
} from '../personal-agent/goal-store.js';
import { productInputFailure } from '../personal-agent/product-runtime-store.js';
import {
  beginRetry,
  finishBranch,
  listBranches,
  rsiDb,
} from './branch-store.js';
import { decideRetry, type RetryDecision } from './failure-gate.js';
import { markMatchingSnapshotMethodsFailed } from './method-store.js';
import { getAutoRetry } from './settings.js';

export const MAX_RSI_BRANCHES = 3;

const UNKNOWN_FAILURE: DurableFailure = {
  kind: 'unknown',
  retryable: true,
  status: null,
  message: '',
  hint: '',
};

export function readRunFailure(runId: string | null | undefined): DurableFailure {
  if (!runId) return UNKNOWN_FAILURE;
  const row = rsiDb()
    .prepare(
      `SELECT failure_json
       FROM product_session_inputs
       WHERE (json_extract(payload, '$.execution.runId') = ? OR request_id = ?)
         AND state = 'failed'
         AND failure_json IS NOT NULL
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(runId, `goal-run:${runId}`) as { failure_json: string | null } | undefined;
  if (!row) return UNKNOWN_FAILURE;
  return productInputFailure(row) ?? UNKNOWN_FAILURE;
}

export function latestGoalRunId(goalId: string): string | null {
  const row = rsiDb()
    .prepare(
      `SELECT r.id
       FROM task_runs r
       JOIN personal_goal_tasks gt ON gt.task_id = r.task_id
       WHERE gt.goal_id = ?
       ORDER BY r.created_at DESC, r.rowid DESC
       LIMIT 1`,
    )
    .get(goalId) as { id: string } | undefined;
  if (row) return row.id;
  const charged = rsiDb()
    .prepare(
      'SELECT run_id FROM personal_goal_charges WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(goalId) as { run_id: string } | undefined;
  return charged?.run_id ?? null;
}

function priorFailureKindBeforeRun(
  goalId: string,
  runId: string | null,
): string | null {
  const rows = rsiDb()
    .prepare(
      "SELECT detail FROM personal_goal_events WHERE goal_id = ? AND kind = 'rsi_decision' ORDER BY id DESC LIMIT 10",
    )
    .all(goalId) as { detail: string }[];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.detail) as {
        run_id?: string | null;
        fail_kind?: string | null;
      };
      if (runId === null || parsed.run_id !== runId) {
        return parsed.fail_kind ?? null;
      }
    } catch {
      // Ignore malformed legacy event payloads.
    }
  }
  return null;
}

export function evaluateGoalRetry(
  goal: Pick<
    PersonalGoal,
    'id' | 'owner_user_id' | 'budget_used_runs' | 'budget_max_runs'
  >,
  runId: string | null,
  failureOverride?: DurableFailure,
): { decision: RetryDecision; failure: DurableFailure } {
  const failure = failureOverride ?? readRunFailure(runId);
  const branches = listBranches(goal.owner_user_id, goal.id);
  const matchingIndex = runId
    ? branches.findIndex((branch) => branch.run_id === runId)
    : -1;

  const priorFromEvent = priorFailureKindBeforeRun(goal.id, runId);
  const priorFromBranches =
    (matchingIndex >= 0 ? branches.slice(0, matchingIndex) : branches)
      .map((branch) => branch.fail_kind)
      .filter((kind): kind is string => kind !== null)
      .at(-1) ?? null;
  const lastFailKind = priorFromEvent ?? priorFromBranches;

  let previous: { fail_kind: string | null }[];
  if (branches.length > 0) {
    previous = branches.map((branch, index) =>
      index === branches.length - 1
        ? { fail_kind: lastFailKind }
        : { fail_kind: branch.fail_kind },
    );
  } else {
    previous = lastFailKind !== null ? [{ fail_kind: lastFailKind }] : [];
  }

  const decision = decideRetry({
    failure,
    previous,
    budgetUsed: goal.budget_used_runs,
    budgetMax: goal.budget_max_runs,
    maxBranches: MAX_RSI_BRANCHES,
  });
  return { decision, failure };
}

export function finishActiveBranchForRun(
  goalId: string,
  runId: string,
  outcome: {
    status: 'succeeded' | 'failed' | 'stopped';
    failKind: string | null;
    retryable: boolean | null;
  },
): void {
  const row = rsiDb()
    .prepare(
      "SELECT id, owner_user_id FROM rsi_branches WHERE goal_id = ? AND run_id = ? AND status = 'running' LIMIT 1",
    )
    .get(goalId, runId) as { id: string; owner_user_id: string } | undefined;
  if (!row) return;
  finishBranch(row.owner_user_id, row.id, outcome);
}

export function recordFailureDecision(goalId: string, runId: string): void {
  const ownerRow = rsiDb()
    .prepare('SELECT owner_user_id FROM personal_goals WHERE id = ?')
    .get(goalId) as { owner_user_id: string } | undefined;
  if (!ownerRow) return;
  const goal = getPersonalGoal(ownerRow.owner_user_id, goalId);
  if (!goal) return;

  const failure = readRunFailure(runId);
  finishActiveBranchForRun(goalId, runId, {
    status: 'failed',
    failKind: failure.kind,
    retryable: failure.retryable,
  });

  try {
    markMatchingSnapshotMethodsFailed(goalId, runId, failure.kind);
  } catch (error) {
    logger.warn(
      { error, goalId, runId },
      'Failed to update RSI method verification status after failure',
    );
  }

  const { decision } = evaluateGoalRetry(goal, runId, failure);
  recordPersonalGoalEvent(goalId, 'rsi_decision', {
    run_id: runId,
    action: decision.action,
    reason: decision.action === 'stop' ? decision.reason : null,
    fail_kind: failure.kind,
    retryable: failure.retryable,
  });

  if (decision.action === 'allow' && getAutoRetry(goal.workspace_jid)) {
    const autoApproach =
      `避开上一次的失败类别：${failure.kind}，改用不同的步骤完成同一目标`.slice(
        0,
        200,
      );
    try {
      beginRetry(goal.owner_user_id, goalId, 'auto', autoApproach);
    } catch (error) {
      recordPersonalGoalEvent(goalId, 'rsi_retry_error', {
        run_id: runId,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to start auto retry',
      });
    }
  }
}
