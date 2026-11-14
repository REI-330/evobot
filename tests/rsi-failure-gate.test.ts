import { describe, expect, test } from 'vitest';
import { classifyDurableFailure } from '../src/personal-agent/durable-failure.js';
import { decideRetry } from '../src/rsi/failure-gate.js';

describe('RSI failure gate decideRetry', () => {
  test('stops on auth failure (not_retryable)', () => {
    const failure = classifyDurableFailure('model_error', 'unauthorized');
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'not_retryable' });
  });

  test('stops on missing model (not_retryable)', () => {
    const failure = classifyDurableFailure('no_model', null);
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'not_retryable' });
  });

  test('stops on region restriction (not_retryable)', () => {
    const failure = classifyDurableFailure(
      'model_error',
      'not available in your country',
    );
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'not_retryable' });
  });

  test('allows retry on 429 rate limit', () => {
    const failure = classifyDurableFailure(
      'model_error',
      '429 too many requests',
    );
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'allow' });
  });

  test('allows retry on stalled timeout', () => {
    const failure = classifyDurableFailure('stalled', null);
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'allow' });
  });

  test('allows retry on runner_exit', () => {
    const failure = classifyDurableFailure('runner_exit', null);
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'allow' });
  });

  test('stops on consecutive same failure kind', () => {
    const failure = classifyDurableFailure(
      'model_error',
      '429 too many requests',
    );
    expect(
      decideRetry({
        failure,
        previous: [{ fail_kind: 'provider' }],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'same_failure' });
  });

  test('allows retry when previous failure kind differs and current is retryable', () => {
    const failure = classifyDurableFailure('runner_exit', null);
    expect(
      decideRetry({
        failure,
        previous: [{ fail_kind: 'provider' }],
        budgetUsed: 1,
        budgetMax: 5,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'allow' });
  });

  test('stops when budget is exhausted', () => {
    const failure = classifyDurableFailure('stalled', null);
    expect(
      decideRetry({
        failure,
        previous: [],
        budgetUsed: 3,
        budgetMax: 3,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'budget' });
  });

  test('stops when 3 branches have already run', () => {
    const failure = classifyDurableFailure('stalled', null);
    expect(
      decideRetry({
        failure,
        previous: [
          { fail_kind: 'provider' },
          { fail_kind: 'runtime' },
          { fail_kind: 'aborted' },
        ],
        budgetUsed: 3,
        budgetMax: 10,
        maxBranches: 3,
      }),
    ).toEqual({ action: 'stop', reason: 'limit' });
  });
});
