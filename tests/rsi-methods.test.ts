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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-methods-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'rsi-methods-test-secret',
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const goals = await import('../src/personal-agent/goal-store.js');
const memoryService = await import('../src/memory-service.js');
const productRuntimeStore = await import(
  '../src/personal-agent/product-runtime-store.js'
);
const personalMemory = await import(
  '../src/personal-agent/personal-memory-store.js'
);
const rsiBranches = await import('../src/rsi/branch-store.js');
const rsiMethods = await import('../src/rsi/method-store.js');
await import('../src/web.js');
const personalMemoryRoutes = (await import('../src/routes/personal-memory.js'))
  .default;
const agentRoutes = (await import('../src/routes/agents.js')).default;
const goalRoutes = (await import('../src/routes/goals.js')).default;

const cookies = new Map<string, string>();
const homeJid = 'web:alice-home';
const projectJid = 'web:alice-project';
const noHomeJid = 'web:nohome-project';

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['alice', 'nohome']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'unit-test-hash',
      display_name: id,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: null,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    cookies.set(id, `evobot_session=${auth.signSessionToken(token)}`);
  }
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
  db.setRegisteredGroup(noHomeJid, {
    name: 'No Home Project',
    folder: 'nohome-project',
    created_by: 'nohome',
    executionMode: 'host',
    is_home: false,
    added_at: now,
  });
});

beforeEach(() => {
  vi.stubEnv('EVOBOT_PERSONAL_GOALS', 'true');
  vi.stubEnv('EVOBOT_PERSONAL_MEMORY', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function pmRequest(
  url: string,
  method = 'GET',
  body?: unknown,
  user = 'alice',
  key?: string,
) {
  return personalMemoryRoutes.request(url, {
    method,
    headers: {
      cookie: cookies.get(user)!,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function setupGoalAndRun(input: {
  owner?: string;
  workspaceJid?: string;
  folder?: string;
  objective: string;
  criteria: string[];
  nextAction?: string;
}) {
  const owner = input.owner ?? 'alice';
  const workspaceJid = input.workspaceJid ?? projectJid;
  const folder = input.folder ?? 'alice-project';
  const goal = goals.createPersonalGoal(owner, randomUUID(), {
    workspace_jid: workspaceJid,
    objective: input.objective,
    completion_criteria: input.criteria,
    next_action: input.nextAction ?? '输出最终产物',
    budget_max_runs: 3,
  });
  const taskId = randomUUID();
  db.createTask({
    id: taskId,
    group_folder: folder,
    chat_jid: workspaceJid,
    prompt: 'Step',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'host',
    next_run: new Date().toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: owner,
  });
  const linked = goals.linkPersonalGoalTask(owner, goal.id, taskId, goal.revision);
  goals.markAutomaticGoalTask(goal.id, taskId);

  const sessionId = randomUUID();
  db.createAgent(
    {
      id: sessionId,
      group_folder: folder,
      chat_jid: workspaceJid,
      name: 'Goal Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: owner,
      created_at: new Date().toISOString(),
    },
    {
      kind: 'pi-durable',
      providerId: 'test-provider',
      configFingerprint: 'test-fp',
      goalId: goal.id,
    },
  );
  goals.attachAutomaticGoalSession(owner, goal.id, sessionId);

  const task = db.getTaskById(taskId)!;
  const run = db.createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey: randomUUID(),
  }).run;
  const claim = db.claimNextTaskRun('rsi-methods-test', 60_000)!;
  expect(claim.id).toBe(run.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);

  return { goal: goals.getPersonalGoal(owner, linked.id)!, task, sessionId, claim };
}

function settleAsCompleted(
  claim: NonNullable<ReturnType<typeof db.claimNextTaskRun>>,
  sessionId: string,
  criteriaCount: number,
) {
  return goals.settlePersonalGoalExecution(
    {
      runId: claim.id,
      sessionId,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      modelCompleted: true,
      evidence: [
        {
          artifact_id: randomUUID(),
          content_digest: 'sha256-digest',
          criteria_matches: Array.from({ length: criteriaCount }, () => true),
        },
      ],
    },
    () =>
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'ok',
        notificationStatus: 'skipped',
      }),
    () => undefined,
  );
}

describe('RSI M3 methods', () => {
  test('1. creates an unconfirmed method on deterministic Goal completion and hides it from read_personal_memory', async () => {
    const { goal, sessionId, claim } = setupGoalAndRun({
      objective: '生成季度汇总报告并验证关键字段',
      criteria: ['artifact_contains:TOTAL_SUMMARY'],
      nextAction: '先统计数据再生成摘要',
    });

    const settled = settleAsCompleted(claim, sessionId, 1);
    expect(settled).toBe(true);
    expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('completed');

    const method = rsiMethods.getRsiMethodForGoal('alice', goal.id);
    expect(method).toBeTruthy();
    expect(method!.source_kind).toBe('goal_completed');
    expect(method!.verification).toBe('passed');
    expect(method!.memory_status).toBe('proposed');

    const readRes = personalMemory.readGrantedPersonalMemory(
      'alice',
      projectJid,
      'read-check-1',
      1,
      '生成季度汇总报告',
    );
    expect(readRes.entries).toHaveLength(0);

    const listRes = await pmRequest('/');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      entries: Array<{ item: { id: string; status: string }; rsi?: { verification: string } }>;
    };
    const found = listBody.entries.find((e) => e.item.id === method!.memory_item_id);
    expect(found).toBeTruthy();
    expect(found!.item.status).toBe('proposed');
    expect(found!.rsi?.verification).toBe('passed');
  });

  test('2. does not create a method when completion_criteria contains natural language', () => {
    const { goal, sessionId, claim } = setupGoalAndRun({
      objective: '自然语言验收目标',
      criteria: ['artifact_contains:OK', '用户肉眼确认格式美观'],
      nextAction: '按步骤整理',
    });

    const settled = settleAsCompleted(claim, sessionId, 2);
    expect(settled).toBe(true);
    expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('waiting_for_input');
    expect(rsiMethods.getRsiMethodForGoal('alice', goal.id)).toBeUndefined();
  });

  test('3. creates at most one method for the same Goal even if createMethodFromCompletedGoal runs twice', () => {
    const { goal, sessionId, claim } = setupGoalAndRun({
      objective: '幂等生成唯一方法',
      criteria: ['artifact_contains:UNIQUE_TOKEN'],
      nextAction: '直接校验并输出',
    });
    expect(settleAsCompleted(claim, sessionId, 1)).toBe(true);

    const secondAttempt = rsiMethods.createMethodFromCompletedGoal(
      goal.id,
      claim.id,
    );
    expect(secondAttempt.method).toBeNull();
    const rows = rsiBranches
      .rsiDb()
      .prepare('SELECT id FROM rsi_methods WHERE source_goal_id = ?')
      .all(goal.id);
    expect(rows).toHaveLength(1);
  });

  test('4. Goal still settles as completed even if method creation fails (e.g., user has no Home workspace)', () => {
    const { goal, sessionId, claim } = setupGoalAndRun({
      owner: 'nohome',
      workspaceJid: noHomeJid,
      folder: 'nohome-project',
      objective: '无 Home 工作区时仍应完成 Goal',
      criteria: ['artifact_contains:DONE'],
      nextAction: '直接执行',
    });

    const settled = settleAsCompleted(claim, sessionId, 1);
    expect(settled).toBe(true);
    expect(goals.getPersonalGoal('nohome', goal.id)?.status).toBe('completed');
    expect(rsiMethods.getRsiMethodForGoal('nohome', goal.id)).toBeUndefined();
  });

  test('5. user correction feedback creates one method when score=-1 and >=8 non-whitespace chars; ignores empty comments and duplicate updates', async () => {
    const sessionId = randomUUID();
    db.createAgent(
      {
        id: sessionId,
        group_folder: 'alice-project',
        chat_jid: projectJid,
        name: 'Chat Session',
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
      },
    );

    const msgShort = randomUUID();
    const msgGood = randomUUID();
    const sessionChatJid = `${projectJid}#agent:${sessionId}`;
    db.ensureChatExists(sessionChatJid);
    for (const id of [msgShort, msgGood]) {
      db.storeMessageDirect(
        id,
        sessionChatJid,
        'bot',
        'EvoBot',
        '回复内容',
        new Date().toISOString(),
        true,
      );
    }

    // Too short (< 8 non-whitespace chars) -> no method
    const shortRes = await agentRoutes.request(
      `/${encodeURIComponent(projectJid)}/sessions/${sessionId}/messages/${msgShort}/feedback`,
      {
        method: 'PUT',
        headers: {
          cookie: cookies.get('alice')!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          expectedVersion: 0,
          score: -1,
          comment: '太长了',
        }),
      },
    );
    expect(shortRes.status).toBe(200);

    // >= 8 non-whitespace chars -> creates user_correction method
    const goodRes = await agentRoutes.request(
      `/${encodeURIComponent(projectJid)}/sessions/${sessionId}/messages/${msgGood}/feedback`,
      {
        method: 'PUT',
        headers: {
          cookie: cookies.get('alice')!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          expectedVersion: 0,
          score: -1,
          comment: '下次请不要直接改配置，先打印检查结果再询问确认',
        }),
      },
    );
    expect(goodRes.status).toBe(200);

    // Updating the comment on the same message must NOT create a second method or overwrite the first
    const updateRes = await agentRoutes.request(
      `/${encodeURIComponent(projectJid)}/sessions/${sessionId}/messages/${msgGood}/feedback`,
      {
        method: 'PUT',
        headers: {
          cookie: cookies.get('alice')!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: randomUUID(),
          expectedVersion: 1,
          score: -1,
          comment: '这是修改后的第二次评论，不应该覆写也不应该再生成一条',
        }),
      },
    );
    expect(updateRes.status).toBe(200);

    const rows = rsiBranches
      .rsiDb()
      .prepare(
        "SELECT * FROM rsi_methods WHERE owner_user_id = 'alice' AND source_kind = 'user_correction'",
      )
      .all() as Array<{ approach: string; verification: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].verification).toBe('none');
    expect(rows[0].approach).toContain('下次请不要直接改配置');
  });

  test('6. enforces 50-method per-user capacity limit and leaves existing 50 intact', async () => {
    const currentCount = rsiMethods.countRsiMethods('alice');
    for (let i = currentCount; i < 50; i++) {
      const res = rsiMethods.createMethodFromUserCorrection({
        ownerId: 'alice',
        workspaceJid: projectJid,
        sessionId: 'cap-session',
        messageId: `cap-msg-${i}-${randomUUID()}`,
        score: -1,
        comment: `第${i}条足够长的纠正方法说明`,
      });
      expect(res.method).toBeTruthy();
      expect(res.full).toBe(false);
    }
    expect(rsiMethods.countRsiMethods('alice')).toBe(50);

    const { goal, sessionId, claim } = setupGoalAndRun({
      objective: '第51条方法应该被拒绝',
      criteria: ['artifact_contains:CAP_51'],
      nextAction: '测试上限',
    });
    expect(settleAsCompleted(claim, sessionId, 1)).toBe(true);
    expect(rsiMethods.countRsiMethods('alice')).toBe(50);
    expect(rsiMethods.getRsiMethodForGoal('alice', goal.id)).toBeUndefined();

    const detailRes = await goalRoutes.request(`/${goal.id}`, {
      headers: { cookie: cookies.get('alice')! },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      rsi: { methods_full: boolean; method: unknown };
    };
    expect(detail.rsi.methods_full).toBe(true);
    expect(detail.rsi.method).toBeNull();
  });

  test('7. confirm activates method for recall and forget removes it from both list and rsi_methods', async () => {
    // Delete one existing method first so alice is under 50
    const firstRow = rsiBranches
      .rsiDb()
      .prepare("SELECT memory_item_id FROM rsi_methods WHERE owner_user_id = 'alice' LIMIT 1")
      .get() as { memory_item_id: string };
    const firstEntry = personalMemory.getPersonalMemoryEntry('alice', firstRow.memory_item_id);
    const forgetOld = await pmRequest(
      `/${firstRow.memory_item_id}/forget`,
      'POST',
      { expected_revision: firstEntry.item.revision, confirmed: true },
      'alice',
      randomUUID(),
    );
    expect(forgetOld.status).toBe(200);

    const { goal, sessionId, claim } = setupGoalAndRun({
      objective: '确认后可读取并在删除后彻底清除',
      criteria: ['artifact_contains:CONFIRMED_METHOD'],
      nextAction: '先生成提纲再补全正文',
    });
    expect(settleAsCompleted(claim, sessionId, 1)).toBe(true);
    const createdMethod = rsiMethods.getRsiMethodForGoal('alice', goal.id)!;
    expect(createdMethod).toBeTruthy();

    // Non-RSI item confirm returns 404
    const userMem = personalMemory.createPersonalMemoryEntry(
      'alice',
      randomUUID(),
      { content: '普通个人记忆', title: '普通', confirmed: true, allowed_workspaces: [] },
      () => {
        throw new Error('unused');
      },
    );
    expect((await pmRequest(`/${userMem.entry.item.id}/confirm`, 'POST')).status).toBe(404);

    // Confirm RSI method
    const confirmRes = await pmRequest(
      `/${createdMethod.memory_item_id}/confirm`,
      'POST',
      {},
      'alice',
      randomUUID(),
    );
    expect(confirmRes.status).toBe(200);
    const confirmBody = (await confirmRes.json()) as {
      entry: { item: { status: string; revision: number }; allowed_workspaces: string[] };
    };
    expect(confirmBody.entry.item.status).toBe('active');
    expect(confirmBody.entry.allowed_workspaces).toContain(projectJid);

    // Now readable via readGrantedPersonalMemory in source workspace
    const recallAfter = personalMemory.readGrantedPersonalMemory(
      'alice',
      projectJid,
      'read-after-confirm',
      2,
      '确认后可读取',
    );
    expect(recallAfter.entries.some((e) => e.id === createdMethod.memory_item_id)).toBe(true);

    // Forget removes it from GET /api/personal-memory and deletes rsi_methods row
    const forgetRes = await pmRequest(
      `/${createdMethod.memory_item_id}/forget`,
      'POST',
      { expected_revision: confirmBody.entry.item.revision, confirmed: true },
      'alice',
      randomUUID(),
    );
    expect(forgetRes.status).toBe(200);

    expect(
      rsiMethods.getRsiMethodByMemoryItemId('alice', createdMethod.memory_item_id),
    ).toBeUndefined();
    const listAfter = (await (await pmRequest('/')).json()) as {
      entries: Array<{ item: { id: string } }>;
    };
    expect(
      listAfter.entries.some((e) => e.item.id === createdMethod.memory_item_id),
    ).toBe(false);

    // Direct workspace memory forget also cleans up rsi_methods (no orphan rows)
    const directGoal = setupGoalAndRun({
      objective: '直接遗忘工作区记忆也清理方法记录',
      criteria: ['artifact_contains:CLEANUP_DIRECT'],
      nextAction: '直接执行检查',
    });
    expect(settleAsCompleted(directGoal.claim, directGoal.sessionId, 1)).toBe(true);
    const directMethod = rsiMethods.getRsiMethodForGoal('alice', directGoal.goal.id)!;
    expect(directMethod).toBeTruthy();

    memoryService.forgetWorkspaceMemory({
      actor: { id: 'alice', role: 'admin' },
      workspaceJid: homeJid,
      sourceType: 'web_user',
      itemId: directMethod.memory_item_id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      rsiMethods.getRsiMethodByMemoryItemId('alice', directMethod.memory_item_id),
    ).toBeUndefined();

    // Physical DELETE FROM workspace_memory_items cascades through personal_memory_entries to rsi_methods
    const cascadeGoal = setupGoalAndRun({
      objective: '物理删除记忆条目级联删除方法',
      criteria: ['artifact_contains:CLEANUP_CASCADE'],
      nextAction: '物理级联检查',
    });
    expect(settleAsCompleted(cascadeGoal.claim, cascadeGoal.sessionId, 1)).toBe(true);
    const cascadeMethod = rsiMethods.getRsiMethodForGoal('alice', cascadeGoal.goal.id)!;
    expect(cascadeMethod).toBeTruthy();
    rsiBranches
      .rsiDb()
      .prepare('DELETE FROM workspace_memory_items WHERE id = ?')
      .run(cascadeMethod.memory_item_id);
    expect(
      rsiMethods.getRsiMethodByMemoryItemId('alice', cascadeMethod.memory_item_id),
    ).toBeUndefined();
  });
});
