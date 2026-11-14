import { expect, test } from 'vitest';
import {
  filterNavItems,
  mobileNavItems,
  productNavItems,
  productNavActive,
} from '../web/src/components/layout/nav-items';

test('keeps 4+1 product destinations without billing bloat', () => {
  expect(mobileNavItems(true).map((item) => item.label)).toEqual([
    '工作',
    'EvoBot',
    '群聊',
    '能力',
    '设置',
  ]);
  expect(mobileNavItems(false).map((item) => item.path)).toContain('/tasks');
  expect(mobileNavItems(true).map((item) => item.path)).toContain('/goals');
  expect(mobileNavItems(true).map((item) => item.path)).not.toContain(
    '/billing',
  );
  expect(
    filterNavItems(false, true).some((item) => item.path === '/billing'),
  ).toBe(false);
  expect(
    filterNavItems(true, true).some((item) => item.path === '/billing'),
  ).toBe(false);
  expect(
    productNavItems(true).some((item) => item.path === '/bot-groups'),
  ).toBe(true);
  expect(
    productNavItems(true).some((item) => item.path === '/capabilities'),
  ).toBe(true);
});

test('Chief/team selection distinguishes query view and maps grouped routes accurately', () => {
  expect(productNavActive('/bots', '/bots', '')).toBe(true);
  expect(productNavActive('/bots', '/bots', '?view=team')).toBe(false);
  expect(productNavActive('/bots?view=team', '/bots', '?view=team')).toBe(true);
  expect(productNavActive('/bot-groups', '/bot-groups/owned', '')).toBe(true);
  expect(productNavActive('/chat', '/chat-other', '')).toBe(false);
  expect(productNavActive('/goals', '/tasks', '')).toBe(true);
  expect(productNavActive('/capabilities', '/capabilities/usage', '')).toBe(
    true,
  );
  expect(productNavActive('/capabilities', '/agent-profiles', '')).toBe(true);
});

test('navigation uses the actual default assistant name without using it as identity', () => {
  expect(mobileNavItems(true, '小点')[1]).toMatchObject({
    path: '/bots',
    label: '小点',
  });
  expect(productNavItems(true, '研究搭子')[0]).toMatchObject({
    path: '/bots',
    label: '研究搭子',
  });
});
