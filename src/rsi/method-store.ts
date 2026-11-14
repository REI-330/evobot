import { randomUUID } from 'node:crypto';
import { getPersonalGoal } from '../personal-agent/goal-store.js';
import {
  confirmPersonalMemoryMethodEntry,
  createUnconfirmedPersonalMemoryEntry,
  PersonalMemoryError,
} from '../personal-agent/personal-memory-store.js';
import type { PersonalGoalExecutionSnapshot } from '../types.js';
import { rsiDb } from './schema.js';

export const MAX_RSI_METHODS_PER_USER = 50;
export const MAX_SNAPSHOT_METHODS = 3;
export const MAX_SNAPSHOT_METHODS_CHARS = 1500;

export type RsiMethodSourceKind = 'goal_completed' | 'user_correction';
export type RsiMethodVerification = 'none' | 'passed' | 'failed';

export interface RsiMethod {
  id: string;
  owner_user_id: string;
  memory_item_id: string;
  source_goal_id: string | null;
  source_run_id: string | null;
  source_kind: RsiMethodSourceKind;
  approach: string;
  verification: RsiMethodVerification;
  verified_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
}

export interface RsiMethodMetadata {
  id: string;
  source_kind: RsiMethodSourceKind;
  source_goal_id: string | null;
  source_goal_objective: string | null;
  verification: RsiMethodVerification;
  verified_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

export interface SnapshotRsiMethod {
  id: string;
  approach: string;
  criteria: string[];
}

export function isDeterministicCriteria(criteria: readonly string[]): boolean {
  return (
    criteria.length > 0 &&
    criteria.every(
      (criterion) =>
        criterion.startsWith('artifact_contains:') &&
        criterion.slice('artifact_contains:'.length).trim().length > 0,
    )
  );
}

export function countRsiMethods(ownerUserId: string): number {
  const row = rsiDb()
    .prepare('SELECT COUNT(*) AS n FROM rsi_methods WHERE owner_user_id = ?')
    .get(ownerUserId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function getRsiMethodByMemoryItemId(
  ownerUserId: string,
  memoryItemId: string,
): RsiMethod | undefined {
  return rsiDb()
    .prepare(
      'SELECT * FROM rsi_methods WHERE owner_user_id = ? AND memory_item_id = ?',
    )
    .get(ownerUserId, memoryItemId) as RsiMethod | undefined;
}

export function getRsiMethodForGoal(
  ownerUserId: string,
  goalId: string,
): (RsiMethod & { memory_status: string }) | undefined {
  return rsiDb()
    .prepare(
      `SELECT m.*, i.status AS memory_status
       FROM rsi_methods m
       JOIN workspace_memory_items i ON i.id = m.memory_item_id
       WHERE m.owner_user_id = ? AND m.source_goal_id = ? AND i.status != 'deleted'
       ORDER BY m.created_at DESC
       LIMIT 1`,
    )
    .get(ownerUserId, goalId) as
    | (RsiMethod & { memory_status: string })
    | undefined;
}

export function listRsiMethodsMetadataByItem(
  ownerUserId: string,
): Map<string, RsiMethodMetadata> {
  const rows = rsiDb()
    .prepare(
      `SELECT m.id, m.memory_item_id, m.source_kind, m.source_goal_id,
              g.objective AS source_goal_objective,
              m.verification, m.verified_at, m.last_used_at, m.use_count
       FROM rsi_methods m
       LEFT JOIN personal_goals g ON g.id = m.source_goal_id
       WHERE m.owner_user_id = ?`,
    )
    .all(ownerUserId) as Array<RsiMethodMetadata & { memory_item_id: string }>;
  const map = new Map<string, RsiMethodMetadata>();
  for (const row of rows) {
    const { memory_item_id, ...meta } = row;
    map.set(memory_item_id, meta);
  }
  return map;
}

export function listPendingRsiMethodGoalIds(ownerUserId: string): Set<string> {
  const rows = rsiDb()
    .prepare(
      `SELECT m.source_goal_id
       FROM rsi_methods m
       JOIN workspace_memory_items i ON i.id = m.memory_item_id
       WHERE m.owner_user_id = ?
         AND m.source_goal_id IS NOT NULL
         AND i.status = 'proposed'`,
    )
    .all(ownerUserId) as Array<{ source_goal_id: string }>;
  return new Set(rows.map((row) => row.source_goal_id));
}

export function createMethodFromCompletedGoal(
  goalId: string,
  runId: string,
): { method: RsiMethod | null; full: boolean } {
  const ownerRow = rsiDb()
    .prepare('SELECT owner_user_id FROM personal_goals WHERE id = ?')
    .get(goalId) as { owner_user_id: string } | undefined;
  if (!ownerRow) return { method: null, full: false };

  const goal = getPersonalGoal(ownerRow.owner_user_id, goalId);
  if (!goal || goal.status !== 'completed') {
    return { method: null, full: false };
  }
  if (!isDeterministicCriteria(goal.completion_criteria)) {
    return { method: null, full: false };
  }

  const existing = rsiDb()
    .prepare('SELECT id FROM rsi_methods WHERE source_goal_id = ? LIMIT 1')
    .get(goal.id);
  if (existing) return { method: null, full: false };

  const branchRow = rsiDb()
    .prepare(
      `SELECT approach FROM rsi_branches
       WHERE goal_id = ? AND run_id = ? AND status = 'succeeded'
       ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(goal.id, runId) as { approach: string } | undefined;
  const rawApproach = (branchRow?.approach ?? goal.next_action ?? '').trim();
  const approach = rawApproach.slice(0, 200).trim();
  if (!approach) return { method: null, full: false };

  if (countRsiMethods(goal.owner_user_id) >= MAX_RSI_METHODS_PER_USER) {
    return { method: null, full: true };
  }

  const title = goal.objective.trim().slice(0, 80) || 'Goal 方法';
  const content = [
    `适用情况：${goal.objective.trim()}`,
    `做法：${approach}`,
    `验证：${goal.completion_criteria.join('；')}`,
    `来源：Goal ${goal.id} / Run ${runId}`,
  ].join('\n');

  const method = rsiDb().transaction(() => {
    const dup = rsiDb()
      .prepare('SELECT * FROM rsi_methods WHERE source_goal_id = ? LIMIT 1')
      .get(goal.id) as RsiMethod | undefined;
    if (dup) return dup;

    const { entry } = createUnconfirmedPersonalMemoryEntry({
      ownerId: goal.owner_user_id,
      key: `goal:${goal.id}`,
      title,
      content,
      kind: 'lesson',
      sourceGoalId: goal.id,
      sourceType: 'agent_runtime',
      sourceId: `rsi:goal:${goal.workspace_jid}:${goal.id}:${runId}`,
      sessionId: goal.session_id,
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    rsiDb()
      .prepare(
        `INSERT INTO rsi_methods (
          id, owner_user_id, memory_item_id, source_goal_id, source_run_id,
          source_kind, approach, verification, verified_at, last_used_at, use_count, created_at
        ) VALUES (?, ?, ?, ?, ?, 'goal_completed', ?, 'passed', ?, NULL, 0, ?)`,
      )
      .run(id, goal.owner_user_id, entry.item.id, goal.id, runId, approach, now, now);

    return rsiDb()
      .prepare('SELECT * FROM rsi_methods WHERE id = ?')
      .get(id) as RsiMethod;
  })();

  return { method, full: false };
}

export function createMethodFromUserCorrection(input: {
  ownerId: string;
  workspaceJid: string;
  sessionId: string;
  messageId: string;
  score: number;
  comment: string | null;
}): { method: RsiMethod | null; full: boolean } {
  if (input.score !== -1) return { method: null, full: false };
  const rawComment = (input.comment ?? '').trim();
  const nonWhitespaceCount = rawComment.replace(/\s+/g, '').length;
  if (nonWhitespaceCount < 8) return { method: null, full: false };

  const sourceId = `rsi:user_correction:${encodeURIComponent(input.workspaceJid)}:${encodeURIComponent(input.messageId)}`;
  const alreadyCreated = rsiDb()
    .prepare(
      `SELECT m.id FROM rsi_methods m
       JOIN workspace_memory_provenance p ON p.item_id = m.memory_item_id AND p.revision = 1
       WHERE m.owner_user_id = ? AND p.source_id = ?
       LIMIT 1`,
    )
    .get(input.ownerId, sourceId);
  if (alreadyCreated) return { method: null, full: false };

  if (countRsiMethods(input.ownerId) >= MAX_RSI_METHODS_PER_USER) {
    return { method: null, full: true };
  }

  const content = rawComment.slice(0, 500);
  const approach = rawComment.slice(0, 200).trim();
  if (!approach) return { method: null, full: false };

  const method = rsiDb().transaction(() => {
    const dup = rsiDb()
      .prepare(
        `SELECT m.* FROM rsi_methods m
         JOIN workspace_memory_provenance p ON p.item_id = m.memory_item_id AND p.revision = 1
         WHERE m.owner_user_id = ? AND p.source_id = ?
         LIMIT 1`,
      )
      .get(input.ownerId, sourceId) as RsiMethod | undefined;
    if (dup) return dup;

    const { entry } = createUnconfirmedPersonalMemoryEntry({
      ownerId: input.ownerId,
      key: `correction:${input.workspaceJid}:${input.messageId}`,
      title: '用户纠正',
      content,
      kind: 'lesson',
      sourceGoalId: null,
      sourceType: 'web_user',
      sourceId,
      sessionId: input.sessionId,
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    rsiDb()
      .prepare(
        `INSERT INTO rsi_methods (
          id, owner_user_id, memory_item_id, source_goal_id, source_run_id,
          source_kind, approach, verification, verified_at, last_used_at, use_count, created_at
        ) VALUES (?, ?, ?, NULL, NULL, 'user_correction', ?, 'none', NULL, NULL, 0, ?)`,
      )
      .run(id, input.ownerId, entry.item.id, approach, now);

    return rsiDb()
      .prepare('SELECT * FROM rsi_methods WHERE id = ?')
      .get(id) as RsiMethod;
  })();

  return { method, full: false };
}

function resolveMethodSourceWorkspace(
  ownerId: string,
  method: RsiMethod,
): string | null {
  if (method.source_goal_id) {
    const goalRow = rsiDb()
      .prepare(
        'SELECT workspace_jid FROM personal_goals WHERE id = ? AND owner_user_id = ?',
      )
      .get(method.source_goal_id, ownerId) as
      | { workspace_jid: string }
      | undefined;
    if (goalRow?.workspace_jid) return goalRow.workspace_jid;
  }
  const prov = rsiDb()
    .prepare(
      `SELECT source_id, session_id FROM workspace_memory_provenance
       WHERE item_id = ? AND revision = 1`,
    )
    .get(method.memory_item_id) as
    | { source_id: string | null; session_id: string | null }
    | undefined;
  if (prov?.source_id?.startsWith('rsi:user_correction:')) {
    const parts = prov.source_id.split(':');
    if (parts.length >= 4 && parts[2]) {
      try {
        return decodeURIComponent(parts[2]);
      } catch {
        return parts[2];
      }
    }
  }
  if (prov?.session_id) {
    const agentRow = rsiDb()
      .prepare('SELECT chat_jid FROM agents WHERE id = ? AND created_by = ?')
      .get(prov.session_id, ownerId) as { chat_jid: string } | undefined;
    if (agentRow?.chat_jid) return agentRow.chat_jid;
  }
  return null;
}

export function confirmRsiMethod(
  ownerId: string,
  memoryItemId: string,
  idempotencyKey: string,
) {
  const method = getRsiMethodByMemoryItemId(ownerId, memoryItemId);
  if (!method) {
    throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  }
  const sourceWorkspace = resolveMethodSourceWorkspace(ownerId, method);
  const extraWorkspaces = sourceWorkspace ? [sourceWorkspace] : [];
  const confirmed = confirmPersonalMemoryMethodEntry(
    ownerId,
    memoryItemId,
    idempotencyKey,
    extraWorkspaces,
  );
  return { ...confirmed, method };
}

export function reverifyRsiMethod(ownerId: string, memoryItemId: string) {
  return rsiDb().transaction(() => {
    const method = getRsiMethodByMemoryItemId(ownerId, memoryItemId);
    if (!method) {
      throw new PersonalMemoryError('MEMORY_NOT_FOUND');
    }
    if (method.verification !== 'failed') {
      throw new PersonalMemoryError('RSI_REVERIFY_CONFLICT');
    }
    rsiDb()
      .prepare(
        `UPDATE rsi_methods
         SET verification = 'passed', verified_at = NULL
         WHERE id = ? AND owner_user_id = ? AND verification = 'failed'`,
      )
      .run(method.id, ownerId);
    return getRsiMethodByMemoryItemId(ownerId, memoryItemId)!;
  })();
}

export function selectSnapshotMethods(
  ownerId: string,
  workspaceJid: string,
): SnapshotRsiMethod[] {
  const rows = rsiDb()
    .prepare(
      `SELECT m.id, m.approach, sg.completion_criteria AS criteria_json
       FROM rsi_methods m
       JOIN personal_memory_entries e ON e.item_id = m.memory_item_id
       JOIN workspace_memory_items i ON i.id = e.item_id
       JOIN registered_groups h ON h.jid = e.home_workspace_jid AND h.created_by = e.owner_user_id AND h.is_home = 1
       JOIN workspaces hw ON hw.jid = h.jid AND hw.status = 'active' AND hw.owner_user_id = e.owner_user_id
       LEFT JOIN personal_goals sg ON sg.id = m.source_goal_id
       WHERE m.owner_user_id = ?
         AND i.status = 'active'
         AND m.verification != 'failed'
         AND (
           e.home_workspace_jid = ?
           OR EXISTS (
             SELECT 1 FROM personal_memory_grants g
             WHERE g.item_id = i.id AND g.workspace_jid = ? AND g.approved_revision = i.revision
           )
         )
         AND (i.valid_from IS NULL OR julianday(i.valid_from) <= julianday('now'))
         AND (i.valid_until IS NULL OR julianday(i.valid_until) > julianday('now'))
         AND (i.expires_at IS NULL OR julianday(i.expires_at) > julianday('now'))
       ORDER BY (m.last_used_at IS NULL) DESC, m.use_count ASC, m.created_at DESC
       LIMIT ?`,
    )
    .all(ownerId, workspaceJid, workspaceJid, MAX_SNAPSHOT_METHODS) as Array<{
    id: string;
    approach: string;
    criteria_json: string | null;
  }>;

  const selected: SnapshotRsiMethod[] = [];
  for (const row of rows) {
    let criteria: string[] = [];
    if (row.criteria_json) {
      try {
        const parsed = JSON.parse(row.criteria_json) as unknown;
        if (Array.isArray(parsed)) {
          criteria = parsed.filter(
            (item): item is string => typeof item === 'string',
          );
        }
      } catch {
        criteria = [];
      }
    }
    const candidate: SnapshotRsiMethod = {
      id: row.id,
      approach: row.approach,
      criteria,
    };
    const next = [...selected, candidate];
    if (JSON.stringify(next).length > MAX_SNAPSHOT_METHODS_CHARS) {
      break;
    }
    selected.push(candidate);
  }
  return selected;
}

export function recordMethodsUsed(methodIds: readonly string[]): void {
  if (!methodIds.length) return;
  const now = new Date().toISOString();
  const stmt = rsiDb().prepare(
    'UPDATE rsi_methods SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
  );
  rsiDb().transaction(() => {
    for (const id of methodIds) {
      stmt.run(now, id);
    }
  })();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function approachMentionsFailKind(
  approach: string,
  failKind: string,
): boolean {
  const kind = failKind.trim();
  if (!kind) return false;
  if (approach.includes(`失败类别：${kind}`)) return true;
  const tokenPattern = new RegExp(
    `(?:^|[^a-z0-9_])${escapeRegExp(kind)}(?:$|[^a-z0-9_])`,
    'i',
  );
  return tokenPattern.test(approach);
}

export function markMatchingSnapshotMethodsFailed(
  goalId: string,
  runId: string,
  failKind: string,
): number {
  if (!failKind.trim()) return 0;
  const row = rsiDb()
    .prepare(
      'SELECT snapshot FROM goal_execution_contexts WHERE run_id = ? AND goal_id = ?',
    )
    .get(runId, goalId) as { snapshot: string } | undefined;
  if (!row) return 0;

  let snapshot: PersonalGoalExecutionSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot) as PersonalGoalExecutionSnapshot;
  } catch {
    return 0;
  }
  const snapshotMethods = snapshot.methods;
  if (!snapshotMethods?.length) return 0;

  const now = new Date().toISOString();
  let updated = 0;
  rsiDb().transaction(() => {
    for (const item of snapshotMethods) {
      const method = rsiDb()
        .prepare('SELECT id, approach FROM rsi_methods WHERE id = ?')
        .get(item.id) as { id: string; approach: string } | undefined;
      if (!method) continue;
      if (approachMentionsFailKind(method.approach, failKind)) {
        const res = rsiDb()
          .prepare(
            "UPDATE rsi_methods SET verification = 'failed', verified_at = ? WHERE id = ?",
          )
          .run(now, method.id);
        updated += res.changes;
      }
    }
  })();
  return updated;
}
