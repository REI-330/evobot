import type { DurableFailure } from '../personal-agent/durable-failure.js';

export type RetryStopReason =
  | 'not_retryable'
  | 'same_failure'
  | 'budget'
  | 'limit';

export type RetryDecision =
  | { action: 'stop'; reason: RetryStopReason }
  | { action: 'allow' };

export function decideRetry(input: {
  failure: DurableFailure;
  previous: { fail_kind: string | null }[];
  budgetUsed: number;
  budgetMax: number;
  maxBranches: number;
}): RetryDecision {
  if (input.previous.length >= input.maxBranches) {
    return { action: 'stop', reason: 'limit' };
  }
  if (input.budgetUsed >= input.budgetMax) {
    return { action: 'stop', reason: 'budget' };
  }
  if (input.failure.retryable === false) {
    return { action: 'stop', reason: 'not_retryable' };
  }
  const last = input.previous.at(-1);
  if (last && last.fail_kind === input.failure.kind) {
    return { action: 'stop', reason: 'same_failure' };
  }
  return { action: 'allow' };
}
