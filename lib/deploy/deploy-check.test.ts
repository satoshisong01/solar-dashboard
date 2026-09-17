// 배포 후 스모크 점검(npm run deploy:check)의 순수 판정 부분.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareTokens, normalizeCssValue, rootTokens, servedValues, stylesheetHrefs } from './css-tokens';
import { compareMigrations, isParityOk } from './migration-parity';
import { ANONYMOUS_CHECKS, consoleRoutes } from './routes';

const SOURCE_CSS = readFileSync('app/globals.css', 'utf8');
/** 소스 :root 토큰을 그대로 담은 배포 CSS (해시만 바뀌고 값은 같은 정상 배포) */
const servedFromSource = (): string => `:root{${[...rootTokens(SOURCE_CSS)].map(([token, value]) => `${token}:${value}`).join(';')}}`;

describe('마이그레이션 정합', () => {
  const files = ['20260914070310296_create-om-schema.sql', '20260917120000000_om-finding-digest.sql', 'README.md'];

  it('파일 목록과 적용 목록이 같으면 통과한다 (.sql이 아닌 파일은 세지 않는다)', () => {
    const parity = compareMigrations(files, ['20260914070310296_create-om-schema', '20260917120000000_om-finding-digest']);
    expect(parity).toEqual({ missing: [], extra: [] });
    expect(isParityOk(parity)).toBe(true);
  });

  it('배포만 하고 마이그레이션을 돌리지 않으면 빠진 것을 알려 준다', () => {
    const parity = compareMigrations(files, ['20260914070310296_create-om-schema']);
    expect(parity.missing).toEqual(['20260917120000000_om-finding-digest']);
    expect(isParityOk(parity)).toBe(false);
  });

  it('운영에만 있는 마이그레이션은 여분으로 잡는다', () => {
    const parity = compareMigrations(files, ['20260914070310296_create-om-schema', '20260917120000000_om-finding-digest', '20260918000000000_지운것']);
    expect(parity.extra).toEqual(['20260918000000000_지운것']);
    expect(isParityOk(parity)).toBe(false);
  });
});

describe('CSS 토큰 값 비교', () => {
  it('같은 값을 다르게 쓴 것은 같게 본다 (#fff = #ffffff, 쉼표 뒤 공백)', () => {
    expect(normalizeCssValue(' #FFFFFF ')).toBe(normalizeCssValue('#fff'));
    expect(normalizeCssValue('var(--A), Pretendard , sans-serif')).toBe('var(--a),pretendard,sans-serif');
  });

  it('따옴표 안의 공백·대소문자는 값의 일부라 그대로 둔다', () => {
    expect(normalizeCssValue('"Pretendard Variable", X')).toBe('"Pretendard Variable",x');
    expect(normalizeCssValue("'Malgun Gothic'")).toBe('"Malgun Gothic"');
  });

  it('소스 globals.css의 첫 :root 블록만 읽는다 (@media print의 :root는 밝은 값이라 섞이면 안 된다)', () => {
    const tokens = rootTokens(SOURCE_CSS);
    expect(tokens.get('--ground')).toBe('#05090f');
    expect(tokens.size).toBeGreaterThan(30);
  });

  it('배포 CSS에서 토큰이 선언된 값을 모두 찾는다 (.print-root의 밝은 값도 함께 나온다)', () => {
    expect(servedValues(':root{--ground:#05090f}.print-root{--ground:#f2f5f4}', '--ground')).toEqual(['#05090f', '#f2f5f4']);
    expect(servedValues(':root{--color-ground:var(--ground)}', '--ground')).toEqual([]);
  });

  it('값이 같은 배포 CSS는 통과한다', () => {
    const comparison = compareTokens(SOURCE_CSS, servedFromSource());
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.checked).toBe(rootTokens(SOURCE_CSS).size);
  });

  it('옛 빌드가 배포돼 토큰 값이 다르면 그 토큰을 짚어 준다', () => {
    const stale = servedFromSource().replace('--ground:#05090f', '--ground:#f2f5f4');
    const { mismatches } = compareTokens(SOURCE_CSS, stale);
    expect(mismatches).toEqual([{ token: '--ground', expected: '#05090f', served: ['#f2f5f4'] }]);
  });

  it('토큰이 아예 없으면 배포 값이 빈 목록이다', () => {
    const { mismatches } = compareTokens(':root{--ground:#05090f}', ':root{}');
    expect(mismatches).toEqual([{ token: '--ground', expected: '#05090f', served: [] }]);
  });

  it('배포 HTML에서 stylesheet 경로를 뽑는다 (중복 제거)', () => {
    const html = '<link rel="stylesheet" href="/_next/static/immutable/chunks/a.css" data-precedence="next"/><link rel="stylesheet" href="/_next/static/immutable/chunks/a.css"/><link rel="preload" href="/x.woff2"/>';
    expect(stylesheetHrefs(html)).toEqual(['/_next/static/immutable/chunks/a.css']);
  });
});

describe('확인할 경로', () => {
  it('id가 있으면 상세 경로를 넣고, 없으면 뺀다', () => {
    const withIds = consoleRoutes({ siteCode: 'GP-1', findingId: '14', reportId: '3' }).map((route) => route.path);
    expect(withIds).toContain('/sites/GP-1');
    expect(withIds).toContain('/sites/GP-1/diagram');
    expect(withIds).toContain('/desk/14');
    expect(withIds).toContain('/reports/3');

    const without = consoleRoutes({ siteCode: null, findingId: null, reportId: null }).map((route) => route.path);
    expect(without.filter((path) => path.startsWith('/sites/') || path.startsWith('/desk/') || path.startsWith('/reports/'))).toEqual([]);
    expect(without.length).toBeGreaterThanOrEqual(12);
  });

  it('표시 문구에는 HTML에서 이스케이프되는 글자를 쓰지 않는다', () => {
    for (const route of consoleRoutes({ siteCode: 'GP-1', findingId: '1', reportId: '1' })) {
      expect(route.marker, route.path).not.toMatch(/[<>&"']/);
      expect(route.marker.length, route.path).toBeGreaterThan(3);
    }
  });

  it('비로그인 기대 상태: 화면 307 · 콘솔 API 401 · 로그인 화면 200', () => {
    expect(ANONYMOUS_CHECKS.map((check) => [check.path, check.status])).toEqual([
      ['/', 307],
      ['/desk', 307],
      ['/api/series', 401],
      ['/login', 200],
    ]);
  });
});
