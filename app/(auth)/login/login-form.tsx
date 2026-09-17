'use client';

import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth/client';
import { clearRememberedEmail, readRememberedEmail, saveRememberedEmail } from '@/lib/auth/remember-email';

function toErrorMessage(status: number): string {
  if (status === 401) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (status === 403) return '로그인할 수 없는 계정입니다.';
  if (status === 429) return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
  return '로그인에 실패했습니다. 잠시 후 다시 시도하세요.';
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const errorId = useId();
  const rememberId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const rememberRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);

  // 저장된 아이디는 브라우저에만 있다. 서버 렌더링 결과와 어긋나지 않도록 마운트 뒤에 DOM으로 채운다.
  useEffect(() => {
    const saved = readRememberedEmail();
    if (saved === '') return;
    if (emailRef.current) emailRef.current.value = saved;
    if (rememberRef.current) rememberRef.current.checked = true;
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const remember = form.get('remember') !== null;
    setPending(true);
    setError(undefined);

    try {
      const result = await authClient.signIn.email({
        email,
        password: String(form.get('password') ?? ''),
      });
      if (!result.error) {
        if (remember) saveRememberedEmail(email); // 비밀번호는 저장하지 않는다
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
          <Input ref={emailRef} name="email" type="email" autoComplete="username" required aria-describedby={describedBy} />
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

        <div className="flex items-center gap-2">
          <input
            ref={rememberRef}
            id={rememberId}
            name="remember"
            type="checkbox"
            // 해제하면 저장값을 바로 지운다. 체크한 값은 로그인에 성공해야 저장한다.
            onChange={(event) => {
              if (!event.target.checked) clearRememberedEmail();
            }}
            className="size-6 shrink-0 accent-accent lg:size-4"
          />
          <label htmlFor={rememberId} className="text-sm text-ink-2">
            아이디 저장
          </label>
        </div>

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
