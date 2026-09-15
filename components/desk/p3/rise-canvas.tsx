import { Panel } from '@/components/ui/panel';
import type { RiseEvidence } from '@/lib/desk/p3-evidence-types';
import { trendAxisText } from '@/lib/desk/trend';
import { MatchedBinsTable } from '../comparison-tables';
import { TrendPanel } from '../trend-panel';

/** el.sec_rise · comp.sec_rise · fc.blower_wear · ess.resistance_growth 근거: 용량 감소와 같은 같은 조건 비교표 + 추세 산점도(CUSUM 변화점) */
export function RiseCanvas({ evidence }: Readonly<{ evidence: RiseEvidence }>) {
  const pointLabel = evidence.trend === null ? undefined : `${trendAxisText(evidence.trend.xKind).pointLabel} (표본마다 자기 bin 기준 중앙값 대비 %)`;
  return (
    <>
      <Panel title="같은 조건 비교표" meta={`${evidence.subject} · bin별 기준(각 bin의 가장 이른 표본)·최근 표본 수·중앙값·비율 (최근 가중치 결합 + 부트스트랩 95% CI)`}>
        <div className="flex flex-col gap-2">
          <MatchedBinsTable bins={evidence.bins} conditionHeader={evidence.conditionHeader} unit={evidence.levelUnit} digits={evidence.levelDigits} />
          {evidence.notes.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
              {evidence.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <TrendPanel trend={evidence.trend} label={`${evidence.subject} 기준 대비`} pointLabel={pointLabel} />
    </>
  );
}
