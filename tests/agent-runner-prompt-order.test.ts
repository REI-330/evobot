import { describe, expect, test } from 'vitest';
import { buildEvoBotPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

describe('agent-runner system prompt composition order', () => {
  test('Agent identity leads platform workspace/context material', () => {
    const plan = buildEvoBotPromptPlan({
      platformIdentity: 'EvoBot',
      platformBootstrap: 'first wake',
      agentIdentity: 'identity',
      interaction: 'interaction',
      security: 'security',
      output: 'output',
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'identity.evobot',
      'bootstrap.evobot',
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
  });
});
