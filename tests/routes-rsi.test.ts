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
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-rsi-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'rsi-routes-test-signing-secret',
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const productRuntimeStore = await import(
  '../src/personal-agent/product-runtime-store.js'
);
const { classifyDurableFailure } = await import(
  '../src/personal-agent/durable-failure.js'
);
const rsiBranches = await import('../src/rsi/branch-store.js');
const auth = await import('../src/auth.js');
const webContext = await import('../src/web-context.js');
await import('../src/web.js');
const routes = (await import('../src/routes/goals.js')).default;

const cookies = new Map<string, string>();
const trigger =
  vi.fn<
    (
      id: string,
      key?: string,
    ) => { success: boolean; runId?: string; error?: string }
  >();
const cancel = vi.fn<(id: string) => { success: boolean; error?: string }>();

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
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: null,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    cookies.set(id, `evobot_session=${auth.signSessionToken(token)}`);
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'container',
      is_home: false,
      added_at: new Date().toISOString(),
    });
  }
  webContext.setWebDeps({
    triggerTaskRun: trigger,
    cancelTaskRun: cancel,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  vi.stubEnv('EVOBOT_PERSONAL_GOALS', 'true');
  trigger.mockImplementation((id, key) => {
    const reason = goals.personalGoalTaskBlockReason(id);
    if (reason) return { success: false, error: reason };
    const task = db.getTaskById(id)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: key,
    });
    const claim = db.claimNextTaskRun('routes-rsi-test', 60_000);
    if (claim && claim.id === created.run.id) {
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
    }
    return { success: true, runId: created.run.id };
  });
  cancel.mockImplementation((id) => ({ success: db.cancelTaskRun(id) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(
  url: string,
  method = 'GET',
  body?: unknown,
  user = 'alice',
  key?: string,
) {
  return routes.request(url, {
    method,
    headers: {
      cookie: cookies.get(user)!,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function createGoalWithTask(budget = 3) {
  const response = await request(
    '/',
    'POST',
    {
      workspace_jid: 'web:alice',
      objective: 'Test RSI goal',
      completion_criteria: ['Deliver report'],
      budget_max_runs: budget,
    },
    'alice',
    randomUUID(),
  );
  expect(response.status).toBe(201);
  const goal = ((await response.json()) as { goal: PersonalGoal }).goal;
  const taskId = randomUUID();
  db.createTask({
    id: taskId,
    group_folder: 'alice',
    chat_jid: 'web:alice',
    prompt: 'Execute step',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    next_run: new Date().toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: 'alice',
  });
  const linkRes = await request(`/${goal.id}/tasks`, 'POST', {
    task_id: taskId,
    expected_revision: goal.revision,
  });
  expect(linkRes.status).toBe(200);
  const linkedGoal = ((await linkRes.json()) as { goal: PersonalGoal }).goal;
  return { goal: linkedGoal, task: db.getTaskById(taskId)! };
}

function attachManagedRuntimeSession(goalId: string) {
  const sessionId = randomUUID();
  db.createAgent(
    {
      id: sessionId,
      group_folder: 'alice',
      chat_jid: 'web:alice',
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
      goalId,
    },
  );
  goals.attachAutomaticGoalSession('alice', goalId, sessionId);
  return sessionId;
}

function failGoalViaRuntime(
  goal: PersonalGoal,
  task: ReturnType<typeof db.getTaskById> & object,
  sessionId: string,
  failureReason: string,
  failureDetail: string | null,
) {
  const created = db.createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey: randomUUID(),
  }).run;
  const claim = db.claimNextTaskRun('routes-rsi-fail', 60_000)!;
  expect(claim.id).toBe(created.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  const snapshot = {
    goal_id: goal.id,
    goal_revision: goal.revision,
    owner_user_id: goal.owner_user_id,
    workspace_jid: goal.workspace_jid,
    session_id: sessionId,
    objective: goal.objective,
    completion_criteria: goal.completion_criteria,
    next_action: goal.next_action,
    content_digest: goals.personalGoalContentDigest(goal),
    budget_remaining_runs: goal.budget_max_runs,
    capabilities: ['read_workspace_file'],
    delivery: 'session_and_workspace' as const,
    previous_results: [],
  };
  goals.registerPersonalGoalRun(created.id, task.id, snapshot);

  const admitted = productRuntimeStore.admitProductInput(
    sessionId,
    `goal-run:${created.id}`,
    {
      sender: 'alice',
      senderName: 'Personal Goal',
      content: 'run',
      execution: {
        goalId: goal.id,
        runId: created.id,
        contextDigest: snapshot.content_digest,
      },
    },
    () => undefined,
  );
  const failure = classifyDurableFailure(failureReason, failureDetail);
  productRuntimeStore.finishProductInput(
    admitted.id,
    false,
    () => undefined,
    failure,
  );

  const ok = goals.failPersonalGoalRun(created.id, () =>
    db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'failed',
      error: failureDetail ?? failureReason,
      notificationStatus: 'skipped',
    }),
  );
  expect(ok).toBe(true);
  return created.id;
}

describe('RSI routes', () => {
  test('returns 409 when retrying a non-failed Goal', async () => {
    const { goal } = await createGoalWithTask();
    const res = await request(`/${goal.id}/retry`, 'POST', {
      approach: '换一种方式执行',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Goal is not failed' });
  });

  test('returns 409 and creates no branch when decision is stop', async () => {
    const { goal, task } = await createGoalWithTask(3);
    const sessionId = attachManagedRuntimeSession(goal.id);
    failGoalViaRuntime(goal, task, sessionId, 'model_error', 'unauthorized');

    const res = await request(`/${goal.id}/retry`, 'POST', {
      approach: '换一种方式执行',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_retryable' });
    expect(rsiBranches.listBranches('alice', goal.id)).toHaveLength(0);
  });

  test('returns 201 on allow decision, creates branch and personal_goal_charges row with matching run_id, and exposes rsi on GET /:id', async () => {
    const { goal, task } = await createGoalWithTask(3);
    const sessionId = attachManagedRuntimeSession(goal.id);
    failGoalViaRuntime(
      goal,
      task,
      sessionId,
      'model_error',
      '429 too many requests',
    );

    const detailBefore = await request(`/${goal.id}`);
    expect(detailBefore.status).toBe(200);
    const bodyBefore = (await detailBefore.json()) as {
      rsi: {
        decision: { action: string; reason: string | null } | null;
        branches: unknown[];
      };
    };
    expect(bodyBefore.rsi.decision).toEqual({
      action: 'allow',
      reason: null,
    });
    expect(bodyBefore.rsi.branches).toEqual([]);

    const retryRes = await request(`/${goal.id}/retry`, 'POST', {
      approach: '先检查接口限流再重试',
    });
    expect(retryRes.status).toBe(201);
    const retryBody = (await retryRes.json()) as {
      branch: { id: string; run_id: string | null; ordinal: number; trigger: string; status: string };
      decision: { action: string };
    };
    expect(retryBody.decision).toEqual({ action: 'allow' });
    expect(retryBody.branch.ordinal).toBe(1);
    expect(retryBody.branch.trigger).toBe('manual');
    expect(retryBody.branch.status).toBe('running');
    expect(retryBody.branch.run_id).toBeTruthy();

    const chargeRow = rsiBranches
      .rsiDb()
      .prepare('SELECT run_id, goal_id FROM personal_goal_charges WHERE run_id = ?')
      .get(retryBody.branch.run_id) as
      | { run_id: string; goal_id: string }
      | undefined;
    expect(chargeRow).toEqual({
      run_id: retryBody.branch.run_id,
      goal_id: goal.id,
    });

    const detailAfter = await request(`/${goal.id}`);
    expect(detailAfter.status).toBe(200);
    const bodyAfter = (await detailAfter.json()) as {
      rsi: {
        decision: { action: string; reason: string | null } | null;
        branches: Array<{ id: string; run_id: string | null }>;
      };
    };
    expect(bodyAfter.rsi.branches).toHaveLength(1);
    expect(bodyAfter.rsi.branches[0].run_id).toBe(retryBody.branch.run_id);
  });

  test('GET and PUT /rsi-settings persist auto_retry and validate workspace_jid', async () => {
    expect((await request('/rsi-settings')).status).toBe(400);
    expect(
      (await request('/rsi-settings', 'PUT', { auto_retry: true })).status,
    ).toBe(400);

    const initialGet = await request('/rsi-settings?workspace_jid=web:alice');
    expect(initialGet.status).toBe(200);
    expect(await initialGet.json()).toEqual({
      workspace_jid: 'web:alice',
      auto_retry: false,
    });

    const putRes = await request('/rsi-settings', 'PUT', {
      workspace_jid: 'web:alice',
      auto_retry: true,
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({
      workspace_jid: 'web:alice',
      auto_retry: true,
    });

    const getAfter = await request('/rsi-settings?workspace_jid=web:alice');
    expect(getAfter.status).toBe(200);
    expect(await getAfter.json()).toEqual({
      workspace_jid: 'web:alice',
      auto_retry: true,
    });
  });

  test('auto_retry triggers one auto branch on retryable failure via settlePersonalGoalExecution', async () => {
    const { goal, task } = await createGoalWithTask(3);
    db.updateTask(task.id, { execution_mode: 'host' });
    goals.markAutomaticGoalTask(goal.id, task.id);
    const updatedTask = db.getTaskById(task.id)!;
    const sessionId = attachManagedRuntimeSession(goal.id);

    const putRes = await request('/rsi-settings', 'PUT', {
      workspace_jid: 'web:alice',
      auto_retry: true,
    });
    expect(putRes.status).toBe(200);

    const created = db.createTaskRun({
      task: updatedTask,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('routes-rsi-settle', 60_000)!;
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    const currentGoal = goals.getPersonalGoal('alice', goal.id)!;
    const contextDigest = goals.personalGoalContentDigest(currentGoal);

    const admitted = productRuntimeStore.admitProductInput(
      sessionId,
      `goal-run:${created.id}`,
      {
        sender: 'alice',
        senderName: 'Personal Goal',
        content: 'run',
        execution: {
          goalId: goal.id,
          runId: created.id,
          contextDigest,
        },
      },
      () => undefined,
    );
    productRuntimeStore.finishProductInput(
      admitted.id,
      false,
      () => undefined,
      classifyDurableFailure('stalled', null),
    );

    const settled = goals.settlePersonalGoalExecution(
      {
        runId: created.id,
        sessionId,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token,
        modelCompleted: false,
        evidence: [],
      },
      () =>
        db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
          status: 'failed',
          error: 'stalled',
          notificationStatus: 'skipped',
        }),
      () => undefined,
    );
    expect(settled).toBe(true);

    const branches = rsiBranches.listBranches('alice', goal.id);
    expect(branches).toHaveLength(1);
    expect(branches[0].trigger).toBe('auto');
    expect(branches[0].ordinal).toBe(1);
    expect(branches[0].status).toBe('running');
    expect(branches[0].run_id).toBeTruthy();
    expect(branches[0].run_id).not.toBe(created.id);

    await request('/rsi-settings', 'PUT', {
      workspace_jid: 'web:alice',
      auto_retry: false,
    });
  });

  test('stops with same_failure when the same Goal fails twice with 429 and adds no branch', async () => {
    const { goal, task } = await createGoalWithTask(5);
    const sessionId = attachManagedRuntimeSession(goal.id);

    failGoalViaRuntime(
      goal,
      task,
      sessionId,
      'model_error',
      '429 too many requests',
    );
    const firstDetail = (await (await request(`/${goal.id}`)).json()) as {
      rsi: { decision: { action: string; reason: string | null } };
    };
    expect(firstDetail.rsi.decision).toEqual({ action: 'allow', reason: null });

    const goalAfterFirst = goals.getPersonalGoal('alice', goal.id)!;
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goalAfterFirst.revision,
      status: 'pending',
    });

    failGoalViaRuntime(
      goals.getPersonalGoal('alice', goal.id)!,
      task,
      sessionId,
      'model_error',
      '429 too many requests',
    );

    const secondDetail = (await (await request(`/${goal.id}`)).json()) as {
      rsi: {
        decision: { action: string; reason: string | null };
        branches: unknown[];
      };
    };
    expect(secondDetail.rsi.decision).toEqual({
      action: 'stop',
      reason: 'same_failure',
    });
    expect(secondDetail.rsi.branches).toHaveLength(0);

    const retryRes = await request(`/${goal.id}/retry`, 'POST', {
      approach: '改用备用步骤',
    });
    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({ error: 'same_failure' });
    expect(rsiBranches.listBranches('alice', goal.id)).toHaveLength(0);
  });

  test('auto_retry stops on consecutive same_failure after branch 1 fails with 429', async () => {
    const { goal, task } = await createGoalWithTask(5);
    const sessionId = attachManagedRuntimeSession(goal.id);

    const putRes = await request('/rsi-settings', 'PUT', {
      workspace_jid: 'web:alice',
      auto_retry: true,
    });
    expect(putRes.status).toBe(200);

    try {
      failGoalViaRuntime(
        goal,
        task,
        sessionId,
        'model_error',
        '429 too many requests',
      );

      const branchesAfterFirst = rsiBranches.listBranches('alice', goal.id);
      expect(branchesAfterFirst).toHaveLength(1);
      expect(branchesAfterFirst[0].trigger).toBe('auto');
      expect(branchesAfterFirst[0].status).toBe('running');
      const branchRunId = branchesAfterFirst[0].run_id!;

      const currentGoal = goals.getPersonalGoal('alice', goal.id)!;
      const digest = goals.personalGoalContentDigest(currentGoal);
      goals.registerPersonalGoalRun(branchRunId, task.id, {
        goal_id: goal.id,
        goal_revision: currentGoal.revision,
        owner_user_id: currentGoal.owner_user_id,
        workspace_jid: currentGoal.workspace_jid,
        session_id: sessionId,
        objective: currentGoal.objective,
        completion_criteria: currentGoal.completion_criteria,
        next_action: currentGoal.next_action,
        content_digest: digest,
        budget_remaining_runs: currentGoal.budget_max_runs - 1,
        capabilities: ['read_workspace_file'],
        delivery: 'session_and_workspace',
        previous_results: [],
      });
      const admitted = productRuntimeStore.admitProductInput(
        sessionId,
        `goal-run:${branchRunId}`,
        {
          sender: 'alice',
          senderName: 'Personal Goal',
          content: 'retry run',
          execution: {
            goalId: goal.id,
            runId: branchRunId,
            contextDigest: digest,
          },
        },
        () => undefined,
      );
      productRuntimeStore.finishProductInput(
        admitted.id,
        false,
        () => undefined,
        classifyDurableFailure('model_error', '429 too many requests'),
      );

      const claim = db
        .getTaskRunsForTask(task.id, 10)
        .find((row) => row.id === branchRunId)!;
      expect(
        goals.failPersonalGoalRun(branchRunId, () =>
          db.completeTaskRun(claim.id, claim.lease_owner!, claim.lease_token, {
            status: 'failed',
            error: '429 too many requests',
            notificationStatus: 'skipped',
          }),
        ),
      ).toBe(true);

      const branchesAfterSecond = rsiBranches.listBranches('alice', goal.id);
      expect(branchesAfterSecond).toHaveLength(1);
      expect(branchesAfterSecond[0].status).toBe('failed');
      expect(branchesAfterSecond[0].fail_kind).toBe('provider');

      const detail = (await (await request(`/${goal.id}`)).json()) as {
        rsi: { decision: { action: string; reason: string | null } };
      };
      expect(detail.rsi.decision).toEqual({
        action: 'stop',
        reason: 'same_failure',
      });
    } finally {
      await request('/rsi-settings', 'PUT', {
        workspace_jid: 'web:alice',
        auto_retry: false,
      });
    }
  });

  test('records rsi_retry_error event when auto_retry fails to start and rolls back own branch/goal on beginRetry failure', async () => {
    const { goal, task } = await createGoalWithTask(5);
    const sessionId = attachManagedRuntimeSession(goal.id);

    await request('/rsi-settings', 'PUT', {
      workspace_jid: 'web:alice',
      auto_retry: true,
    });
    trigger.mockImplementationOnce(() => ({
      success: false,
      error: 'scheduler busy',
    }));

    try {
      const firstRunId = failGoalViaRuntime(
        goal,
        task,
        sessionId,
        'model_error',
        '429 too many requests',
      );

      const branchesAfterAutoFail = rsiBranches.listBranches('alice', goal.id);
      expect(branchesAfterAutoFail).toHaveLength(1);
      expect(branchesAfterAutoFail[0].status).toBe('stopped');
      expect(branchesAfterAutoFail[0].run_id).toBeNull();
      expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('failed');

      const events = goals.listPersonalGoalEvents('alice', goal.id);
      const retryErrors = events.filter(
        (entry) => entry.kind === 'rsi_retry_error',
      );
      expect(retryErrors).toHaveLength(1);
      expect(retryErrors[0].detail).toEqual({
        run_id: firstRunId,
        error: 'scheduler busy',
      });
      const decisions = events.filter((entry) => entry.kind === 'rsi_decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].detail).toMatchObject({
        run_id: firstRunId,
        action: 'allow',
        reason: null,
      });

      // Manual beginRetry rollback when triggerTaskRun throws
      trigger.mockImplementationOnce(() => {
        throw new Error('trigger boom');
      });
      const retryFailRes = await request(`/${goal.id}/retry`, 'POST', {
        approach: '重试并记录回滚',
      });
      expect(retryFailRes.status).toBe(500);
      const branchesAfterManualFail = rsiBranches.listBranches(
        'alice',
        goal.id,
      );
      expect(branchesAfterManualFail).toHaveLength(2);
      expect(
        branchesAfterManualFail.every((branch) => branch.status === 'stopped'),
      ).toBe(true);
      expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('failed');
    } finally {
      await request('/rsi-settings', 'PUT', {
        workspace_jid: 'web:alice',
        auto_retry: false,
      });
    }
  });
});
