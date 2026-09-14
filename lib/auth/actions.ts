'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from './auth';
import { requireAdmin } from './dal';

export async function signOutAction(): Promise<void> {
  await requireAdmin();
  // nextCookies 플러그인이 세션 쿠키 삭제를 응답에 반영한다.
  await getAuth().api.signOut({ headers: await headers() });
  redirect('/login');
}
