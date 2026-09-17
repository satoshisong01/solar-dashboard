'use client';

import { ArrowRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { MapLevelCountList } from '@/components/map/map-summary';
import { KOREA_VIEW, SiteMapCanvas, type FitPadding } from '@/components/map/site-map-canvas';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { countMapLevels } from '@/lib/data/map-status';
import type { SiteMapStatus } from '@/lib/data/site-map';

/** 작은 지도라 여백을 좁게 둔다 */
const FIT_PADDING: FitPadding = { top: 44, right: 88, bottom: 44, left: 88 };
const LINK_CLASS = 'inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline';

/**
 * 대시보드 화면의 지도 카드. 문제가 있는 발전소만 크게·이름과 함께 그리고 정상·수신 없음은 작은 점으로 둔다.
 * 마커를 누르면 그 사이트 화면으로 가고, 전체 보기는 플릿 지도로 간다.
 */
export function SiteMapCard({ sites, nowMs }: Readonly<{ sites: readonly SiteMapStatus[]; nowMs: number }>) {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const mapId = useId();
  const counts = countMapLevels(sites);

  return (
    <Panel
      title="발전소 지도"
      meta="열린 발견사항 기준 · 문제 있는 곳만 크게"
      action={
        <Link href="/fleet" className={LINK_CLASS}>
          지도 전체 보기
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      {sites.length === 0 ? (
        <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MapLevelCountList counts={counts} />
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls={mapId}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 max-lg:min-h-11 hover:bg-sunken hover:text-ink"
            >
              지도 {open ? '접기' : '펴기'}
              <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} />
            </button>
          </div>
          <div id={mapId} hidden={!open} className="relative h-56 overflow-hidden rounded-md border border-rule bg-sunken sm:h-72">
            <SiteMapCanvas
              sites={sites}
              view={KOREA_VIEW}
              padding={FIT_PADDING}
              selectedCode={selectedCode}
              onSelect={setSelectedCode}
              nowMs={nowMs}
              subdueHealthy
              label="위 요약과 플릿 화면에서 상태를 확인하세요."
            />
          </div>
        </div>
      )}
    </Panel>
  );
}
