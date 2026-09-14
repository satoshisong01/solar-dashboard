import * as z from 'zod';

// 서버 전용 환경변수. 인증 등 다음 단계 변수는 이 객체에 필드를 추가한다.
const serverEnvSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'postgres:// 형식의 URL이어야 합니다',
  }),
});

export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;

let cached: ServerEnv | undefined;

/**
 * import 시점이 아니라 첫 호출 시점에 검증한다.
 * 그래야 환경변수 없이도 `next build`가 통과한다.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`서버 환경변수 설정 오류\n${z.prettifyError(result.error)}`);
  }

  cached = Object.freeze(result.data);
  return cached;
}
