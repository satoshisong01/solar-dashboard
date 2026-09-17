'use client';

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import type { MapLevelCounts } from '@/lib/data/map-status';
import type { SiteMapStatus } from '@/lib/data/site-map';
import { formatAgo } from '@/lib/format';
import { MAP_LEVEL_META } from './map-level';
import { MAP_PANEL_CLASS, MapLevelCountList } from './map-summary';

type Props = Readonly<{
  sites: readonly SiteMapStatus[];
  counts: MapLevelCounts;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  nowMs: number;
  className?: string;
}>;

/** 상태 나쁜 순 목록. 항목을 누르면 그 발전소를 지도에서 고르고 확대한다 (사이트 화면으로 가지는 않는다) */
export function MapSiteList({ sites, counts, selectedCode, onSelect, nowMs, className = '' }: Props) {
  const [open, setOpen] = useState(true);
  const listId = useId();

  return (
    <div className={`${MAP_PANEL_CLASS} flex min-h-0 flex-col ${className}`}>
      <div className="flex flex-col gap-2 border-b border-rule px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">발전소 {sites.length}곳</h3>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={listId}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 max-lg:min-h-11 hover:bg-sunken hover:text-ink"
          >
            {open ? '접기' : '펴기'}
            <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} />
          </button>
        </div>
        <MapLevelCountList counts={counts} />
      </div>

      <ul id={listId} hidden={!open} className="min-h-0 flex-1 divide-y divide-rule overflow-y-auto">
        {sites.map((site) => {
          const { label, icon: Icon, dot } = MAP_LEVEL_META[site.level];
          const selected = site.code === selectedCode;
          return (
            <li key={site.code}>
              <button
                type="button"
                onClick={() => onSelect(site.code)}
                aria-current={selected ? 'true' : undefined}
                className={`flex w-full flex-col justify-center gap-0.5 px-3 py-2 text-left max-lg:min-h-11 hover:bg-sunken ${selected ? 'bg-sunken' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${dot}`} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{site.name}</span>
                  {site.openFindingCount > 0 && (
                    <span className="font-mono text-xs font-semibold text-ink tabular-nums">
                      {site.openFindingCount}
                      <span className="sr-only">건</span>
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1.5 pl-[1.125rem] text-xs text-muted">
                  <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                  {label} · {site.code} · 마지막 수신 {site.lastSeenMs === null ? '기록 없음' : formatAgo(site.lastSeenMs, nowMs)}
                  {(site.lat === null || site.lon === null) && ' · 지도 좌표 없음'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
