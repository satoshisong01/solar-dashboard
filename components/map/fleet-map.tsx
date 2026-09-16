'use client';

import { useCallback, useState } from 'react';
import { EmptyNote } from '@/components/ui/panel';
import { countMapLevels } from '@/lib/data/map-status';
import type { FleetMapSite } from '@/lib/data/site-map-board';
import { MapDetailPanel } from './map-detail-panel';
import { MapSiteList } from './map-site-list';
import { MapStatusChip } from './map-summary';
import { KOREA_VIEW, SiteMapCanvas, type FitPadding, type MapView } from './site-map-canvas';

/** 목록에서 고른 발전소로 다가갈 때의 확대 수준 */
const FOCUS_LEVEL = 9;
/** 지도 위에 뜬 패널과 마커 라벨이 겹치지 않을 여백(px). 왼쪽은 목록, 오른쪽은 상세 패널이 차지한다 */
const FIT_PADDING: FitPadding = { top: 96, right: 360, bottom: 64, left: 320 };
const FALLBACK_LABEL = '아래 목록에서 발전소 상태를 확인하세요.';

/**
 * 플릿 지도. 지도가 화면을 채우고 요약 칩·목록·상세가 그 위에 뜬다 (좁은 화면에서는 지도 아래로 쌓인다).
 * 마커는 누르면 사이트 화면으로 가고, 마우스를 올리거나 목록에서 고르면 오른쪽 상세가 그 발전소로 바뀐다.
 */
export function FleetMapBoard({ sites, nowMs }: Readonly<{ sites: readonly FleetMapSite[]; nowMs: number }>) {
  const [selectedCode, setSelectedCode] = useState<string | null>(sites[0]?.code ?? null);
  const [view, setView] = useState<MapView>(KOREA_VIEW);

  const selected = sites.find((site) => site.code === selectedCode) ?? sites[0] ?? null;
  const counts = countMapLevels(sites);
  const openFindings = sites.reduce((total, site) => total + site.openFindingCount, 0);

  /** 목록에서 고르면 그 마커로 다가간다 (레거시의 선택 강조: 확대 + 마커 확대·그림자) */
  const focus = useCallback(
    (code: string) => {
      setSelectedCode(code);
      const site = sites.find((entry) => entry.code === code);
      if (site?.lat != null && site.lon != null) setView({ center: { lat: site.lat, lng: site.lon }, level: FOCUS_LEVEL });
    },
    [sites],
  );

  if (sites.length === 0) return <EmptyNote>등록된 사이트가 없습니다</EmptyNote>;

  return (
    <div className="flex flex-col gap-3 lg:relative lg:h-[min(76vh,42rem)] lg:gap-0">
      <div className="relative h-80 overflow-hidden rounded-lg border border-rule bg-sunken sm:h-96 lg:absolute lg:inset-0 lg:h-auto">
        <SiteMapCanvas
          sites={sites}
          view={view}
          padding={FIT_PADDING}
          selectedCode={selected?.code ?? null}
          onSelect={setSelectedCode}
          nowMs={nowMs}
          label={FALLBACK_LABEL}
        />
      </div>

      <MapStatusChip counts={counts} openFindings={openFindings} className="lg:absolute lg:top-3 lg:left-3 lg:z-10 lg:w-72" />
      <MapSiteList
        sites={sites}
        counts={counts}
        selectedCode={selected?.code ?? null}
        onSelect={focus}
        nowMs={nowMs}
        className="max-h-96 lg:absolute lg:top-24 lg:bottom-3 lg:left-3 lg:z-10 lg:max-h-none lg:w-72"
      />
      {selected !== null && <MapDetailPanel site={selected} nowMs={nowMs} className="lg:absolute lg:top-3 lg:right-3 lg:bottom-3 lg:z-10 lg:w-80" />}
    </div>
  );
}
