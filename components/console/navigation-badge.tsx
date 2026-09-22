'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SkeletonSpinner } from '@/components/ui/skeleton';

/** 이동이 끝나지 않아도 이만큼 지나면 배지를 내린다 (클릭이 이동으로 이어지지 않은 경우 계속 떠 있지 않게) */
const GIVE_UP_MS = 20_000;

/** 새 탭·다운로드·수정키 클릭처럼 이 화면이 바뀌지 않는 클릭 */
function opensElsewhere(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.target === '_blank' ||
    anchor.hasAttribute('download')
  );
}

/**
 * 앱 안의 링크를 눌러 서버를 기다리는 동안 진행 배지를 띄운다.
 *
 * 왜 전역인가: 이 버전에는 이동 상태를 알려 주는 전역 훅이 없고 useLinkStatus는 <Link> 자손에서만 쓸 수 있다.
 * 게다가 loading.tsx 골격은 클라이언트 이동에서 늘 뜨지는 않는다 — 목록에서 상세로 가거나(사이트 목록 → 사이트)
 * 같은 경계 안 형제 화면으로 옮길 때(설정 하위 탭)는 React가 이전 화면을 그대로 두어 아무 반응이 없어 보인다.
 *
 * 누른 주소를 기억해 두고 지금 주소와 다른 동안만 배지를 띄운다 — 이동이 끝나면 주소가 같아져 저절로 내려간다
 * (효과 안에서 상태를 바꾸지 않는다). 링크가 아닌 이동(router.push)은 부르는 쪽이 useTransition으로 직접 띄운다.
 */
export function NavigationBadge() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const [target, setTarget] = useState<string | null>(null);

  const here = query === '' ? pathname : `${pathname}?${query}`;
  const pending = target !== null && target !== here;

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return;
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement) || opensElsewhere(event, anchor)) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      setTarget(`${url.pathname}${url.search}`);
    }

    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  // 이동이 취소되거나 실패해도 배지가 남지 않게 한다
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setTarget(null), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return pending ? <SkeletonSpinner /> : null;
}
