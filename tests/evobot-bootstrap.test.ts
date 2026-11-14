import { describe, expect, test } from 'vitest';

import {
  isEvoBotBootstrapTurn,
  isEvoBotOwnerProfileRuntimeStructurallyEligible,
} from '../src/evobot-bootstrap.js';

describe('EvoBot first-wake eligibility', () => {
  test('allows only a real interactive Home turn of the built-in profile', () => {
    expect(
      isEvoBotBootstrapTurn({
        turnId: 'owner-turn',
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(true);
    expect(
      isEvoBotBootstrapTurn({
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(false);
    expect(
      isEvoBotBootstrapTurn({
        turnId: 'scheduled-turn',
        isHome: true,
        isDefaultProfile: true,
        isScheduledTask: true,
      }),
    ).toBe(false);
    expect(
      isEvoBotBootstrapTurn({
        turnId: 'custom-turn',
        isHome: true,
        isDefaultProfile: false,
      }),
    ).toBe(false);
    expect(
      isEvoBotBootstrapTurn({
        turnId: 'project-turn',
        isHome: false,
        isDefaultProfile: true,
      }),
    ).toBe(false);
  });
});

describe('EvoBot Owner Profile structural runtime eligibility', () => {
  test('keeps capability across terminal warmup but denies unsafe runtime kinds', () => {
    const warmup = {
      isHome: true,
      isDefaultProfile: true,
    };
    expect(isEvoBotOwnerProfileRuntimeStructurallyEligible(warmup)).toBe(
      true,
    );
    expect(
      isEvoBotOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
      }),
    ).toBe(true);
    expect(
      isEvoBotOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isScheduledTask: true,
      }),
    ).toBe(false);
    for (const runtimeAgentKind of ['task', 'spawn'] as const) {
      expect(
        isEvoBotOwnerProfileRuntimeStructurallyEligible({
          ...warmup,
          runtimeAgentId: `${runtimeAgentKind}-1`,
          runtimeAgentKind,
        }),
      ).toBe(false);
    }
    expect(
      isEvoBotOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isHome: false,
      }),
    ).toBe(false);
    expect(
      isEvoBotOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isDefaultProfile: false,
      }),
    ).toBe(false);
  });
});
