import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status';
import type { KpiValue, SiteTodayKpis } from '@/lib/data/energy';
import { FLEET_THRESHOLDS, type StatusLevel } from '@/lib/data/fleet-status';
import type { GatewayRow } from '@/lib/data/sites';
import { formatAgo, formatKstDateTime, formatNumber } from '@/lib/format';

interface KpiCardDef {
  readonly key: string;
  readonly label: string;
  readonly kpi: KpiValue;
  readonly format: (value: number) => string;
  readonly unit: string;
  readonly note: string;
}

function kpiCards(kpis: SiteTodayKpis): readonly KpiCardDef[] {
  const { energy } = kpis;
  return [
    { key: 'pv', label: '오늘 PV 발전', kpi: energy.pvKwh, format: (v) => formatNumber(v, 0), unit: 'kWh', note: '인버터 누적 전력량 증가' },
    { key: 'soc', label: 'ESS SOC 평균', kpi: kpis.essSocAvg, format: (v) => formatNumber(v, 1), unit: '%', note: '랙 SOC 시간 평균의 평균' },
    {
      key: 'elz',
      label: '전해조 가동률',
      kpi: kpis.elzRunningRatio,
      format: (v) => formatNumber(v * 100, 1),
      unit: '%',
      note: '수소 유량 > 0인 샘플 비율',
    },
    { key: 'h2', label: '오늘 H₂ 생산', kpi: energy.h2Kg, format: (v) => formatNumber(v, 1), unit: 'kg', note: '전해조 누적 생산량 증가' },
    { key: 'fc', label: '오늘 연료전지 발전', kpi: energy.fcKwh, format: (v) => formatNumber(v, 0), unit: 'kWh', note: '시간 평균 출력 × 1시간' },
  ];
}

/** 오늘(KST 0시~지금) KPI. 해당 설비가 없는 KPI는 카드를 만들지 않는다 */
export function SiteKpiCards({ kpis }: Readonly<{ kpis: SiteTodayKpis }>) {
  const cards = kpiCards(kpis).filter((card) => card.kpi.present);
  if (cards.length === 0) return <EmptyNote>KPI를 계산할 설비 포인트가 없습니다</EmptyNote>;

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <div key={card.key} className="flex flex-col gap-1 rounded-lg border border-rule bg-surface p-3">
          <dt className="text-xs text-muted">{card.label}</dt>
          <dd className="flex flex-col gap-0.5">
            {card.kpi.value === null ? (
              <span className="text-sm text-muted">데이터 없음</span>
            ) : (
              <span className="font-mono text-xl text-ink tabular-nums">
                {card.format(card.kpi.value)} <span className="text-xs text-muted">{card.unit}</span>
              </span>
            )}
            <span className="text-xs text-muted">{card.note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function gatewayLevel(gateway: GatewayRow, nowMs: number): StatusLevel {
  if (gateway.status !== 'active') return 'na';
  if (gateway.lastSeenMs === null) return 'unknown';
  const age = nowMs - gateway.lastSeenMs;
  if (age > FLEET_THRESHOLDS.staleCritMs) return 'crit';
  if (age > FLEET_THRESHOLDS.staleWarnMs) return 'warn';
  return 'ok';
}

export function GatewayTable({ gateways, nowMs }: Readonly<{ gateways: readonly GatewayRow[]; nowMs: number }>) {
  if (gateways.length === 0) return <EmptyNote>등록된 게이트웨이가 없습니다</EmptyNote>;

  return (
    <TableScroll label="게이트웨이 상태 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>게이트웨이</th>
            <th scope="col" className={TH_CLASS}>수신 상태</th>
            <th scope="col" className={TH_CLASS}>마지막 수신</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>시계 오차</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>마지막 seq</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>활성 키</th>
          </tr>
        </thead>
        <tbody>
          {gateways.map((gateway) => (
            <tr key={gateway.id}>
              <th scope="row" className={`${TD_CLASS} font-mono font-medium text-ink`}>
                {gateway.code}
                {gateway.status !== 'active' && <span className="ml-2 font-sans text-xs text-muted">비활성</span>}
              </th>
              <td className={TD_CLASS}><StatusBadge level={gatewayLevel(gateway, nowMs)} /></td>
              <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                {gateway.lastSeenMs === null ? (
                  '수신 기록 없음'
                ) : (
                  <>
                    {formatAgo(gateway.lastSeenMs, nowMs)}
                    <span className="block font-mono text-xs text-muted">{formatKstDateTime(gateway.lastSeenMs)}</span>
                  </>
                )}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{gateway.clockOffsetMs === null ? '—' : `${formatNumber(gateway.clockOffsetMs, 0)} ms`}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{gateway.lastSeq ?? '—'}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{gateway.activeKeys}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
