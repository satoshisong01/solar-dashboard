import type { ReactNode } from 'react';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { formatSigned } from '@/lib/desk/effect';
import type { GapyeongEvidence, HxPointView, O2DayView, PrvHoldView } from '@/lib/desk/p3-evidence-types';
import { limitMarginText } from '@/lib/desk/plain/outlook';
import { SAFETY_FINDING_NOTICE } from '@/lib/desk/safety';
import { formatNumber } from '@/lib/format';
import { HxApproachChart, O2PurityChart, PrvCreepChart } from './gapyeong-charts';

type Item = readonly [label: string, value: string];

function SummaryList({ items }: Readonly<{ items: readonly Item[] }>) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="font-mono text-ink tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Rows({ heads, children }: Readonly<{ heads: readonly string[]; children: ReactNode }>) {
  return (
    <table className={TABLE_CLASS}>
      <thead>
        <tr>
          {heads.map((head, i) => (
            <th key={head} scope="col" className={`${TH_CLASS} ${i === 0 ? '' : 'text-right'}`}>
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const num = (value: number | null, digits: number): string => formatNumber(value, digits);

function PrvHoldsTable({ holds }: Readonly<{ holds: readonly PrvHoldView[] }>) {
  return (
    <TableScroll label="무유동 구간 표">
      <Rows heads={['날짜 (KST)', '길이 (h)', '시작 압력 (bar)', '끝 압력 (bar)', '크리프율 (mbar/h)', '안정화 뒤 남은 비율']}>
        {[...holds].reverse().map((hold) => (
          <tr key={`${hold.date}-${hold.start ?? 0}`}>
            <td className={`${TD_CLASS} whitespace-nowrap font-mono text-xs`}>{hold.date}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(hold.hours, 0)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(hold.startBar, 3)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(hold.endBar, 3)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(hold.creepMbarPerH, 1)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(hold.settleRatio, 2)}</td>
          </tr>
        ))}
      </Rows>
    </TableScroll>
  );
}

function PrvCanvas({ evidence }: Readonly<{ evidence: GapyeongEvidence }>) {
  const detail = evidence.detail;
  if (detail.kind !== 'prv') return null;
  const ci = detail.ciLowMbarPerH === null || detail.ciHighMbarPerH === null ? '' : ` (95% CI ${num(detail.ciLowMbarPerH, 1)} ~ ${num(detail.ciHighMbarPerH, 1)})`;
  const items: Item[] = [
    ['최근 구간 크리프율 중앙값', `${num(evidence.recentLevel, 1)} mbar/h${ci}`],
    ['기준 구간 크리프율 중앙값', `${num(evidence.referenceLevel, 1)} mbar/h (${detail.holds.length === 0 ? '—' : `${evidence.referenceCount}구간`})`],
    ['경고 · 주의 기준', `${num(detail.warnMbarPerH, 0)} · ${num(detail.alertMbarPerH, 0)} mbar/h`],
    ['기준을 넘은 구간', `${detail.alarmHolds} / ${evidence.recentCount}구간 (알림 최소 ${detail.minAlarmHolds}구간)`],
    ['환산 누설량', evidence.extra.leakNlPerMin === null ? '—' : `${num(evidence.extra.leakNlPerMin, 2)} NL/min (하류 체적 ${num(evidence.extra.downstreamVolumeM3, 2)} m³ 기준)`],
    ['설정압', detail.setpointBar === null ? '—' : `${num(detail.setpointBar, 2)} bar`],
  ];
  return (
    <>
      <Panel title="무유동 구간" meta="연료전지가 멈춰 유량이 없는 구간마다 하류 압력의 Theil–Sen 기울기 → 최근 구간 중앙값 (최근 위, 오래된 아래)">
        <SummaryList items={items} />
        {detail.holds.length === 0 ? <EmptyNote>근거에 무유동 구간 표가 없습니다</EmptyNote> : <PrvHoldsTable holds={detail.holds} />}
        <p className="text-xs text-ink-2">유량이 없는데도 하류가 오르면 시트로 가스가 새는 것입니다. 안정화 뒤 남은 비율이 1에 가까울수록 구간 내내 이어진 상승입니다. {SAFETY_FINDING_NOTICE}</p>
      </Panel>
      <Panel title="크리프율 추세" meta="구간별 상승률과 경고·주의 기준선">
        {detail.holds.length === 0 ? (
          <EmptyNote>근거에 구간 상승률이 없습니다</EmptyNote>
        ) : (
          <PrvCreepChart holds={detail.holds} lines={{ recentMbarPerH: evidence.recentLevel, referenceMbarPerH: evidence.referenceLevel, warnMbarPerH: detail.warnMbarPerH, alertMbarPerH: detail.alertMbarPerH }} />
        )}
      </Panel>
    </>
  );
}

function HxPointsTable({ points }: Readonly<{ points: readonly HxPointView[] }>) {
  return (
    <TableScroll label="최근 정상상태 시간 표">
      <Rows heads={['날짜 (KST)', '1차측 입구 (°C)', '접근온도 (K)', 'UA (kW/K)']}>
        {[...points].reverse().map((point, i) => (
          <tr key={`${point.date}-${i}`}>
            <td className={`${TD_CLASS} whitespace-nowrap font-mono text-xs`}>{point.date}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(point.hotInC, 2)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(point.approachK, 2)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(point.uaKwK, 4)}</td>
          </tr>
        ))}
      </Rows>
    </TableScroll>
  );
}

function HxCanvas({ evidence }: Readonly<{ evidence: GapyeongEvidence }>) {
  const detail = evidence.detail;
  if (detail.kind !== 'hx') return null;
  const ci = detail.ciLowK === null || detail.ciHighK === null ? '' : ` (95% CI ${num(detail.ciLowK, 2)} ~ ${num(detail.ciHighK, 2)})`;
  const binText = detail.bins.length === 0 ? '—' : `${detail.bins.length}개 (폭 ${num(detail.binWidthC, 1)} °C · ${detail.bins.map((bin) => num(bin, 0)).join(', ')} °C)`;
  const items: Item[] = [
    ['비교한 1차측 입구 온도 구간', binText],
    ['접근온도 기준 → 최근', `${num(evidence.referenceLevel, 2)} → ${num(evidence.recentLevel, 2)} K (${formatSigned(detail.riseK, 2)} K)${ci}`],
    ['설계 접근온도', detail.designApproachK === null ? '—' : `${num(detail.designApproachK, 2)} K`],
    ['UA 기준 → 최근', detail.uaRecentKwK === null ? '2차측 입구 온도·유량이 없어 계산하지 못했습니다' : `${num(detail.uaReferenceKwK, 4)} → ${num(detail.uaRecentKwK, 4)} kW/K (${formatSigned(evidence.extra.uaDropPct === null ? null : -evidence.extra.uaDropPct, 1)}%)`],
    ['설계 UA', detail.designUaKwK === null ? '—' : `${num(detail.designUaKwK, 4)} kW/K`],
    ['뺀 시간', detail.minDeltaThetaK === null ? '—' : `1차측 입구와 2차측 입구 온도차 ${num(detail.minDeltaThetaK, 0)} K 미만 (계측 오차가 커진다)`],
  ];
  return (
    <>
      <Panel title="같은 조건 비교" meta="1차측 입구 온도 bin마다 (최근 중앙값 − 기준 중앙값)을 구해 최근 표본 수로 가중 평균한다. 95% CI도 같은 통계량으로 낸다">
        <SummaryList items={items} />
        <p className="text-xs text-ink-2">접근온도 = 1차측 입구 − 2차측 출구입니다. 벌어질수록 열이 2차측(수전해 급수)으로 덜 넘어갑니다. 양측 열수지 절대값 검사는 쓰지 않습니다 — 설계상 2차측 회수 열량이 1차측의 약 7%라 상시 오경보가 납니다.</p>
      </Panel>
      <Panel title="접근온도 · UA 추세" meta="최근 정상상태 시간별 값 (오른쪽 축이 UA)">
        {detail.points.length === 0 ? (
          <EmptyNote>근거에 시간별 점이 없습니다</EmptyNote>
        ) : (
          <>
            <HxApproachChart points={detail.points} lines={{ referenceK: evidence.referenceLevel, recentK: evidence.recentLevel, designApproachK: detail.designApproachK }} />
            <HxPointsTable points={detail.points} />
          </>
        )}
      </Panel>
    </>
  );
}

function O2DaysTable({ days }: Readonly<{ days: readonly O2DayView[] }>) {
  return (
    <TableScroll label="일별 산소 중 수소 표">
      <Rows heads={['날짜 (KST)', '중앙값 (vol%)', '최대 (vol%)', '운전 시간 (h)', '부하율']}>
        {[...days].reverse().map((day) => (
          <tr key={day.date}>
            <td className={`${TD_CLASS} whitespace-nowrap font-mono text-xs`}>{day.date}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(day.medianPct, 2)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(day.maxPct, 2)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(day.hours, 0)}</td>
            <td className={`${TD_CLASS} ${NUM_CLASS}`}>{num(day.load, 2)}</td>
          </tr>
        ))}
      </Rows>
    </TableScroll>
  );
}

function O2Canvas({ evidence }: Readonly<{ evidence: GapyeongEvidence }>) {
  const detail = evidence.detail;
  if (detail.kind !== 'o2') return null;
  const ci = detail.ciLowPct === null || detail.ciHighPct === null ? '' : ` (95% CI ${num(detail.ciLowPct, 2)} ~ ${num(detail.ciHighPct, 2)})`;
  // 여유는 (한계 − 최근값)이라 이미 넘은 건은 음수로 온다. 크기만 쓰면 방향이 뒤집히므로 부호로 말을 고른다 (plain/outlook.ts와 같은 규칙)
  const margin = evidence.margin === null || evidence.limit === null ? '—' : limitMarginText(evidence.margin, evidence.limit);
  const items: Item[] = [
    ['최근 일 중앙값', `${num(evidence.recentLevel, 2)} vol% (${evidence.recentCount}일)${ci}`],
    ['기준 일 중앙값', `${num(evidence.referenceLevel, 2)} vol% (${evidence.referenceCount}일)`],
    ['최근 95퍼센타일', `${num(detail.recentP95Pct, 2)} vol%`],
    ['압축금지 한계', evidence.limit === null ? '—' : `${num(evidence.limit, 1)} vol%`],
    ['폭발하한 (LEL)', detail.lelPct === null ? '—' : `${num(detail.lelPct, 1)} vol%`],
    ['한계선까지 여유', margin],
  ];
  return (
    <>
      <Panel title="법정 한계선과 여유" meta="전해조 운전 시간의 일 HTO 중앙값 · 압축금지선은 폭발하한의 절반">
        <SummaryList items={items} />
        <p className="text-xs text-ink-2">산소에 섞인 수소가 이 선을 넘으면 법으로 산소를 압축할 수 없습니다. {SAFETY_FINDING_NOTICE}</p>
      </Panel>
      <Panel title="HTO 추세" meta="일 중앙값·일 최대와 한계선">
        {detail.days.length === 0 ? (
          <EmptyNote>근거에 일별 값이 없습니다</EmptyNote>
        ) : (
          <>
            <O2PurityChart days={detail.days} lines={{ limitPct: evidence.limit, lelPct: detail.lelPct, referencePct: evidence.referenceLevel, recentPct: evidence.recentLevel, recentP95Pct: detail.recentP95Pct }} />
            <O2DaysTable days={detail.days} />
          </>
        )}
      </Panel>
    </>
  );
}

/** 가평 구성 탐지기 3종 근거: 감압밸브 무유동 구간 · 열교환기 같은 조건 비교 · 산소 중 수소 법정 한계선 */
export function GapyeongCanvas({ evidence }: Readonly<{ evidence: GapyeongEvidence }>) {
  switch (evidence.detectorId) {
    case 'prv.seat_leak':
      return <PrvCanvas evidence={evidence} />;
    case 'hx.fouling':
      return <HxCanvas evidence={evidence} />;
    case 'o2.purity_drift':
      return <O2Canvas evidence={evidence} />;
  }
}
