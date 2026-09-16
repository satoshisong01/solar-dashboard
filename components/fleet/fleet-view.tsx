'use client';

import { LayoutGrid, Map as MapIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { FleetMapBoard } from '@/components/map/fleet-map';
import type { FleetMapSite } from '@/lib/data/site-map-board';

type View = 'matrix' | 'map';

const TOGGLE_CLASS =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-ink-2 hover:text-ink ' +
  'aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-sm';

/** 매트릭스(서버 렌더)와 지도 보기 전환. 지도 SDK는 지도 보기를 처음 열 때 불러온다 */
export function FleetView({ matrix, sites, nowMs }: Readonly<{ matrix: ReactNode; sites: readonly FleetMapSite[]; nowMs: number }>) {
  const [view, setView] = useState<View>('matrix');

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="보기 전환" className="inline-flex w-fit gap-1 rounded-lg border border-rule bg-sunken p-1">
        <button type="button" aria-pressed={view === 'matrix'} onClick={() => setView('matrix')} className={TOGGLE_CLASS}>
          <LayoutGrid aria-hidden="true" className="size-4" />
          매트릭스
        </button>
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')} className={TOGGLE_CLASS}>
          <MapIcon aria-hidden="true" className="size-4" />
          지도
        </button>
      </div>
      {view === 'matrix' ? matrix : <FleetMapBoard sites={sites} nowMs={nowMs} />}
    </div>
  );
}
