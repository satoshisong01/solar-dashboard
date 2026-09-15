import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { ThermalEvidence } from '@/lib/desk/p3-evidence-types';
import { ambientBinWidth, thermalBinSeries } from '@/lib/desk/p3-view';
import { formatNumber } from '@/lib/format';
import { DerateDaysChart, RepresentativeDayChart } from './thermal-charts';

function AmbientBinsTable({ evidence }: Readonly<{ evidence: ThermalEvidence }>) {
  const width = ambientBinWidth(evidence.ambientBins);
  return (
    <TableScroll label="외기 온도 구간별 일 저감 시간 비교표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>일 최고 외기</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>기준 일수</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>기준 일 저감 (h)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>최근 일수</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>최근 일 저감 (h)</th>
          </tr>
        </thead>
        <tbody>
          {evidence.ambientBins.map((bin) => (
            <tr key={bin.binC}>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                {formatNumber(bin.binC, 1)}~{formatNumber(bin.binC + width, 1)} °C
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.nRef}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(bin.refDerateH, 2)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{bin.nCur}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(bin.curDerateH, 2)}</td>
            </tr>
          ))}
          {evidence.binShift && (
            <tr className="font-medium">
              <th scope="row" className={`${TD_CLASS} text-left`}>최근 일수 가중 평균</th>
              <td className={`${TD_CLASS} ${NUM_CLASS}`} colSpan={2}>
                {formatNumber(evidence.binShift.ref, 2)}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`} colSpan={2}>
                {formatNumber(evidence.binShift.cur, 2)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** inv.thermal_derating 근거: 외기 bin별 일 저감 시간 추세·비교표 · 대표일 방열판 온도·출력·동종 중앙값 */
export function ThermalCanvas({ evidence }: Readonly<{ evidence: ThermalEvidence }>) {
  const series = thermalBinSeries(evidence);
  const totalHours = evidence.days.reduce((sum, d) => sum + (d.derateH ?? 0), 0);
  const totalLoss = evidence.days.reduce((sum, d) => sum + (d.lossKwh ?? 0), 0);
  const hotC = evidence.derateStartC === null || evidence.marginC === null ? null : evidence.derateStartC - evidence.marginC;
  return (
    <>
      <Panel title="외기 조건별 일 저감 시간" meta={`최근 ${evidence.days.length}일 합계 저감 ${formatNumber(totalHours, 1)} h · 손실 약 ${formatNumber(totalLoss, 0)} kWh (출력제한 시각 제외)`}>
        {series.length === 0 ? <EmptyNote>근거에 일별 저감 시간이 없습니다</EmptyNote> : <DerateDaysChart series={series} />}
        {evidence.ambientBins.length === 0 ? <p className="text-xs text-muted">같은 외기 bin의 기준 일이 없어 외기 조건 비교를 하지 못했습니다.</p> : <AmbientBinsTable evidence={evidence} />}
        <p className="text-xs text-muted">같은 외기 온도 구간에서 최근 저감 시간이 기준보다 길면 여름철 정상 저감이 아니라 냉각팬·필터·방열판 오염을 의심합니다.</p>
      </Panel>
      <Panel title="대표일 방열판 온도·출력" meta={evidence.representativeDay ? `${evidence.representativeDay.date} · 최근 기간 중 저감 시간이 가장 긴 날` : undefined}>
        {evidence.representativeDay === null || evidence.representativeDay.points.length === 0 ? <EmptyNote>근거에 대표일 곡선이 없습니다</EmptyNote> : <RepresentativeDayChart day={evidence.representativeDay} hotC={hotC} />}
        <p className="text-xs text-muted">
          방열판이 저감 시작 온도({formatNumber(evidence.derateStartC, 0)} °C) − 여유 {formatNumber(evidence.marginC, 0)} °C 이상이고 동종 중앙값보다 {formatNumber(evidence.gapPct, 0)}% 이상 낮은 버킷을 저감으로 셉니다.
        </p>
      </Panel>
    </>
  );
}
