import * as z from 'zod';

const SSL_URL_PARAMS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'] as const;
// 표준 base64로 인코딩한 32바이트 = 43자 + '=' 패딩 1자
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/** dotenv는 `KEY=`를 빈 문자열로 넣는다. 선택 변수는 빈 값을 "설정 안 함"으로 본다. */
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** 파싱할 수 없는 URL은 z.url()이 따로 오류를 내므로 여기서는 false로 둔다. */
function hasSslUrlParams(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { searchParams } = new URL(value);
  return SSL_URL_PARAMS.some((param) => searchParams.has(param));
}

const trustedOriginsSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((value) => (value ?? '').split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(
      z.array(
        z.url({ protocol: /^https?$/, error: '쉼표로 구분한 http(s):// origin 목록이어야 합니다' }),
      ),
    ),
);

// 서버 전용 환경변수. 새 변수는 이 객체에 필드를 추가한다.
const serverEnvSchema = z
  .object({
    DATABASE_URL: z
      .url({
        protocol: /^postgres(ql)?$/,
        error: 'postgres:// 형식의 URL이어야 합니다',
      })
      // pg는 URL의 ssl 파라미터가 풀 설정의 ssl을 덮어쓴다. SSL은 DATABASE_SSL 한 곳에서만 정한다.
      .refine((value) => !hasSslUrlParams(value), {
        error: 'DATABASE_URL에 sslmode 등 SSL 파라미터를 넣지 말고 DATABASE_SSL을 사용하세요',
      }),
    DATABASE_SSL: z.preprocess(
      emptyToUndefined,
      z
        .enum(['disable', 'require', 'verify-full'], { error: 'disable, require, verify-full 중 하나여야 합니다' })
        .default('disable'),
    ),
    DATABASE_SSL_CA_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
    INGEST_KEY_ENC_KEY: z.string().regex(BASE64_32_BYTES, 'base64로 인코딩한 32바이트 키여야 합니다'),
    BETTER_AUTH_SECRET: z.string().min(32, '32자 이상의 랜덤 문자열이어야 합니다'),
    BETTER_AUTH_URL: z.url({
      protocol: /^https?$/,
      error: 'http(s):// 형식의 URL이어야 합니다',
    }),
    BETTER_AUTH_TRUSTED_ORIGINS: trustedOriginsSchema,
  })
  .refine((env) => env.DATABASE_SSL !== 'verify-full' || env.DATABASE_SSL_CA_PATH !== undefined, {
    path: ['DATABASE_SSL_CA_PATH'],
    error: 'DATABASE_SSL=verify-full이면 CA 번들 파일 경로가 필요합니다',
  });

type ParsedServerEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = Readonly<
  Omit<ParsedServerEnv, 'BETTER_AUTH_TRUSTED_ORIGINS'> & { BETTER_AUTH_TRUSTED_ORIGINS: readonly string[] }
>;

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

  cached = Object.freeze({
    ...result.data,
    BETTER_AUTH_TRUSTED_ORIGINS: Object.freeze([...result.data.BETTER_AUTH_TRUSTED_ORIGINS]),
  });
  return cached;
}
