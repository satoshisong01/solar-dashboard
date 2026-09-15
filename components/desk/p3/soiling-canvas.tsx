import Link from 'next/link';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { SoilingEvidence } from '@/lib/desk/p3-evidence-types';
import { cleaningEconomics, soilingExclusionLabel } from '@/lib/desk/p3-view';
import { formatNumber } from '@/lib/format';
import { SoilingChart } from './soiling-chart';

function SegmentsTable({ evidence }: Readonly<{ evidence: SoilingEvidence }>) {
  return (
    <TableScroll label="오염 구간 기울기 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>구간 (복원 사이)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>맑은 날</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>오염 속도 (%/일)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>95% CI</th>
          </tr>
        </thead>
        <tbody>
          {evidence.segments.map((segment, i) => (
            <tr key={`${segment.from}-${segment.to}`} className={i === evidence.segments.length - 1 ? 'font-medium' : 'text-ink-2'}>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                {segment.from} ~ {segment.to}
                {i === evidence.segments.length - 1 && ' (현재)'}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{segment.clearDays}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(segment.ratePctPerDay, 3)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap`}>
                {formatNumber(segment.ciLow, 3)} ~ {formatNumber(segment.ciHigh, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function EconomicsTable({ evidence }: Readonly<{ evidence: SoilingEvidence }>) {
  const economics = cleaningEconomics(evidence);
  const rows = [
    ['현재 구간 누적 손실', `${formatNumber(evidence.economics.cumulativeLossKwh, 0)} kWh`],
    ['최근 7일 하루 손실', `${formatNumber(evidence.economics.dailyLossKwh, 0)} kWh`],
    ['SMP (분석 시점 최근값)', evidence.smpKrwPerKwh === null ? '가격 데이터 없음' : `${formatNumber(evidence.smpKrwPerKwh, 1)} 원/kWh`],
    ['누적 손실액', economics.lossValueKrw === null ? '—' : `${formatNumber(economics.lossValueKrw, 0)} 원`],
    ['세척 1회 비용 (탐지기 설정)', evidence.cleaningCostKrw === null ? '—' : `${formatNumber(evidence.cleaningCostKrw, 0)} 원`],
    ['손실액 ÷ 세척비', economics.shareOfCleaningPct === null ? '—' : `${formatNumber(economics.shareOfCleaningPct, 0)}%`],
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <TableScroll label="세척 경제성 표">
        <table className={TABLE_CLASS}>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row" className={`${TD_CLASS} font-normal text-ink-2`}>{label}</th>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <p className="text-sm text-ink">
        {economics.verdict === 'no_price' ? (
          <>
            가격 데이터가 없어 세척 경제성을 판단할 수 없습니다.{' '}
            <Link href="/settings/market" className="font-medium text-accent hover:underline">
              SMP 입력
            </Link>
            후 분석을 다시 실행하세요.
          </>
        ) : economics.verdict === 'clean' ? (
          '누적 손실액이 세척비를 넘었습니다. 세척을 검토하세요.'
        ) : (
          '누적 손실액이 아직 세척비보다 작습니다. 손실 추세를 보며 세척 시점을 정하세요.'
        )}
      </p>
    </div>
  );
}

/** pv.soiling_rate 근거: 맑은 날 성능지수·복원 이벤트·구간 기울기 · 구간 표 · 세척 경제성 */
export function SoilingCanvas({ evidence }: Readonly<{ evidence: SoilingEvidence }>) {
  return (
    <>
      <Panel title="성능지수 추세" meta={`맑은 날 온도 보정 PI (γ ${formatNumber(evidence.gammaPerC, 4)}/°C) · 세척·강우 복원으로 나눈 구간별 Theil–Sen`}>
        {evidence.piPoints.length === 0 ? <EmptyNote>근거에 성능지수 점이 없습니다</EmptyNote> : <SoilingChart evidence={evidence} />}
        {evidence.segments.length > 0 && <SegmentsTable evidence={evidence} />}
        {evidence.segments.some((s) => s.line === null) && evidence.segments.length > 0 && <p className="text-xs text-ink-2">이 근거 스냅샷에는 구간별 기울기선 좌표가 없어 현재 구간 선만 그렸습니다(이전 버전 스냅샷).</p>}
        {evidence.exclusions.length > 0 && <p className="text-xs text-muted">성능지수에서 뺀 인버터·날: {evidence.exclusions.map(([code, n]) => `${soilingExclusionLabel(code)} ${n}`).join(' · ')}</p>}
      </Panel>
      <Panel title="세척 경제성" meta="누적 손실 kWh × SMP vs 세척 1회 비용 (추정)">
        <EconomicsTable evidence={evidence} />
      </Panel>
    </>
  );
}
