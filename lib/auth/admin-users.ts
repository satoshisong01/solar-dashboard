import 'server-only';
import { APIError } from 'better-auth';
import { headers } from 'next/headers';
import { getAuth } from './auth';

// 관리자 계정 관리. Better Auth admin 플러그인 API를 현재 요청의 세션 헤더로 부른다 (플러그인이 권한을 한 번 더 확인한다).
// 호출 전 requireAdmin()은 Server Action·page가 한다.

const LIST_LIMIT = 200;

export interface ConsoleUserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string | null;
  readonly banned: boolean;
  readonly banReason: string | null;
  readonly createdAtMs: number;
}

export async function listConsoleUsers(): Promise<Readonly<{ total: number; users: readonly ConsoleUserRow[] }>> {
  const result = await getAuth().api.listUsers({
    query: { limit: LIST_LIMIT, sortBy: 'createdAt', sortDirection: 'asc' },
    headers: await headers(),
  });
  return {
    total: result.total,
    users: result.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role ?? null,
      banned: user.banned === true,
      banReason: user.banReason ?? null,
      createdAtMs: new Date(user.createdAt).getTime(),
    })),
  };
}

export type UserOpResult = Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '이미 등록된 이메일입니다.',
  USER_NOT_FOUND: '사용자를 찾을 수 없습니다.',
  YOU_CANNOT_BAN_YOURSELF: '자기 자신은 비활성할 수 없습니다.',
  INVALID_EMAIL: '올바른 이메일이 아닙니다.',
};

/** Better Auth API 오류를 화면 문구로 바꾼다. 알 수 없는 오류는 다시 던진다 (서버 로그에 남도록) */
async function run(operation: () => Promise<unknown>, fallback: string): Promise<UserOpResult> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    const code = typeof error.body?.code === 'string' ? error.body.code : '';
    return { ok: false, message: ERROR_MESSAGES[code] ?? fallback };
  }
}

export async function createConsoleAdmin(input: Readonly<{ email: string; name: string; password: string }>): Promise<UserOpResult> {
  const requestHeaders = await headers();
  return run(
    () => getAuth().api.createUser({ body: { email: input.email, name: input.name, password: input.password, role: 'admin' }, headers: requestHeaders }),
    '계정을 만들지 못했습니다.',
  );
}

export async function banConsoleUser(userId: string, actorEmail: string): Promise<UserOpResult> {
  const requestHeaders = await headers();
  return run(
    () => getAuth().api.banUser({ body: { userId, banReason: `콘솔에서 비활성 (${actorEmail})` }, headers: requestHeaders }),
    '계정을 비활성하지 못했습니다.',
  );
}

export async function unbanConsoleUser(userId: string): Promise<UserOpResult> {
  const requestHeaders = await headers();
  return run(() => getAuth().api.unbanUser({ body: { userId }, headers: requestHeaders }), '계정을 다시 활성하지 못했습니다.');
}

export async function revokeConsoleUserSessions(userId: string): Promise<UserOpResult> {
  const requestHeaders = await headers();
  return run(() => getAuth().api.revokeUserSessions({ body: { userId }, headers: requestHeaders }), '세션을 폐기하지 못했습니다.');
}
