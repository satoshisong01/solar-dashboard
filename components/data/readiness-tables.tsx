import { CircleCheck, CircleMinus, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { cellDisplay, RECOMMENDED_LABEL, type AcquisitionView, type CellIcon, type CellTone, type ReadinessRow } from '@/lib/analytics/readiness';
import { detectorLabel } from '@/lib/desk/labels';

const ICONS: Readonly<Record<CellIcon, LucideIcon>> = { check: CircleCheck, alert: TriangleAlert, cross: CircleX, dash: CircleMinus };

const TONES: Readonly<Record<CellTone, string>> = {
  ok: 'border-ok/40 bg-ok-fill text-ok',
  warn: 'border-warn/40 bg-warn-fill text-warn',
  crit: 'border-crit/40 bg-crit-fill text-crit',
  na: 'border-rule bg-surface text-muted',
};

type MatrixRow = ReadinessRow & { readonly className: string };

/** 설비(행) × 탐지기(열). 셀은 아이콘·짧은 글자·툴팁(사유·누락 메트릭)을 함께 쓴다 (색만으로 구분하지 않음). '*'는 권장 메트릭 누락 */
export function ReadinessMatrix({ rows }: Readonly<{ rows: readonly MatrixRow[] }>) {
  const detectors = rows[0]?.cells.map((c) => c.detectorId) ?? [];
  if (rows.length === 0 || detectors.length === 0) return <EmptyNote>이 사이트에 판정할 설비가 없습니다</EmptyNote>;
  const hasRecommended = rows.some((row) => row.cells.some((cell) => cell.recommendedMissing.length > 0));

  return (
    <>
    <TableScroll label="탐지 준비도 매트릭스 (설비 × 탐지기)">
      <table className={`${TABLE_CLASS} text-xs`}>
        <thead>
          <tr>
            <th scope="col" className={`${TH_CLASS} sticky left-0 z-10 bg-surface`}>설비</th>
            {detectors.map((id) => (
              <th key={id} scope="col" className="w-24 min-w-24 border-b border-rule px-2 py-2 align-bottom text-xs font-medium text-muted">
                <span className="block leading-snug text-ink-2">{detectorLabel(id)}</span>
                <span className="block font-mono text-[10px] leading-snug">{id}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.assetId}>
              <th scope="row" className={`${TD_CLASS} sticky left-0 z-10 bg-surface font-medium`}>
                <span className="block font-mono text-ink">{row.code}</span>
                <span className="block font-normal text-muted">{row.className}</span>
              </th>
              {row.cells.map((cell) => {
                const view = cellDisplay(cell, detectorLabel(cell.detectorId));
                const Icon = ICONS[view.icon];
                return (
                  <td key={cell.detectorId} className={`${TD_CLASS} text-center`}>
                    <span title={view.tooltip} className={`inline-flex min-w-14 items-center justify-center gap-1 rounded border px-1.5 py-0.5 font-medium whitespace-nowrap ${TONES[view.tone]}`}>
                      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                      <span aria-hidden="true">
                        {view.short}
                        {view.recommendedMissing.length > 0 ? '*' : ''}
                      </span>
                      <span className="sr-only">{view.tooltip}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
    {hasRecommended ? (
      <p className="text-xs text-muted">* {RECOMMENDED_LABEL} — 판정은 하지만 원인 판별 체크·조건 bin이 줄어듭니다. 어떤 메트릭인지는 셀 툴팁에 있습니다.</p>
    ) : null}
    </>
  );
}

type RankingRow = AcquisitionView & { readonly metricName: string | null };

/** 메트릭 확보 순위: 이 메트릭 하나만 확보하면 풀리는 (설비 × 탐지기) 수가 많은 순 */
export function AcquisitionTable({ ranking }: Readonly<{ ranking: readonly RankingRow[] }>) {
  if (ranking.length === 0) return <EmptyNote>누락된 필수 메트릭이 없습니다</EmptyNote>;
  return (
    <TableScroll label="메트릭 확보 순위 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={`${TH_CLASS} text-right`}>순위</th>
            <th scope="col" className={TH_CLASS}>메트릭</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>확보 시 풀리는 조합</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>심각도 가중</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>관련 누락 조합</th>
            <th scope="col" className={TH_CLASS}>관련 탐지기</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((row, i) => (
            <tr key={row.metricKey}>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{i + 1}</td>
              <th scope="row" className={`${TD_CLASS} font-normal`}>
                <span className="block font-mono text-ink">{row.metricKey}</span>
                <span className="block text-xs text-muted">{row.metricName ?? '카탈로그에 없는 메트릭'}</span>
              </th>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.unlocks}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.severityWeight}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.blockedCells}</td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>{row.detectorIds.map(detectorLabel).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
