'use client';

import { usePathname } from 'next/navigation';
import { isActivePath, navGroupsFor } from './nav-items';

// 레이아웃은 내비게이션 때 다시 렌더되지 않으므로 경로 기반 제목은 클라이언트에서 계산한다.
export function CurrentTitle({ showSim }: Readonly<{ showSim: boolean }>) {
  const pathname = usePathname();
  const match = navGroupsFor(showSim).flatMap((group) => group.items.map((item) => ({ group: group.label, item }))).find(
    ({ item }) => isActivePath(pathname, item.href),
  );

  if (!match) return null;

  return (
    <p className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 font-mono text-xs text-muted">{match.group}</span>
      <span aria-hidden="true" className="text-rule-strong">
        /
      </span>
      <span className="truncate font-medium text-ink">{match.item.label}</span>
    </p>
  );
}
