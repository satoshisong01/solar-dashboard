import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getAuth } from './auth';

/** 요청당 한 번만 DB에서 세션을 조회한다. 없으면 null. */
export const getSession = cache(async () => {
  // headers()를 먼저 기다린다: 빌드 시 정적 렌더가 여기서 멈춰야 getAuth()가 환경변수를 읽지 않는다.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

/**
 * 콘솔의 모든 page, Server Action, Route Handler 첫 줄에서 호출한다.
 * proxy.ts는 쿠키 존재만 보므로 실제 권한 검사는 여기서 한다.
 */
export const requireAdmin = cache(async () => {
  const session = await getSession();
  if (!session) redirect('/login');

  if (session.user.role !== 'admin') {
    await getAuth().api.signOut({ headers: await headers() });
    redirect('/login?error=forbidden');
  }

  return session;
});
