import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';
import { isSimConsoleEnabled } from '@/lib/data/sim-console';

/** 개발 플래그 화면. 플래그가 꺼져 있으면 실제 404 상태로 응답한다 */
const SIM_PATH = '/sim';

/**
 * 세션 쿠키가 없으면 로그인으로 보내는 낙관적 검사만 한다 (DB 조회 없음).
 * 쿠키가 있어도 유효하다는 뜻은 아니므로 실제 검사는 lib/auth/dal.ts의 requireAdmin()이 한다.
 * 콘솔 API(/api/series 등)는 화면이 아니므로 로그인으로 보내지 않고 401 JSON을 준다.
 * HYSOL_SHOW_SIM이 꺼져 있으면 /sim은 같은 경로로 rewrite하되 상태를 404로 둔다: 콘솔 loading.tsx 스트리밍 뒤의 notFound()는
 * 200으로 나가므로 여기서 상태만 정한다 (화면은 페이지의 notFound()가 그리는 '찾을 수 없습니다'). 로그인 검사가 먼저다.
 */
export function proxy(request: NextRequest): NextResponse {
  if (getSessionCookie(request)) {
    if (request.nextUrl.pathname === SIM_PATH && !isSimConsoleEnabled()) return NextResponse.rewrite(request.nextUrl, { status: 404 });
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // 제외: 로그인, auth 핸들러, 자체 인증하는 기계용 엔드포인트(ingest, cron), 정적 자산
  matcher: [
    '/((?!(?:login|api/auth|api/ingest|api/cron)(?:/|$)|_next/static/|_next/image|favicon\\.ico$).*)',
  ],
};
