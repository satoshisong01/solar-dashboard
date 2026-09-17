'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** 좁은 폭에서 탭이 넘칠 때 가로로 스크롤되는 띠. 스크롤바는 숨기고, 지금 화면의 탭을 보이는 곳으로 끌어온다. */
export function TabScroller({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, []);

  return (
    <nav ref={ref} aria-label={label} className="no-scrollbar -mt-2 overflow-x-auto">
      {children}
    </nav>
  );
}
