// 지도 위 요약: 왼쪽 위 상태 칩과 목록 머리의 수준별 건수.
import { MAP_LEVELS, hasAlerts, type MapLevelCounts } from '@/lib/data/map-status';
import { MAP_LEVEL_META } from './map-level';

const PANEL_CLASS = 'rounded-lg border border-rule bg-surface/95 shadow-lg backdrop-blur-sm';

/** 왼쪽 위 상태 칩: 전체가 정상인지와 열린 발견사항 수 */
export function MapStatusChip({ counts, openFindings, className = '' }: Readonly<{ counts: MapLevelCounts; openFindings: number; className?: string }>) {
  const alert = hasAlerts(counts);
  return (
    <div className={`${PANEL_CLASS} flex items-center gap-4 px-3 py-2 ${className}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${alert ? 'bg-map-crit' : 'bg-map-ok'}`} />
        <div className="flex flex-col">
          <span className="text-[0.625rem] tracking-wider text-muted uppercase">전체 상태</span>
          <span className="text-sm font-semibold text-ink">{alert ? '확인 필요' : '특이사항 없음'}</span>
        </div>
      </div>
      <div className="h-8 w-px shrink-0 bg-rule" />
      <div className="flex flex-col">
        <span className="text-[0.625rem] tracking-wider text-muted uppercase">열린 발견사항</span>
        <span className={`text-sm font-semibold ${openFindings > 0 ? 'text-crit' : 'text-muted'}`}>
          {openFindings > 0 ? `${openFindings}건` : '없음'}
        </span>
      </div>
    </div>
  );
}

/** '바로 확인 N · 주의 N · 정상 N · 수신 없음 N' */
export function MapLevelCountList({ counts }: Readonly<{ counts: MapLevelCounts }>) {
  return (
    <ul aria-label="상태 요약" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {MAP_LEVELS.map((level) => (
        <li key={level} className="flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${MAP_LEVEL_META[level].dot}`} />
          {MAP_LEVEL_META[level].label}
          <span className="font-mono font-semibold text-ink tabular-nums">{counts[level]}</span>
        </li>
      ))}
    </ul>
  );
}

export { PANEL_CLASS as MAP_PANEL_CLASS };
