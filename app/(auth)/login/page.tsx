import { LoginForm } from './login-form';

const QUERY_ERRORS: Readonly<Record<string, string>> = {
  forbidden: '관리자 권한이 없는 계정입니다.',
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// 최소 동작 폼. 디자인은 다음 단계(콘솔 셸)에서 한다.
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;
  const initialError = typeof error === 'string' ? QUERY_ERRORS[error] : undefined;

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold">HySol Desk 관리자 로그인</h1>
      <LoginForm initialError={initialError} />
    </main>
  );
}
