import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, isActivePath, navGroupsFor } from './nav-items';

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

  it('메뉴 경로마다 활성 메뉴는 정확히 하나다 (시뮬레이터 메뉴 포함)', () => {
    const hrefs = navGroupsFor(true).flatMap((group) => group.items.map((item) => item.href));

    for (const pathname of hrefs) {
      const active = hrefs.filter((href) => isActivePath(pathname, href));
      expect(active).toEqual([pathname]);
    }
  });
});

describe('navGroupsFor', () => {
  it('플래그가 꺼져 있으면 기본 메뉴 10개, 켜면 분석·코칭 그룹 끝에 시뮬레이터', () => {
    const count = (groups: ReturnType<typeof navGroupsFor>) => groups.flatMap((group) => group.items).length;
    expect(navGroupsFor(false)).toBe(NAV_GROUPS);
    expect(count(navGroupsFor(false))).toBe(10);
    const withSim = navGroupsFor(true);
    expect(count(withSim)).toBe(11);
    expect(withSim.find((group) => group.id === 'analysis')?.items.at(-1)?.href).toBe('/sim');
  });
});
