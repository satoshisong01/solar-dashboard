import 'server-only';
import { getSession } from './dal';

/**
 * 콘솔용 Route Handler 첫 줄에서 호출한다. 통과하면 null, 아니면 그대로 돌려줄 JSON 응답.
 * 페이지용 requireAdmin()과 달리 로그인 화면으로 보내지 않는다.
 *   const denied = await requireAdminApi();
 *   if (denied) return denied;
 */
export async function requireAdminApi(): Promise<Response | null> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return Response.json({ error: 'forbidden' }, { status: 403 });
  return null;
}
