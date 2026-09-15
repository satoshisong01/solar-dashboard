import { CircleCheck, CircleX } from 'lucide-react';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { detectorLabel } from '@/lib/desk/labels';
import { formatMagnitude, type DetectorScoreView, type GateView } from '@/lib/desk/scorecard';
import { detectorStage } from '@/lib/desk/scorecard-p3';
import { formatNumber } from '@/lib/format';

const pct = (value: number | null): string => (value === null ? '—' : `${formatNumber(value * 100, 1)}%`);

/** 크기 오차는 % 단위 탐지기면 %p로 쓴다 */
const maeText = (d: DetectorScoreView): string => {
  if (d.magnitudeMae === null) return '—';
  const unit = d.unit === '%' ? '%p' : d.unit;
  return formatMagnitude(Number(d.magnitudeMae.toFixed(3)), unit) ?? '—';
};

export function GatesTable({ gates }: Readonly<{ gates: readonly GateView[] }>) {
  if (gates.length === 0) return <EmptyNote>게이트 결과가 없습니다</EmptyNote>;
  return (
    <TableScroll label="CI 게이트 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>게이트</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>값</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>기준</th>
            <th scope="col" className={TH_CLASS}>결과</th>
          </tr>
        </thead>
        <tbody>
          {gates.map((gate) => (
            <tr key={gate.id}>
              <td className={TD_CLASS}>{gate.description}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(gate.value, 4)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                {gate.comparator} {formatNumber(gate.threshold, 4)}
              </td>
              <td className={TD_CLASS}>
                {gate.pass ? (
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-ok">
                    <CircleCheck aria-hidden="true" className="size-4" />
                    통과
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-crit">
                    <CircleX aria-hidden="true" className="size-4" />
                    미달
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function DetectorScoresTable({ detectors }: Readonly<{ detectors: readonly DetectorScoreView[] }>) {
  return (
    <TableScroll label="탐지기별 성능 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>단계</th>
            <th scope="col" className={TH_CLASS}>탐지기</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>TP / FP / FN</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>재현율</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>정밀도</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>오탐 (건/자산·월)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>탐지 지연 중앙값</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>크기 MAE</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>최소 탐지 크기</th>
          </tr>
        </thead>
        <tbody>
          {detectors.map((d) => (
            <tr key={d.detectorId}>
              <td className={`${TD_CLASS} text-xs font-medium text-ink-2`}>{detectorStage(d.detectorId)}</td>
              <td className={TD_CLASS}>
                <span className="block font-medium text-ink">{detectorLabel(d.detectorId)}</span>
                <span className="block font-mono text-xs text-muted">{d.detector}</span>
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                {d.tp} / {d.fp} / {d.fn}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{pct(d.recall)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{pct(d.precision)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                {formatNumber(d.fpPerAssetMonth, 4)}
                {d.assetMonths !== null && <span className="block text-xs text-muted">{formatNumber(d.assetMonths, 1)} 자산·월</span>}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{d.medianDelayDays === null ? '—' : `${formatNumber(d.medianDelayDays, 1)}일`}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{maeText(d)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatMagnitude(d.minDetectableMagnitude, d.unit) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
