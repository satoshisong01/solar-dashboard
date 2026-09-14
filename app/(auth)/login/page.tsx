import type { Metadata } from 'next';
import { Hahmlet } from 'next/font/google';
import { redirect } from 'next/navigation';
import { BrandMark } from '@/components/console/brand-mark';
import { getSession } from '@/lib/auth/dal';
import { BRAND } from '@/lib/brand';
import { LoginForm } from './login-form';

// 브랜드 워드마크 전용. 이 페이지에서만 불러온다.
const wordmarkFont = Hahmlet({
  weight: '600',
  subsets: ['latin'],
  display: 'swap',
  fallback: ['Noto Serif KR', 'Georgia', 'serif'],
});

const QUERY_ERRORS: Readonly<Record<string, string>> = {
  forbidden: '관리자 권한이 없는 계정입니다.',
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: '로그인' };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [session, { error }] = await Promise.all([getSession(), searchParams]);
  // 비관리자 세션은 여기서 보내지 않는다: '/'의 requireAdmin()이 로그아웃시키고 다시 이리로 보낸다.
  if (session?.user.role === 'admin') redirect('/');

  const initialError = typeof error === 'string' ? QUERY_ERRORS[error] : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <BrandMark className="size-11" />
          <p className={`${wordmarkFont.className} mt-1 text-3xl leading-tight text-ink`}>{BRAND.name}</p>
          <p className="text-sm text-ink-2">
            {BRAND.nameKo} · {BRAND.tagline}
          </p>
        </div>

        <section className="flex flex-col gap-5 rounded-xl border border-rule bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-ink">관리자 로그인</h1>
          <LoginForm initialError={initialError} />
        </section>

        <p className="text-center text-sm text-muted">관리자 계정은 운영 담당자가 발급합니다.</p>
      </div>
    </main>
  );
}
