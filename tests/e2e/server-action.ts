// E2E 공용: 로그인한 화면이 보내는 실제 Server Action 요청을 가로채 비로그인(쿠키 없음·위조 쿠키)으로 다시 보내 차단을 확인한다.
import { expect, type APIRequestContext, type Page, type Request } from '@playwright/test';

export interface CapturedAction {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export const FORGED_SESSION_COOKIE = 'better-auth.session_token=forged-token.forged-signature';

/** 로그인한 화면에서 Server Action 요청을 서버에 보내지 않고 가로챈다 (헤더·본문을 비로그인 재전송에 쓴다) */
export async function captureServerAction(page: Page, path: string, trigger: () => Promise<void>): Promise<CapturedAction> {
  let captured: Request | null = null;
  const matches = (url: URL): boolean => url.pathname === path;
  await page.route(matches, async (route) => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue();
    captured = route.request();
    await route.abort();
  });
  await trigger();
  await expect.poll(() => captured !== null).toBe(true);
  await page.unroute(matches);
  const request = captured as Request | null;
  if (!request) throw new Error(`${path} Server Action 요청을 가로채지 못했습니다`);
  const url = new URL(request.url());
  const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => name !== 'cookie'));
  return { path: `${url.pathname}${url.search}`, headers, body: request.postDataBuffer() ?? Buffer.alloc(0) };
}

/**
 * 쿠키 없음: proxy가 307로 로그인에 보낸다.
 * 위조 쿠키: proxy는 지나가지만 Server Action 첫 줄 requireAdmin()이 redirect — Next Server Action 규약대로 x-action-redirect: /login.
 * 어느 쪽이든 부작용이 없어야 하므로 호출한 쪽에서 저장 결과를 다시 확인한다.
 */
export async function expectBlocked(request: APIRequestContext, action: CapturedAction, cookie?: string): Promise<void> {
  const response = await request.post(action.path, { headers: { ...action.headers, ...(cookie ? { cookie } : {}) }, data: action.body, maxRedirects: 0 });
  const headers = response.headers();
  const detail = `${action.path}${cookie ? ' (위조 쿠키)' : ''} 응답 ${response.status()} location=${headers['location'] ?? ''} x-action-redirect=${headers['x-action-redirect'] ?? ''}`;
  if (cookie) {
    expect(headers['x-action-redirect'], detail).toMatch(/^\/login(;|$)/);
  } else {
    expect(response.status(), detail).toBe(307);
    expect(headers['location'], detail).toMatch(/\/login$/);
  }
}
