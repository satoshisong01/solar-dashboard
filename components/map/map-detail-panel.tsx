'use client';

import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { SITE_DOMAIN_LABELS } from '@/lib/data/domains';
import type { MapKpiTile } from '@/lib/data/map-kpi';
import type { FleetMapSite } from '@/lib/data/site-map-board';
import { formatAgo, formatNumber } from '@/lib/format';
import { MapCurve } from './map-curve';
import { MapLevelBadge } from './map-level';
import { MAP_PANEL_CLASS } from './map-summary';

function KpiTile({ tile }: Readonly<{ tile: MapKpiTile }>) {
  const value = !tile.present ? '해당 없음' : tile.value === null ? '데이터 없음' : formatNumber(tile.value, tile.digits);
  const plain = tile.present && tile.value !== null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-rule bg-sunken px-2.5 py-2" title={tile.note}>
      <span className="truncate text-[0.625rem] text-muted">{tile.label}</span>
      <span className={plain ? 'font-mono text-base font-semibold text-ink tabular-nums' : 'text-xs text-muted'}>
        {value}
        {plain && <span className="ml-1 font-sans text-[0.625rem] font-normal text-muted">{tile.unit}</span>}
      </span>
    </div>
  );
}

/**
 * 고른 발전소 한 곳의 상세: 상태 · 오늘 수치 타일 4개 · 시간대별 발전 곡선 · 가장 심각한 발견사항 한 줄.
 * 수치는 모두 조회에서 온 값이고, 없으면 '해당 없음'·'데이터 없음'으로 구분해 적는다 (0으로 꾸미지 않는다).
 */
export function MapDetailPanel({ site, nowMs, className = '' }: Readonly<{ site: FleetMapSite; nowMs: number; className?: string }>) {
  const domains = site.domains.map((domain) => SITE_DOMAIN_LABELS[domain]).join('·');
  const tone = site.domains.includes('pv') ? 'solar' : 'hydrogen';

  return (
    <aside aria-label="선택한 발전소" className={`${MAP_PANEL_CLASS} flex min-h-0 flex-col gap-3 overflow-y-auto p-3 ${className}`}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-base font-semibold text-ink">{site.name}</h3>
          <MapLevelBadge level={site.level} className="shrink-0" />
        </div>
        <p className="text-xs text-muted">
          {site.code}
          {domains !== '' && ` · ${domains}`} · 마지막 수신 {site.lastSeenMs === null ? '기록 없음' : formatAgo(site.lastSeenMs, nowMs)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {site.tiles.map((tile) => (
          <KpiTile key={tile.key} tile={tile} />
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs text-ink-2">{site.curveLabel}</p>
        <MapCurve curve={site.curve} label={site.curveLabel} unit={site.curveUnit} tone={tone} />
      </div>

      {/* 저장된 AI 문장이 있으면 그것을, 없으면 분석 엔진 값을 쉬운 말로 푼 틀 문장을 쓴다. 배지가 그 출처를 밝힌다 */}
      <div className="flex flex-col gap-1.5 rounded-md border border-accent/40 bg-hydrogen-fill px-2.5 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Sparkles aria-hidden="true" className="size-3.5" />
          AI 진단 리포트
          <span className="rounded-full border border-rule bg-surface px-1.5 py-px text-[0.625rem] font-normal text-muted">
            {site.worstFinding?.headlineSource === 'llm' ? 'AI가 작성 · 수치는 분석 엔진 값' : '규칙 기반 요약'}
          </span>
        </p>
        <p className="text-xs text-pretty text-ink-2">{site.worstFinding === null ? '현재 특이사항 없음' : site.worstFinding.headline}</p>
        {site.worstFinding !== null && (
          <Link href={`/desk/${site.worstFinding.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            근거 보기
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </div>

      <Link
        href={`/sites/${encodeURIComponent(site.code)}`}
        className="inline-flex items-center justify-center gap-1 rounded-md border border-rule px-3 py-1.5 text-sm font-medium text-ink hover:bg-sunken"
      >
        사이트 화면 열기
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </aside>
  );
}
