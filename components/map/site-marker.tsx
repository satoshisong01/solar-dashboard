'use client';

import Link from 'next/link';
import { SITE_DOMAIN_LABELS } from '@/lib/data/domains';
import type { SiteMapStatus } from '@/lib/data/site-map';
import { formatAgo } from '@/lib/format';
import { MAP_LEVEL_META } from './map-level';

/** 라벨 카드 크기 (겹침 계산과 같은 값을 써야 한다) */
export const MARKER_LABEL = { width: 168, height: 46, offsetY: 20, markerRadius: 22 } as const;

type Props = Readonly<{
  site: SiteMapStatus;
  /** 선택했거나 마우스를 올린 상태: 크게·진하게 그리고 말풍선을 펼친다 */
  active: boolean;
  /** 겹쳐서 라벨 카드를 접었는가 (마커 원과 상태색은 남는다) */
  labelHidden: boolean;
  /** 작게 그린다 (오늘 화면에서 문제 없는 곳) */
  subdued?: boolean;
  onSelect: () => void;
  nowMs: number;
}>;

/**
 * 지도 마커: 상태색 원 + 열린 발견사항 수 배지 + 이름 카드.
 * 마우스를 올리거나 포커스가 오면 그 발전소를 고르고(오른쪽 패널이 따라온다) 카드가 말풍선으로 펼쳐진다.
 * 누르면 사이트 화면으로 간다.
 */
export function SiteMarker({ site, active, labelHidden, subdued = false, onSelect, nowMs }: Props) {
  const { label, icon: Icon, marker } = MAP_LEVEL_META[site.level];
  const domains = site.domains.map((domain) => SITE_DOMAIN_LABELS[domain]).join('·');

  return (
    <Link
      href={`/sites/${encodeURIComponent(site.code)}`}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') onSelect();
      }}
      onFocus={onSelect}
      aria-label={`${site.name} ${site.code} · ${label} · 열린 발견사항 ${site.openFindingCount}건 · 사이트 화면 열기`}
      className={`flex w-[168px] flex-col items-center outline-offset-4 transition-transform duration-200 motion-reduce:transition-none ${active ? 'scale-110' : ''}`}
    >
      <span className="relative flex shrink-0 items-center justify-center">
        <span
          className={`flex items-center justify-center rounded-full ring-2 ring-white ${subdued ? 'size-5' : 'size-8'} ${marker} ${
            active ? 'shadow-[0_6px_16px_rgba(0,0,0,0.45)] ring-[3px]' : 'shadow-[0_2px_6px_rgba(0,0,0,0.3)]'
          }`}
        >
          <Icon aria-hidden="true" className={subdued ? 'size-3' : 'size-4'} />
        </span>
        {site.openFindingCount > 0 && !subdued && (
          <span className="absolute -top-1.5 -right-2 rounded-full border border-rule-strong bg-surface px-1.5 font-mono text-[0.625rem] leading-4 font-semibold text-ink shadow-overlay tabular-nums">
            {site.openFindingCount}
            <span className="sr-only">건</span>
          </span>
        )}
      </span>

      {!labelHidden && (
        <span
          className={`mt-2 flex w-full flex-col gap-0.5 rounded-md border bg-surface/95 px-2.5 py-1.5 text-center shadow-overlay backdrop-blur-sm ${
            active ? 'border-accent' : 'border-rule-strong'
          }`}
        >
          <span className="truncate text-xs font-semibold text-ink">{site.name}</span>
          <span className="text-[0.625rem] text-muted">
            {site.code}
            {domains !== '' && ` · ${domains}`}
          </span>
          {active && (
            <span className="mt-1 flex flex-col gap-0.5 border-t border-rule pt-1 text-left">
              <span className="text-[0.6875rem] text-pretty text-ink-2">
                {site.worstFinding === null ? '현재 특이사항 없음' : site.worstFinding.headline}
              </span>
              <span className="text-[0.625rem] text-muted">
                {label} · 열린 발견사항 {site.openFindingCount}건 · 마지막 수신{' '}
                {site.lastSeenMs === null ? '기록 없음' : formatAgo(site.lastSeenMs, nowMs)}
              </span>
            </span>
          )}
        </span>
      )}
    </Link>
  );
}
