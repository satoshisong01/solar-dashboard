import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, isActivePath } from './nav-items';

describe('isActivePath', () => {
  it.each([
    ['/', '/', true],
    ['/fleet', '/', false],
    ['/sites', '/sites', true],
    ['/sites/SIM-A', '/sites', true],
    ['/sites-archive', '/sites', false],
    ['/', '/sites', false],
  ])('경로 %s, 메뉴 %s → %s', (pathname, href, expected) => {
    expect(isActivePath(pathname, href)).toBe(expected);
  });

  it('메뉴 경로마다 활성 메뉴는 정확히 하나다', () => {
    const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

    for (const pathname of hrefs) {
      const active = hrefs.filter((href) => isActivePath(pathname, href));
      expect(active).toEqual([pathname]);
    }
  });
});
