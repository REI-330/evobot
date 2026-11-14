import { describe, expect, test } from 'vitest';

import { filterNavItems } from '../web/src/components/layout/nav-items.js';

describe('billing navigation visibility', () => {
  test('never exposes billing in the personal assistant navigation', () => {
    expect(filterNavItems(false).some((item) => item.path === '/billing')).toBe(
      false,
    );
    expect(filterNavItems(true).some((item) => item.path === '/billing')).toBe(
      false,
    );
  });
});
