import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * 세션 쿠키가 없으면 로그인으로 보내는 낙관적 검사만 한다 (DB 조회 없음).
 * 쿠키가 있어도 유효하다는 뜻은 아니므로 실제 검사는 lib/auth/dal.ts의 requireAdmin()이 한다.
 */
export function proxy(request: NextRequest): NextResponse {
  if (getSessionCookie(request)) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // 제외: 로그인, auth 핸들러, 자체 인증하는 기계용 엔드포인트(ingest, cron), 정적 자산
  matcher: [
    '/((?!(?:login|api/auth|api/ingest|api/cron)(?:/|$)|_next/static/|_next/image|favicon\\.ico$).*)',
  ],
};
