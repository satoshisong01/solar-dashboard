// 관리자 계정을 만든다 (가입이 비활성이어도 동작).
//   npm run admin:create -- --email admin@hysol.local --password '<12자 이상>' --name 관리자
// admin 플러그인의 서버 API(auth.api.createUser)를 헤더 없이 호출한다. 공식 `auth create-admin` CLI와 같은 방식이다.
import { APIError } from 'better-auth';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { createAuth } from '../lib/auth/create-auth';
import { getPool } from '../lib/db/pool';

const argsSchema = z.object({
  email: z.email('올바른 이메일이 아닙니다'),
  password: z.string().min(12, '비밀번호는 12자 이상이어야 합니다').max(128, '비밀번호는 128자 이하여야 합니다'),
  name: z.string().trim().min(1, '이름이 필요합니다'),
});

function readArgs(): z.infer<typeof argsSchema> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
    },
  });
  const result = argsSchema.safeParse(values);
  if (!result.success) {
    throw new Error(`인자 오류 (--email --password --name 필요)\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof APIError && error.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';
}

async function main(): Promise<void> {
  const args = readArgs();
  const auth = createAuth(); // 여기서 환경변수 검증과 풀 생성이 일어난다

  try {
    const { user } = await auth.api.createUser({ body: { ...args, role: 'admin' } });
    console.log(`[admin] 관리자 생성 완료: ${user.email} (id: ${user.id})`);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    console.log(`[admin] 이미 등록된 이메일입니다: ${args.email.toLowerCase()} — 새로 만들지 않고 종료합니다.`);
  } finally {
    await getPool().end();
  }
}

main().catch((error: unknown) => {
  console.error('[admin] 생성 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
