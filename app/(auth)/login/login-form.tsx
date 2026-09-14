'use client';

import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth/client';

function toErrorMessage(status: number): string {
  if (status === 401) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (status === 403) return '로그인할 수 없는 계정입니다.';
  if (status === 429) return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
  return '로그인에 실패했습니다. 잠시 후 다시 시도하세요.';
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const errorId = useId();
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);

    try {
      const result = await authClient.signIn.email({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if (!result.error) {
        router.replace('/'); // 이동이 끝날 때까지 제출 중 상태를 유지한다.
        return;
      }
      setError(toErrorMessage(result.error.status));
    } catch {
      setError(toErrorMessage(0)); // 네트워크 오류
    }
    setPending(false);
  }

  const describedBy = error ? errorId : undefined;

  return (
    <form onSubmit={handleSubmit}>
      <fieldset disabled={pending} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-2">이메일</span>
          <Input name="email" type="email" autoComplete="username" required aria-describedby={describedBy} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-2">비밀번호</span>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-describedby={describedBy}
          />
        </label>

        {error && (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" className="mt-1 w-full py-2.5">
          {pending && <LoaderCircle className="size-4 motion-safe:animate-spin" />}
          {pending ? '로그인 중…' : '로그인'}
        </Button>
      </fieldset>
    </form>
  );
}
