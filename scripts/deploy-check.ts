// 배포 후 스모크 점검 (읽기 전용). 운영 URL과 운영 DB를 보고 "배포가 실제로 반영됐는지"를 확인한다.
//   npm run deploy:check -- --url https://<운영 도메인> --env-file <DB 접속 env 파일> --email <관리자> --password-file <비밀번호 파일>
// 확인 항목: 마이그레이션 정합 · 비로그인 응답 · 주요 화면 200과 본문 · 배포 CSS 토큰 · 필수 환경변수(간접)
// 비밀값(DB URL·비밀번호·세션 쿠키)은 출력하지 않는다. DB는 SELECT만 한다 (쓰기·DDL 없음).
import { readdirSync, readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { Pool } from 'pg';
import { compareTokens, stylesheetHrefs } from '../lib/deploy/css-tokens';
import { compareMigrations, isParityOk } from '../lib/deploy/migration-parity';
import { ANONYMOUS_CHECKS, consoleRoutes, type RouteIds } from '../lib/deploy/routes';
import { MIGRATIONS_DIR } from '../lib/db/migrate';
import { buildSslOptions } from '../lib/db/pool';
import { parseDatabaseEnv } from '../lib/env';

const REQUEST_TIMEOUT_MS = 60_000; // Vercel 콜드 스타트 + 서버 렌더링
const RETRY_DELAY_MS = 2_000;
const GLOBALS_CSS = 'app/globals.css';
const USAGE = '사용법: npm run deploy:check -- --url <운영 URL> --env-file <env 파일> [--email <관리자>] [--password-file <파일>]';

type State = 'pass' | 'fail';

interface CheckResult {
  readonly name: string;
  readonly state: State;
  readonly detail: string;
}

interface Config {
  readonly baseUrl: string;
  readonly envFile: string;
  readonly email: string;
  readonly password: string;
}

/** 접속 정보는 env 파일에서, 비밀번호는 파일에서만 받는다 (명령줄 이력에 남지 않게) */
function readConfig(): Config {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'env-file': { type: 'string' },
      email: { type: 'string' },
      'password-file': { type: 'string' },
    },
  });
  const url = values.url;
  const envFile = values['env-file'];
  if (url === undefined || envFile === undefined) throw new Error(USAGE);
  if (!URL.canParse(url) || !new URL(url).protocol.startsWith('http')) throw new Error(`--url은 http(s):// 주소여야 합니다: ${url}`);

  const fileEnv = parseEnv(readFileSync(envFile, 'utf8'));
  const email = values.email ?? fileEnv.DEPLOY_CHECK_EMAIL;
  const passwordFile = values['password-file'];
  const password = passwordFile === undefined ? fileEnv.DEPLOY_CHECK_PASSWORD : readFileSync(passwordFile, 'utf8').trim();
  if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
    throw new Error(`관리자 계정이 필요합니다 (--email + --password-file, 또는 env 파일의 DEPLOY_CHECK_EMAIL·DEPLOY_CHECK_PASSWORD). ${USAGE}`);
  }
  return { baseUrl: url.replace(/\/$/, ''), envFile, email, password };
}

/** 서버 렌더링 HTML에서 React가 글자 사이에 넣는 주석(<!-- -->)을 지운다 — '이름 {값}'이 붙어 있는 글자로 읽히게 */
const plainHtml = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

/** 네트워크 오류만 한 번 다시 시도한다 (서버리스 연결이 가끔 끊긴다). HTTP 상태는 그대로 돌려준다 — 판정은 검사 쪽이 한다 */
async function request(url: string, init: RequestInit): Promise<Response> {
  const send = () => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  try {
    return await send();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return send();
  }
}

const get = (baseUrl: string, path: string, cookie?: string): Promise<Response> => request(`${baseUrl}${path}`, { headers: cookie === undefined ? {} : { cookie } });

/** om.pgmigrations(적용 목록)과 db/migrations(파일 목록)이 정확히 같은지 */
async function checkMigrations(pool: Pool): Promise<CheckResult> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM om.pgmigrations ORDER BY id');
  const parity = compareMigrations(readdirSync(MIGRATIONS_DIR), rows.map((row) => row.name));
  if (isParityOk(parity)) return { name: '마이그레이션 정합', state: 'pass', detail: `${rows.length}개 일치` };
  const missing = parity.missing.length === 0 ? '' : ` · 운영에 적용되지 않음: ${parity.missing.join(', ')}`;
  const extra = parity.extra.length === 0 ? '' : ` · 파일에 없음: ${parity.extra.join(', ')}`;
  return { name: '마이그레이션 정합', state: 'fail', detail: `적용 ${rows.length}개${missing}${extra}` };
}

/** 상세 경로에 쓸 실제 id (없으면 그 경로는 확인 목록에서 빠진다) */
async function readRouteIds(pool: Pool): Promise<RouteIds> {
  const first = async <T extends Record<string, unknown>>(text: string): Promise<T | null> => (await pool.query<T>(text)).rows[0] ?? null;
  const site = await first<{ code: string }>('SELECT code FROM om.site ORDER BY id LIMIT 1');
  const finding = await first<{ id: string }>('SELECT id::text AS id FROM om.finding ORDER BY id DESC LIMIT 1');
  const report = await first<{ id: string }>('SELECT id::text AS id FROM om.report ORDER BY id DESC LIMIT 1');
  return { siteCode: site?.code ?? null, findingId: finding?.id ?? null, reportId: report?.id ?? null };
}

async function checkAnonymous(baseUrl: string): Promise<CheckResult> {
  const wrong: string[] = [];
  for (const check of ANONYMOUS_CHECKS) {
    const response = await get(baseUrl, check.path);
    if (response.status !== check.status) wrong.push(`${check.path} ${response.status}(기대 ${check.status})`);
  }
  return wrong.length === 0
    ? { name: '비로그인 응답', state: 'pass', detail: `${ANONYMOUS_CHECKS.length}개 경로 기대대로 (화면 307 · 콘솔 API 401 · 로그인 화면 200)` }
    : { name: '비로그인 응답', state: 'fail', detail: wrong.join(' · ') };
}

/**
 * 관리자로 로그인해 세션 쿠키를 얻는다. 쿠키 값은 출력하지 않는다.
 * origin 헤더를 브라우저처럼 붙인다 — Better Auth는 origin이 없으면 MISSING_OR_NULL_ORIGIN으로 403을 낸다.
 * 그래서 --url이 BETTER_AUTH_URL·BETTER_AUTH_TRUSTED_ORIGINS에 없으면 여기서 막힌다 (그것도 확인 대상이다).
 */
async function signIn(config: Config): Promise<string> {
  const response = await request(`${config.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: config.baseUrl },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value !== '')
    .join('; ');
  if (!response.ok || cookie === '') throw new Error(`로그인 실패 (HTTP ${response.status}) — 관리자 계정과 BETTER_AUTH_* 설정을 확인하세요`);
  return cookie;
}

/** 경로마다 200인지, 그리고 본문에 그 화면이 그려졌다는 글자가 있는지 (스트리밍 중 오류로 200만 남는 경우를 잡는다) */
async function checkRoutes(baseUrl: string, cookie: string, ids: RouteIds): Promise<CheckResult> {
  const routes = consoleRoutes(ids);
  const failures: string[] = [];
  for (const route of routes) {
    const response = await get(baseUrl, route.path, cookie);
    if (response.status !== 200) {
      failures.push(`${route.label}(${route.path}) HTTP ${response.status}`);
      continue;
    }
    const html = plainHtml(await response.text());
    if (!html.includes(route.marker)) failures.push(`${route.label}(${route.path}) 본문에 "${route.marker}" 없음`);
  }
  const skipped = ids.reportId === null ? ' · 리포트 상세는 운영에 리포트가 없어 건너뜀' : '';
  return failures.length === 0
    ? { name: '주요 경로 응답', state: 'pass', detail: `${routes.length}개 경로 200 + 본문 확인${skipped}` }
    : { name: '주요 경로 응답', state: 'fail', detail: `${routes.length}개 중 ${failures.length}개 실패 — ${failures.join(' · ')}` };
}

/** 배포된 HTML이 부르는 CSS를 받아 소스 :root 토큰과 값이 같은지 본다 (옛 빌드가 배포된 사고를 잡는다) */
async function checkServedCss(baseUrl: string): Promise<CheckResult> {
  const name = '서빙 CSS 토큰';
  const html = await (await get(baseUrl, '/login')).text();
  const hrefs = stylesheetHrefs(html);
  if (hrefs.length === 0) return { name, state: 'fail', detail: '배포된 HTML에 stylesheet 링크가 없습니다' };

  const sheets: string[] = [];
  for (const href of hrefs) {
    const response = await get(baseUrl, href);
    if (!response.ok) return { name, state: 'fail', detail: `CSS를 받지 못했습니다: ${href} HTTP ${response.status}` };
    sheets.push(await response.text());
  }
  const { checked, mismatches } = compareTokens(readFileSync(GLOBALS_CSS, 'utf8'), sheets.join('\n'));
  if (mismatches.length === 0) return { name, state: 'pass', detail: `${hrefs.length}개 파일 · 토큰 ${checked}개 값 일치 (--ground 다크 값 포함)` };
  const detail = mismatches.map((m) => `${m.token} 소스 ${m.expected} · 배포 ${m.served.join(' / ') || '없음'}`).join(' · ');
  return { name, state: 'fail', detail: `토큰 ${checked}개 중 ${mismatches.length}개 다름 (옛 빌드가 배포됐을 수 있음) — ${detail}` };
}

/**
 * 필수 환경변수 간접 확인. getServerEnv()가 필수 변수를 한 번에 검증하므로 로그인과 화면 200이 이미 그 변수들을 증명한다.
 * 여기서는 선택 변수인 GEMINI_API_KEY가 운영에 들어갔는지 AI 설명 설정 화면의 글자로만 본다 (키 값은 화면에도 여기에도 나오지 않는다).
 */
async function checkEnv(baseUrl: string, cookie: string): Promise<CheckResult> {
  const name = '필수 환경변수(간접)';
  const html = plainHtml(await (await get(baseUrl, '/settings/ai', cookie)).text());
  if (html.includes('GEMINI_API_KEY 등록됨')) return { name, state: 'pass', detail: '필수 변수 통과(로그인·화면 렌더링) · GEMINI_API_KEY 등록됨' };
  if (html.includes('GEMINI_API_KEY 없음')) return { name, state: 'fail', detail: 'GEMINI_API_KEY가 운영에 없습니다 — AI 설명 없이 규칙 기반 요약만 나옵니다' };
  return { name, state: 'fail', detail: 'AI 설명 설정 화면에서 키 등록 여부를 읽지 못했습니다' };
}

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/; // 한글·한자 등 두 칸 폭 글자 (표 정렬용)
const width = (text: string): number => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);
const pad = (text: string, to: number): string => text + ' '.repeat(Math.max(0, to - width(text)));
const STATE_LABEL: Readonly<Record<State, string>> = { pass: '통과', fail: '실패' };

function printTable(results: readonly CheckResult[]): void {
  const nameWidth = Math.max(...results.map((result) => width(result.name)));
  console.log(`${pad('결과', 6)}${pad('항목', nameWidth)}  내용`);
  console.log('-'.repeat(nameWidth + 48));
  for (const result of results) console.log(`${pad(STATE_LABEL[result.state], 6)}${pad(result.name, nameWidth)}  ${result.detail}`);
}

async function main(): Promise<void> {
  const config = readConfig();
  const dbEnv = parseDatabaseEnv(parseEnv(readFileSync(config.envFile, 'utf8')));
  const dbUrl = new URL(dbEnv.DATABASE_URL);
  console.log(`[deploy:check] 대상 ${config.baseUrl} · DB ${dbUrl.hostname}${dbUrl.pathname} (SSL ${dbEnv.DATABASE_SSL}) · 읽기 전용`);

  const pool = new Pool({ connectionString: dbEnv.DATABASE_URL, ssl: buildSslOptions(dbEnv), max: 1 });
  const results: CheckResult[] = [];
  try {
    results.push(await checkMigrations(pool));
    const ids = await readRouteIds(pool);
    results.push(await checkAnonymous(config.baseUrl));
    const cookie = await signIn(config);
    results.push({ name: '관리자 로그인', state: 'pass', detail: `${config.email} 세션 발급됨` });
    results.push(await checkRoutes(config.baseUrl, cookie, ids));
    results.push(await checkServedCss(config.baseUrl));
    results.push(await checkEnv(config.baseUrl, cookie));
  } finally {
    await pool.end();
  }

  console.log('');
  printTable(results);
  const failed = results.filter((result) => result.state === 'fail');
  console.log('');
  console.log(failed.length === 0 ? `[deploy:check] 전부 통과 (${results.length}개 항목)` : `[deploy:check] 실패 ${failed.length}개: ${failed.map((result) => result.name).join(', ')}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[deploy:check] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
