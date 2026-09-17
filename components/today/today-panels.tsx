import { ArrowRight, CircleCheck, Radio, Tags } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { EnergyKpiValue } from '@/lib/data/energy';
import { GATEWAY_SILENCE_MS, type DataGaps, type MarketSummaryRow, type SiteEnergySummary } from '@/lib/data/today';
import { formatAgo, formatDuration, formatNumber } from '@/lib/format';

const LINK_CLASS = 'inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline';

export function DataGapsPanel({ gaps, nowMs }: Readonly<{ gaps: DataGaps; nowMs: number }>) {
  const silence = formatDuration(GATEWAY_SILENCE_MS);
  return (
    <Panel title="데이터 공백" meta={`게이트웨이 무수신 기준 ${silence}`}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 font-medium text-ink">
            <Radio aria-hidden="true" className="size-4 text-muted" />
            {silence} 넘게 무수신인 게이트웨이 {gaps.staleGateways.length} / {gaps.activeGateways}
          </p>
          {gaps.activeGateways === 0 ? (
            <p className="text-muted">등록된 활성 게이트웨이가 없습니다.</p>
          ) : gaps.staleGateways.length === 0 ? (
            <p className="flex items-center gap-1.5 text-ok">
              <CircleCheck aria-hidden="true" className="size-4" />
              모든 게이트웨이가 최근 {silence} 안에 수신했습니다.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {gaps.staleGateways.map((gateway) => (
                <li key={gateway.code} className="flex flex-wrap gap-x-3">
                  <span className="font-medium">{gateway.siteCode}</span>
                  <span className="font-mono text-ink-2">{gateway.code}</span>
                  <span className="text-warn">
                    {gateway.lastSeenMs === null ? '수신 기록 없음' : `마지막 수신 ${formatAgo(gateway.lastSeenMs, nowMs)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
          <p className="flex items-center gap-2 font-medium text-ink">
            <Tags aria-hidden="true" className="size-4 text-muted" />
            매핑되지 않은 수신 태그 {gaps.unmappedTags}개
          </p>
          <Link href="/data" className={LINK_CLASS}>
            데이터 화면
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      </div>
    </Panel>
  );
}

function KpiCell({ kpi, digits = 0 }: Readonly<{ kpi: EnergyKpiValue; digits?: number }>) {
  if (!kpi.present) {
    return (
      <td className={`${TD_CLASS} ${NUM_CLASS} text-muted`}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">해당 없음</span>
      </td>
    );
  }
  if (kpi.value === null) return <td className={`${TD_CLASS} text-right text-xs whitespace-nowrap text-muted`}>데이터 없음</td>;
  return (
    <td className={`${TD_CLASS} ${NUM_CLASS} text-ink`}>
      {formatNumber(kpi.value, digits)}
      {kpi.suspect && <span className="block text-xs font-sans text-warn">데이터 의심</span>}
      {kpi.standby > 0 && <span className="block text-xs font-sans text-muted">대기 {formatNumber(kpi.standby, digits)}</span>}
    </td>
  );
}

const ENERGY_COLUMNS = [
  { key: 'pvKwh', label: 'PV 발전 kWh', digits: 0 },
  { key: 'essChargeKwh', label: 'ESS 충전 kWh', digits: 0 },
  { key: 'essDischargeKwh', label: 'ESS 방전 kWh', digits: 0 },
  { key: 'h2Kg', label: 'H₂ 생산 kg', digits: 1 },
  { key: 'fcKwh', label: '연료전지 kWh', digits: 0 },
] as const;

export function EnergySummaryPanel({ rows }: Readonly<{ rows: readonly SiteEnergySummary[] }>) {
  return (
    <Panel title="사이트별 발전·수소 요약" meta="어제·오늘(KST 0시부터 지금까지) · 1시간 롤업 기준">
      {rows.length === 0 ? (
        <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
      ) : (
        <TableScroll label="사이트별 발전·수소 요약 표" stickyFirst>
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>사이트</th>
                <th scope="col" className={TH_CLASS}>날짜</th>
                {ENERGY_COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className={`${TH_CLASS} text-right`}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((site) =>
                (['yesterday', 'today'] as const).map((day) => (
                  <tr key={`${site.siteId}-${day}`}>
                    {day === 'yesterday' && (
                      <th scope="rowgroup" rowSpan={2} className={`${TD_CLASS} font-medium`}>
                        <Link href={`/sites/${encodeURIComponent(site.code)}`} className="text-ink hover:underline">{site.code}</Link>
                        <span className="block text-xs font-normal text-muted">{site.name}</span>
                      </th>
                    )}
                    {/* 둘째 줄에서는 이 칸이 첫 칸이 되므로 first:pl-0이 없는 클래스를 쓴다 */}
                    <td className="border-b border-rule px-3 py-2 align-top whitespace-nowrap text-ink-2">{day === 'yesterday' ? '어제' : '오늘'}</td>
                    {ENERGY_COLUMNS.map((column) => (
                      <KpiCell key={column.key} kpi={site[day][column.key]} digits={column.digits} />
                    ))}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </TableScroll>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-muted">
          PV·ESS·H₂는 누적 카운터 증가량, 연료전지는 시간 평균 출력 × 1시간의 합입니다. ‘—’는 해당 설비가 없다는 뜻입니다.
          ‘데이터 의심’은 설비 정격으로 설명되지 않는 카운터 점프가 있어 그 구간을 더하지 않았다는 뜻이고, ‘대기’는 정지 중 소비라 발전량에 넣지 않은 값입니다.
        </p>
      )}
    </Panel>
  );
}

export function RevenuePanel({ rows }: Readonly<{ rows: readonly MarketSummaryRow[] }>) {
  return (
    <Panel title="수익 요약" meta="SMP·REC 수기 입력·CSV">
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2">
          <EmptyNote>설정에서 SMP·REC를 입력하세요</EmptyNote>
          <Link href="/settings/market" className={LINK_CLASS}>
            시장가격 입력으로 이동
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col gap-1 rounded-md border border-rule p-3">
              <dt className="text-xs text-muted">{row.label}</dt>
              <dd className="flex flex-col gap-0.5">
                <span className="font-mono text-lg text-ink tabular-nums">
                  {formatNumber(row.latestValue, 2)} <span className="text-xs text-muted">{row.unit}</span>
                </span>
                <span className="text-xs text-muted">최근 입력 {row.latestDay}</span>
                <span className="text-xs text-ink-2">
                  이번 달 평균 {row.monthAvg === null ? '입력 없음' : `${formatNumber(row.monthAvg, 2)} ${row.unit} (${row.monthDays}일)`}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}
