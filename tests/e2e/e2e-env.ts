// E2E 공용 상수. playwright.config.ts, globalSetup, 테스트가 함께 쓴다.
import { TEST_ENV_FILE, readTestEnvFile } from '../support/test-env';

export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const ADMIN_STORAGE_STATE = 'tests/e2e/.auth/admin.json';
export const E2E_ADMIN_EMAIL = 'e2e-admin@hysol.local';
export const E2E_ADMIN_NAME = 'E2E 관리자';

/** globalSetup이 시뮬레이터로 최근 데이터를 수집 API로 적재하는 가상 사이트 (SIM-A는 폐루프 픽스처 과거 기간만, SIM-C는 수신 기록 없음) */
export const E2E_INGEST_SITE = 'SIM-B';

/** 로그인이 필요 없는 상태. test.use({ storageState: SIGNED_OUT })로 쓴다. */
export const SIGNED_OUT = Object.freeze({ cookies: [], origins: [] });

/** 설계 §4 IA의 콘솔 메뉴. 구현 상수를 가져오지 않고 기대값으로 따로 적는다. */
export const CONSOLE_ROUTES = Object.freeze([
  { href: '/', title: '오늘' },
  { href: '/fleet', title: '플릿' },
  { href: '/sites', title: '사이트' },
  { href: '/explore', title: '탐색기' },
  { href: '/desk', title: '분석 데스크' },
  { href: '/reports', title: '코칭 리포트' },
  { href: '/actions', title: '조치 추적' },
  { href: '/safety', title: '안전' },
  { href: '/data', title: '데이터' },
  { href: '/settings', title: '설정' },
]);

export function getE2eAdminPassword(): string {
  const password = readTestEnvFile().E2E_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error(`${TEST_ENV_FILE}에 E2E_ADMIN_PASSWORD(12자 이상)를 넣으세요. 테스트 관리자 계정 비밀번호로 쓰입니다.`);
  }
  return password;
}
