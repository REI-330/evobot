import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { PersonalGoalExecutionSnapshot } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-snapshot-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'rsi-snapshot-test-secret',
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const goals = await import('../src/personal-agent/goal-store.js');
const goalContext = await import('../src/personal-agent/goal-context.js');
const productRuntimeStore = await import(
  '../src/personal-agent/product-runtime-store.js'
);
const { classifyDurableFailure } = await import(
  '../src/personal-agent/durable-failure.js'
);
const rsiBranches = await import('../src/rsi/branch-store.js');
const rsiMethods = await import('../src/rsi/method-store.js');
const webContext = await import('../src/web-context.js');
await import('../src/web.js');
const goalRoutes = (await import('../src/routes/goals.js')).default;
const pmRoutes = (await import('../src/routes/personal-memory.js')).default;

const cookies = new Map<string, string>();
const homeJid = 'web:alice-home';
const projectJid = 'web:alice-project';

const trigger =
  vi.fn<
    (
      id: string,
      key?: string,
    ) => { success: boolean; runId?: string; error?: string }
  >();

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: 'unit-test-hash',
    display_name: 'alice',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const token = auth.generateSessionToken();
  db.createUserSession({
    id: token,
    user_id: 'alice',
    ip_address: null,
    user_agent: null,
    created_at: now,
    last_active_at: now,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  cookies.set('alice', `evobot_session=${auth.signSessionToken(token)}`);
  db.setRegisteredGroup(homeJid, {
    name: 'Alice Home',
    folder: 'alice-home',
    created_by: 'alice',
    executionMode: 'host',
    is_home: true,
    added_at: now,
  });
  db.setRegisteredGroup(projectJid, {
    name: 'Alice Project',
    folder: 'alice-project',
    created_by: 'alice',
    executionMode: 'host',
    is_home: false,
    added_at: now,
  });
  webContext.setWebDeps({
    triggerTaskRun: trigger,
    cancelTaskRun: vi.fn(() => ({ success: true })),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  vi.stubEnv('EVOBOT_PERSONAL_GOALS', 'true');
  vi.stubEnv('EVOBOT_PERSONAL_MEMORY', 'true');
  trigger.mockImplementation((id, key) => {
    const reason = goals.personalGoalTaskBlockReason(id);
    if (reason) return { success: false, error: reason };
    const task = db.getTaskById(id)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: key,
    });
    const claim = db.claimNextTaskRun('rsi-snapshot-test', 60_000);
    if (claim && claim.id === created.run.id) {
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
    }
    return { success: true, runId: created.run.id };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function setupGoal(input: {
  objective: string;
  criteria?: string[];
  nextAction?: string;
  budget?: number;
}) {
  const goal = goals.createPersonalGoal('alice', randomUUID(), {
    workspace_jid: projectJid,
    objective: input.objective,
    completion_criteria: input.criteria ?? ['artifact_contains:OK'],
    next_action: input.nextAction ?? '执行验证步骤',
    budget_max_runs: input.budget ?? 5,
  });
  const taskId = randomUUID();
  db.createTask({
    id: taskId,
    group_folder: 'alice-project',
    chat_jid: projectJid,
    prompt: 'Run',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'host',
    next_run: new Date().toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: 'alice',
  });
  goals.linkPersonalGoalTask('alice', goal.id, taskId, goal.revision);
  goals.markAutomaticGoalTask(goal.id, taskId);
  const sessionId = randomUUID();
  db.createAgent(
    {
      id: sessionId,
      group_folder: 'alice-project',
      chat_jid: projectJid,
      name: 'Goal Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'alice',
      created_at: new Date().toISOString(),
    },
    {
      kind: 'pi-durable',
      providerId: 'test-provider',
      configFingerprint: 'test-fp',
      goalId: goal.id,
    },
  );
  goals.attachAutomaticGoalSession('alice', goal.id, sessionId);
  return { goal: goals.getPersonalGoal('alice', goal.id)!, task: db.getTaskById(taskId)!, sessionId };
}

function startRunWithSnapshot(
  task: NonNullable<ReturnType<typeof db.getTaskById>>,
  sessionId: string,
  goalId: string,
) {
  const run = db.createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey: randomUUID(),
  }).run;
  const claim = db.claimNextTaskRun('rsi-snapshot-runner', 60_000)!;
  expect(claim.id).toBe(run.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  const ctxRow = rsiBranches
    .rsiDb()
    .prepare('SELECT snapshot FROM goal_execution_contexts WHERE run_id = ?')
    .get(run.id) as { snapshot: string };
  const snapshot = JSON.parse(ctxRow.snapshot) as PersonalGoalExecutionSnapshot;
  return { run, claim, snapshot, sessionId, goalId };
}

function failClaimedRun(
  claim: NonNullable<ReturnType<typeof db.claimNextTaskRun>>,
  sessionId: string,
  goalId: string,
  snapshotDigest: string,
  reason: string,
  detail: string | null,
) {
  const admitted = productRuntimeStore.admitProductInput(
    sessionId,
    `goal-run:${claim.id}`,
    {
      sender: 'alice',
      senderName: 'Personal Goal',
      content: 'run',
      execution: {
        goalId,
        runId: claim.id,
        contextDigest: snapshotDigest,
      },
    },
    () => undefined,
  );
  productRuntimeStore.finishProductInput(
    admitted.id,
    false,
    () => undefined,
    classifyDurableFailure(reason, detail),
  );
  expect(
    goals.failPersonalGoalRun(claim.id, () =>
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'failed',
        error: detail ?? reason,
        notificationStatus: 'skipped',
      }),
    ),
  ).toBe(true);
}

describe('RSI M4 snapshot and method lifecycle', () => {
  test('1. manual retry without approach returns 400', async () => {
    const { goal, task, sessionId } = setupGoal({ objective: '缺少 approach 校验' });
    const started = startRunWithSnapshot(task, sessionId, goal.id);
    failClaimedRun(
      started.claim,
      sessionId,
      goal.id,
      started.snapshot.content_digest,
      'model_error',
      '429 rate limit',
    );

    const missingBody = await goalRoutes.request(`/${goal.id}/retry`, {
      method: 'POST',
      headers: { cookie: cookies.get('alice')! },
    });
    expect(missingBody.status).toBe(400);

    const emptyApproach = await goalRoutes.request(`/${goal.id}/retry`, {
      method: 'POST',
      headers: {
        cookie: cookies.get('alice')!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ approach: '   ' }),
    });
    expect(emptyApproach.status).toBe(400);
  });

  test('2. retry approach enters new run snapshot and matches rsi_branches.approach', async () => {
    const { goal, task, sessionId } = setupGoal({ objective: '重试做法注入快照' });
    const started = startRunWithSnapshot(task, sessionId, goal.id);
    failClaimedRun(
      started.claim,
      sessionId,
      goal.id,
      started.snapshot.content_digest,
      'model_error',
      '429 too many requests',
    );

    const customApproach = '先拆分为两个子请求再汇总结果';
    const retryRes = await goalRoutes.request(`/${goal.id}/retry`, {
      method: 'POST',
      headers: {
        cookie: cookies.get('alice')!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ approach: customApproach }),
    });
    expect(retryRes.status).toBe(201);
    const retryBody = (await retryRes.json()) as {
      branch: { approach: string; run_id: string };
    };
    expect(retryBody.branch.approach).toBe(customApproach);

    const retryCtxRow = rsiBranches
      .rsiDb()
      .prepare('SELECT snapshot FROM goal_execution_contexts WHERE run_id = ?')
      .get(retryBody.branch.run_id) as { snapshot: string };
    const snapshot = JSON.parse(
      retryCtxRow.snapshot,
    ) as PersonalGoalExecutionSnapshot;
    expect(snapshot.retry_approach).toBe(customApproach);
    const rendered = JSON.parse(
      goalContext.renderGoalStep(snapshot, retryBody.branch.run_id, false),
    ) as { context: PersonalGoalExecutionSnapshot };
    expect(rendered.context.retry_approach).toBe(customApproach);
  });

  test('3 & 4. unconfirmed methods stay out of snapshot; confirmed methods enter up to 3 and increment use_count on completion', async () => {
    // Create 4 user_correction methods; leave #1 unconfirmed, confirm #2-#5
    const createdIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = rsiMethods.createMethodFromUserCorrection({
        ownerId: 'alice',
        workspaceJid: projectJid,
        sessionId: 's-methods',
        messageId: `m-${i}-${randomUUID()}`,
        score: -1,
        comment: `第${i}条经验做法：遇到同类报错时先核对输入再执行`,
      });
      expect(res.method).toBeTruthy();
      createdIds.push(res.method!.memory_item_id);
    }

    // Confirm only the last 3 (#1..#3) -> #0 remains proposed
    for (const itemId of createdIds.slice(1)) {
      const confirmRes = await pmRoutes.request(`/${itemId}/confirm`, {
        method: 'POST',
        headers: { cookie: cookies.get('alice')! },
      });
      expect(confirmRes.status).toBe(200);
    }

    // Add one more confirmed method so there are 4 confirmed methods total
    const extra = rsiMethods.createMethodFromUserCorrection({
      ownerId: 'alice',
      workspaceJid: projectJid,
      sessionId: 's-methods',
      messageId: `m-extra-${randomUUID()}`,
      score: -1,
      comment: '第四条已确认的做法：先读取目标目录再创建文件',
    });
    expect(
      (
        await pmRoutes.request(`/${extra.method!.memory_item_id}/confirm`, {
          method: 'POST',
          headers: { cookie: cookies.get('alice')! },
        })
      ).status,
    ).toBe(200);

    const { goal, task, sessionId } = setupGoal({
      objective: '验证快照只取最多3条已确认方法',
      criteria: ['artifact_contains:PASS_METHODS'],
    });
    const started = startRunWithSnapshot(task, sessionId, goal.id);
    const snapshot = started.snapshot;

    expect(snapshot.methods).toBeDefined();
    expect(snapshot.methods!.length).toBeLessThanOrEqual(3);
    expect(snapshot.methods!.length).toBe(3);
    // Unconfirmed #0 must not appear in snapshot
    const unconfirmedMethod = rsiMethods.getRsiMethodByMemoryItemId(
      'alice',
      createdIds[0],
    )!;
    expect(
      snapshot.methods!.some((m) => m.id === unconfirmedMethod.id),
    ).toBe(false);

    const stepJson = goalContext.renderGoalStep(snapshot, started.run.id, false);
    expect(stepJson).toContain(
      '如果下面给出了已验证的做法，优先沿用；做不到时说明原因，不要假装沿用了。',
    );

    // Complete the run and verify use_count + last_used_at increment
    const usedIds = snapshot.methods!.map((m) => m.id);
    const settled = goals.settlePersonalGoalExecution(
      {
        runId: started.run.id,
        sessionId,
        leaseOwner: started.claim.lease_owner,
        leaseToken: started.claim.lease_token,
        modelCompleted: true,
        evidence: [
          {
            artifact_id: randomUUID(),
            content_digest: 'sha256-ok',
            criteria_matches: [true],
          },
        ],
      },
      () =>
        db.completeTaskRun(
          started.claim.id,
          started.claim.lease_owner,
          started.claim.lease_token,
          { status: 'success', result: 'done', notificationStatus: 'skipped' },
        ),
      () => undefined,
    );
    expect(settled).toBe(true);

    for (const id of usedIds) {
      const row = rsiBranches
        .rsiDb()
        .prepare('SELECT use_count, last_used_at FROM rsi_methods WHERE id = ?')
        .get(id) as { use_count: number; last_used_at: string | null };
      expect(row.use_count).toBe(1);
      expect(row.last_used_at).toBeTruthy();
    }
  });

  test('5. method in snapshot matching fail_kind template becomes verification=failed while incidental word match is untouched', async () => {
    const corr = rsiMethods.createMethodFromUserCorrection({
      ownerId: 'alice',
      workspaceJid: projectJid,
      sessionId: 's-fail-kind',
      messageId: `m-fail-${randomUUID()}`,
      score: -1,
      comment: '避开上一次的失败类别：provider，改用轻量请求参数',
    });
    const incidental = rsiMethods.createMethodFromUserCorrection({
      ownerId: 'alice',
      workspaceJid: projectJid,
      sessionId: 's-fail-kind',
      messageId: `m-incidental-${randomUUID()}`,
      score: -1,
      comment: '先检查 provider 配置并打印上下文后再执行任务',
    });
    const itemId = corr.method!.memory_item_id;
    const methodId = corr.method!.id;
    const incidentalItemId = incidental.method!.memory_item_id;
    const incidentalMethodId = incidental.method!.id;
    for (const id of [itemId, incidentalItemId]) {
      expect(
        (
          await pmRoutes.request(`/${id}/confirm`, {
            method: 'POST',
            headers: {
              cookie: cookies.get('alice')!,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ workspace_jid: projectJid }),
          })
        ).status,
      ).toBe(200);
    }

    // Ensure both newly confirmed methods (last_used_at IS NULL) enter the next snapshot
    const g1 = setupGoal({ objective: '验证同类失败停用' });
    const s1 = startRunWithSnapshot(g1.task, g1.sessionId, g1.goal.id);
    expect(s1.snapshot.methods?.some((m) => m.id === methodId)).toBe(true);
    expect(s1.snapshot.methods?.some((m) => m.id === incidentalMethodId)).toBe(true);

    // Fail g1 with 'provider' failure (model_error)
    failClaimedRun(
      s1.claim,
      g1.sessionId,
      g1.goal.id,
      s1.snapshot.content_digest,
      'model_error',
      '429 rate limit',
    );

    const afterFail = rsiMethods.getRsiMethodByMemoryItemId('alice', itemId)!;
    expect(afterFail.verification).toBe('failed');
    expect(afterFail.verified_at).toBeTruthy();

    // Incidental mention of "provider" without the template prefix must remain active/unfailed
    const incidentalAfter = rsiMethods.getRsiMethodByMemoryItemId(
      'alice',
      incidentalItemId,
    )!;
    expect(incidentalAfter.verification).toBe('none');

    // Next Goal snapshot must exclude the failed method while keeping the incidental one
    const g2 = setupGoal({ objective: '下一次目标不应包含已失败方法' });
    const s2 = goals.snapshotPersonalGoalExecution(g2.task.id)!;
    expect(s2.methods?.some((m) => m.id === methodId) ?? false).toBe(false);
    expect(s2.methods?.some((m) => m.id === incidentalMethodId)).toBe(true);

    // Reverify resets verification back to 'passed'
    const reverifyRes = await pmRoutes.request(`/${itemId}/reverify`, {
      method: 'POST',
      headers: { cookie: cookies.get('alice')! },
    });
    expect(reverifyRes.status).toBe(200);
    expect(
      rsiMethods.getRsiMethodByMemoryItemId('alice', itemId)!.verification,
    ).toBe('passed');

    // Calling reverify again when not 'failed' returns 409
    expect(
      (
        await pmRoutes.request(`/${itemId}/reverify`, {
          method: 'POST',
          headers: { cookie: cookies.get('alice')! },
        })
      ).status,
    ).toBe(409);
  });

  test('6. oversized methods are dropped from snapshot/renderGoalStep while preserving completion_criteria', () => {
    const snapshot: PersonalGoalExecutionSnapshot = {
      goal_id: randomUUID(),
      goal_revision: 1,
      owner_user_id: 'alice',
      workspace_jid: projectJid,
      session_id: randomUUID(),
      objective: '超长方法不截断完成条件',
      completion_criteria: ['artifact_contains:KEEP_CRITERION_INTACT'],
      next_action: '完成核心输出',
      content_digest: 'digest',
      budget_remaining_runs: 3,
      capabilities: ['inspect_text'],
      delivery: 'session_and_workspace',
      previous_results: [],
      methods: [
        {
          id: 'm-1',
          approach: '短做法',
          criteria: ['artifact_contains:SHORT'],
        },
        {
          id: 'm-2',
          approach: 'x'.repeat(200),
          criteria: ['y'.repeat(35000)],
        },
      ],
    };

    expect(() => goalContext.assertCloudGoalBase(snapshot)).not.toThrow();
    const rendered = JSON.parse(
      goalContext.renderGoalStep(snapshot, randomUUID(), true),
    ) as { context: PersonalGoalExecutionSnapshot };
    expect(rendered.context.completion_criteria).toEqual([
      'artifact_contains:KEEP_CRITERION_INTACT',
    ]);
    expect(rendered.context.methods?.some((m) => m.id === 'm-2')).toBeFalsy();
  });

  test('7. confirming a proposed goal_completed method grants source non-home workspace at new revision, enters snapshot, and use_count increments only when criteria are satisfied', async () => {
    // Clear existing methods for alice so only our two test methods are selected
    rsiBranches
      .rsiDb()
      .prepare("DELETE FROM rsi_methods WHERE owner_user_id = 'alice'")
      .run();

    // Create two completed Goals in projectJid (non-home workspace) with distinct criteria
    const makeCompletedMethodGoal = (token: string, nextAction: string) => {
      const g = setupGoal({
        objective: `生成含 ${token} 的产物`,
        criteria: [`artifact_contains:${token}`],
        nextAction,
      });
      const started = startRunWithSnapshot(g.task, g.sessionId, g.goal.id);
      const settled = goals.settlePersonalGoalExecution(
        {
          runId: started.run.id,
          sessionId: g.sessionId,
          leaseOwner: started.claim.lease_owner,
          leaseToken: started.claim.lease_token,
          modelCompleted: true,
          evidence: [
            {
              artifact_id: randomUUID(),
              content_digest: 'sha256-seed',
              criteria_matches: [true],
            },
          ],
        },
        () =>
          db.completeTaskRun(
            started.claim.id,
            started.claim.lease_owner,
            started.claim.lease_token,
            { status: 'success', result: 'ok', notificationStatus: 'skipped' },
          ),
        () => undefined,
      );
      expect(settled).toBe(true);
      return rsiMethods.getRsiMethodForGoal('alice', g.goal.id)!;
    };

    const matchedMethod = makeCompletedMethodGoal(
      'MATCHED_METHOD_TOKEN',
      '输出含 MATCHED_METHOD_TOKEN 的结果',
    );
    const unmatchedMethod = makeCompletedMethodGoal(
      'UNMATCHED_METHOD_TOKEN',
      '输出含 UNMATCHED_METHOD_TOKEN 的结果',
    );

    // Before confirm: neither is in snapshot
    const probeBefore = setupGoal({ objective: '确认前不应进快照' });
    expect(goals.snapshotPersonalGoalExecution(probeBefore.task.id)!.methods).toBeUndefined();

    // Confirm both (once, from proposed -> active) and verify personal_memory_grants revision matches new revision
    for (const method of [matchedMethod, unmatchedMethod]) {
      const res = await pmRoutes.request(`/${method.memory_item_id}/confirm`, {
        method: 'POST',
        headers: { cookie: cookies.get('alice')! },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entry: {
          item: { status: string; revision: number };
          allowed_workspaces: string[];
        };
      };
      expect(body.entry.item.status).toBe('active');
      expect(body.entry.allowed_workspaces).toContain(projectJid);

      const grantRow = rsiBranches
        .rsiDb()
        .prepare(
          'SELECT workspace_jid, approved_revision FROM personal_memory_grants WHERE item_id = ?',
        )
        .get(method.memory_item_id) as
        | { workspace_jid: string; approved_revision: number }
        | undefined;
      expect(grantRow).toEqual({
        workspace_jid: projectJid,
        approved_revision: body.entry.item.revision,
      });
    }

    // Next Goal in projectJid MUST include both confirmed methods in its snapshot
    const consumer = setupGoal({
      objective: '验证确认后立即进入非 Home 工作区快照且仅满足条件者计入使用次数',
      criteria: ['artifact_contains:MATCHED_METHOD_TOKEN'],
    });
    const consumerRun = startRunWithSnapshot(
      consumer.task,
      consumer.sessionId,
      consumer.goal.id,
    );
    expect(consumerRun.snapshot.methods?.map((m) => m.id)).toEqual(
      expect.arrayContaining([matchedMethod.id, unmatchedMethod.id]),
    );

    // Complete consumer Goal with criteria matching ONLY MATCHED_METHOD_TOKEN
    const settled = goals.settlePersonalGoalExecution(
      {
        runId: consumerRun.run.id,
        sessionId: consumer.sessionId,
        leaseOwner: consumerRun.claim.lease_owner,
        leaseToken: consumerRun.claim.lease_token,
        modelCompleted: true,
        evidence: [
          {
            artifact_id: randomUUID(),
            content_digest: 'sha256-consumer',
            criteria_matches: [true],
          },
        ],
      },
      () =>
        db.completeTaskRun(
          consumerRun.claim.id,
          consumerRun.claim.lease_owner,
          consumerRun.claim.lease_token,
          { status: 'success', result: 'ok', notificationStatus: 'skipped' },
        ),
      () => undefined,
    );
    expect(settled).toBe(true);

    const matchedAfter = rsiBranches
      .rsiDb()
      .prepare('SELECT use_count, last_used_at FROM rsi_methods WHERE id = ?')
      .get(matchedMethod.id) as { use_count: number; last_used_at: string | null };
    const unmatchedAfter = rsiBranches
      .rsiDb()
      .prepare('SELECT use_count, last_used_at FROM rsi_methods WHERE id = ?')
      .get(unmatchedMethod.id) as { use_count: number; last_used_at: string | null };

    expect(matchedAfter.use_count).toBe(1);
    expect(matchedAfter.last_used_at).toBeTruthy();
    expect(unmatchedAfter.use_count).toBe(0);
    expect(unmatchedAfter.last_used_at).toBeNull();
  });
});
