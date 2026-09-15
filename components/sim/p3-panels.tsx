import { CircleCheck, CircleX } from 'lucide-react';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { formatMagnitude, type DetectorScoreView, type GateView } from '@/lib/desk/scorecard';
import { pathLabel, seasonOf, type ScorecardP3View } from '@/lib/desk/scorecard-p3';
import { formatKstDate, formatNumber } from '@/lib/format';
import { DetectionCurveChart } from './detection-curve-chart';
import { ResidualDistributionChart } from './residual-distribution-chart';

const pct = (value: number | null, digits = 0): string => (value === null ? '—' : `${formatNumber(value * 100, digits)}%`);

function GateResult({ gate }: Readonly<{ gate: GateView | undefined }>) {
  if (!gate) return <span className="text-xs text-muted">게이트 결과 없음</span>;
  return gate.pass ? (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-ok">
      <CircleCheck aria-hidden="true" className="size-4" />
      게이트 통과 ({gate.comparator} {formatNumber(gate.threshold, 3)})
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-crit">
      <CircleX aria-hidden="true" className="size-4" />
      게이트 미달 ({gate.comparator} {formatNumber(gate.threshold, 3)})
    </span>
  );
}

/** 저장용기 미세누설 최소 탐지 크기 곡선: 주입 누설률별 재현율·지연·크기 오차 */
export function TankLeakCurvePanel({ detector, gate }: Readonly<{ detector: DetectorScoreView | undefined; gate: GateView | undefined }>) {
  return (
    <Panel title="저장용기 미세누설 최소 탐지 크기 곡선" meta="tank.static_leak · 정지 보유 구간 온도 보정 질량 기울기 · 누설률별 주입 3건">
      {!detector || detector.curve.length === 0 ? (
        <EmptyNote>스코어카드에 누설 주입 결과가 없습니다</EmptyNote>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <DetectionCurveChart detector={detector.detector} curve={detector.curve} unit={detector.unit ?? ''} minDetectable={detector.minDetectableMagnitude} />
            <p className="text-sm text-ink">
              재현율 0.9 이상 최소 누설률 <span className="font-mono">{formatMagnitude(detector.minDetectableMagnitude, detector.unit) ?? '—'}</span> · <GateResult gate={gate} />
            </p>
            <p className="text-xs text-muted">안전 카테고리(심각도 4)는 누설률 95% CI 하한이 0.5 kg/일을 넘을 때만입니다. 오탐 {formatNumber(detector.fpPerAssetMonth, 3)}건/자산·월.</p>
          </div>
          <TableScroll label="누설률별 탐지 표">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={`${TH_CLASS} text-right`}>주입 누설률 ({detector.unit})</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>탐지 / 주입</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>지연 중앙값</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>크기 오차</th>
                </tr>
              </thead>
              <tbody>
                {detector.curve.map((point) => (
                  <tr key={point.magnitude}>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(point.magnitude, 3)}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                      {point.detected} / {point.injections}
                    </td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{point.medianDelayDays === null ? '—' : `${formatNumber(point.medianDelayDays, 1)}일`}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{point.magnitudeMae === null ? '—' : formatNumber(point.magnitudeMae, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </Panel>
  );
}

type P3Props = Readonly<{ p3: ScorecardP3View; gates: readonly GateView[] }>;

const gateOf = (gates: readonly GateView[], id: string): GateView | undefined => gates.find((g) => g.id === id);

/** P3 대조군·판별 참고 지표: PV 대조군 · 물질수지 잔차 분포 · 비에너지 경로 판별 · 누설 ↔ 물질수지 · 냉각팬 계절별 지연 */
export function P3ReferencePanels({ p3, gates }: P3Props) {
  const median = gateOf(gates, 'h2chain.healthy_residual_median');
  const p95 = gateOf(gates, 'h2chain.healthy_residual_p95');
  const path = p3.elSecPathSupport;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="PV 대조군 결과" meta="출력제어·흐린 주·비 오는 주 구간의 PV 탐지기 finding (정답 = 0)">
          {p3.pvControlFindings === null ? (
            <EmptyNote>스코어카드에 PV 대조군 결과가 없습니다</EmptyNote>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-3xl font-semibold text-ink tabular-nums">{formatNumber(p3.pvControlFindings, 0)}건</p>
              <GateResult gate={gateOf(gates, 'pv.control_findings')} />
              <p className="text-xs text-muted">대상 탐지기: 인버터 동종 비교 · 태양광 오염 손실 · 인버터 열 출력저감</p>
            </div>
          )}
        </Panel>
        <Panel title="물질수지 잔차 분포" meta={p3.healthyMassBalance ? `대조군 SIM-C 일별 |잔차율| · ${formatNumber(p3.healthyMassBalance.days, 0)}일 (원장 완결성 0.9 이상)` : undefined}>
          {p3.healthyMassBalance === null ? (
            <EmptyNote>스코어카드에 물질수지 잔차 분포가 없습니다</EmptyNote>
          ) : (
            <div className="flex flex-col gap-2">
              <ResidualDistributionChart distribution={p3.healthyMassBalance} gates={[...(median?.threshold != null ? [{ label: `중앙값 기준 ${median.threshold}%`, valuePct: median.threshold }] : []), ...(p95?.threshold != null ? [{ label: `95퍼센타일 기준 ${p95.threshold}%`, valuePct: p95.threshold }] : [])]} />
              <p className="flex flex-wrap gap-x-4 text-sm">
                <span>중앙값 <GateResult gate={median} /></span>
                <span>95퍼센타일 <GateResult gate={p95} /></span>
              </p>
            </div>
          )}
        </Panel>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="전해조 비에너지 원인 판별 정확도" meta="주입 경로별로 해당 판별 체크가 '지지'인 비율 (참고 지표, 게이트 아님)">
          {path === null ? (
            <EmptyNote>스코어카드에 판별 결과가 없습니다</EmptyNote>
          ) : (
            <TableScroll label="비에너지 경로별 판별 체크 지지 비율 표">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>주입 경로</th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>탐지 건수</th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>체크 지지 비율</th>
                  </tr>
                </thead>
                <tbody>
                  {path.byMode.map(([mode, detected, ratio]) => (
                    <tr key={mode}>
                      <td className={TD_CLASS}>{pathLabel(mode)}</td>
                      <td className={`${TD_CLASS} ${NUM_CLASS}`}>{detected}</td>
                      <td className={`${TD_CLASS} ${NUM_CLASS} ${ratio !== null && path.target !== null && ratio < path.target ? 'text-warn' : ''}`}>{pct(ratio, 1)}</td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className={TD_CLASS}>전체 (목표 {pct(path.target)})</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{path.detected}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS}`}>{pct(path.overall, 1)}</td>
                  </tr>
                </tbody>
              </table>
            </TableScroll>
          )}
        </Panel>
        <Panel title="누설 교차 확인 · 냉각팬 계절별 지연" meta="참고 지표">
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-ink">
              누설 0.2 kg/일 이상 주입 중 물질수지 finding이 함께 난 비율:{' '}
              {p3.tankLeakMassBalance === null ? '—' : (
                <span className="font-mono">
                  {p3.tankLeakMassBalance.withFinding} / {p3.tankLeakMassBalance.injections} ({pct(p3.tankLeakMassBalance.share)})
                </span>
              )}
            </p>
            {p3.fanFailureDelays.length === 0 ? (
              <EmptyNote>냉각팬 고장 지연 결과가 없습니다</EmptyNote>
            ) : (
              <TableScroll label="냉각팬 고장 시작 계절별 탐지 지연 표">
                <table className={TABLE_CLASS}>
                  <thead>
                    <tr>
                      <th scope="col" className={TH_CLASS}>고장 시작</th>
                      <th scope="col" className={`${TH_CLASS} text-right`}>시드별 탐지 지연 (일)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p3.fanFailureDelays.map((row) => (
                      <tr key={row.startDay}>
                        <td className={TD_CLASS}>
                          {row.startDay}일째{row.startMs === null ? '' : ` · ${formatKstDate(row.startMs)} (${seasonOf(row.startMs)})`}
                        </td>
                        <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.delaysDays.join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
            <p className="text-xs text-muted">냉각팬 고장은 더운 날에만 저감이 보여 겨울에 시작하면 여름까지 탐지가 늦습니다.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
