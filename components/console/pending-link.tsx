'use client';

import Link, { useLinkStatus } from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

/** <Link> 안에서만 쓸 수 있다 (useLinkStatus 규칙). 이동이 시작되면 항목 아래에 진행 막대를 그리고 상위에 알린다.
 * 자리를 차지하지 않게 absolute로 둔다 — 막대가 생겨도 글자나 다른 항목이 밀리지 않는다. */
function PendingBar({ onPendingChange }: Readonly<{ onPendingChange: (pending: boolean) => void }>) {
  const { pending } = useLinkStatus();

  // aria-busy는 링크(<a>)에 붙어야 하므로 상태를 위로 알린다. useLinkStatus는 Link의 자손에서만 부를 수 있다.
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  if (!pending) return null;
  return <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded-b-md bg-accent motion-safe:animate-pulse" />;
}

type PendingLinkProps = Readonly<{
  href: string;
  className: string;
  /** 지금 보고 있는 화면이면 true (aria-current="page") */
  current: boolean;
  children: ReactNode;
}>;

/**
 * 메뉴·탭 링크. 누른 뒤 이동이 끝날 때까지 그 항목에 진행 막대와 aria-busy를 두고 다시 눌리지 않게 막는다.
 * 목적지 화면의 골격(loading.tsx)은 이와 별개로 바로 뜬다 — 이 표시는 골격이 뜨기 전 공백을 메운다.
 */
export function PendingLink({ href, className, current, children }: PendingLinkProps) {
  const [pending, setPending] = useState(false);

  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      aria-busy={pending || undefined}
      className={`relative ${className} aria-busy:cursor-progress aria-busy:pointer-events-none`}
    >
      {children}
      <PendingBar onPendingChange={setPending} />
    </Link>
  );
}
