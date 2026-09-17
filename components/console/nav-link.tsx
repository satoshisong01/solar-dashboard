'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isActivePath } from './nav-items';
import { PendingLink } from './pending-link';

type NavLinkProps = Readonly<{ href: string; className: string; children: ReactNode }>;

/** 현재 경로면 aria-current="page"를 붙인다. 활성 모양은 호출부의 aria-[current=page]: 클래스가 정한다. */
export function NavLink({ href, className, children }: NavLinkProps) {
  const pathname = usePathname();

  return (
    <PendingLink href={href} className={className} current={isActivePath(pathname, href)}>
      {children}
    </PendingLink>
  );
}
