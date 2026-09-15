import { Info, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { ChainSankeyChart, type SankeyToneMap } from '@/components/charts/sankey-chart';
import { FindingSeverityChip, FindingStatusBadge } from '@/components/desk/finding-badges';
import { EmptyNote, NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { summarizeChainPeriod } from '@/lib/analytics/ledger/site-day';
import { isFindingStatus } from '@/lib/analysis/transition-rules';
import { ledgerDqSummary } from '@/lib/chain/dq';
import { ALLOCATION_NOTE, PV_LOSS_REASON_LABELS } from '@/lib/chain/labels';
import type { ChainPeriod } from '@/lib/chain/period';
import { energySankey, hydrogenSankey } from '@/lib/chain/sankey';
import { pvLossView, residualPoints, shareView, type PvLossView } from '@/lib/chain/series';
import type { ChainView } from '@/lib/data/chain';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { PvLossChart, ResidualChart, ShareTrendChart } from './chain-charts';
import { ChainPeriodForm } from './chain-period-form';

const ENERGY_TONES: SankeyToneMap = {
  'supply:pv': 'solar',
  'supply:ess_discharge': 'solar',
  'supply:fc': 'hydrogen',
  'supply:grid_import': 'neutral',
  'demand:site_aux': 'neutral',
  'demand:ess_charge': 'solar',
  'demand:electrolyzer': 'hydrogen',
  'demand:compressor': 'hydrogen',
  'demand:grid_export': 'neutral',
};

const HYDROGEN_TONES: SankeyToneMap = { 'h2:produced': 'hydrogen', 'h2:storageOut': 'hydrogen', 'h2:fcConsumed': 'hydrogen', 'h2:storageIn': 'hydrogen', 'h2:vented': 'neutral' };

const pct = (value: number | null, digits = 1): string | null => (value === null ? null : `${formatNumber(value * 100, digits)}`);

type KpiCard = Readonly<{ key: string; label: string; value: string | null; unit: string; note: string }>;

function KpiCards({ cards }: Readonly<{ cards: readonly KpiCard[] }>) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <div key={card.key} className="flex flex-col gap-1 rounded-lg border border-rule bg-surface p-3">
          <dt className="text-xs text-muted">{card.label}</dt>
          <dd className="flex flex-col gap-0.5">
            {card.value === null ? (
              <span className="text-sm text-muted">데이터 없음</span>
            ) : (
              <span className="font-mono text-xl text-ink tabular-nums">
                {card.value} <span className="text-xs text-muted">{card.unit}</span>
              </span>
            )}
            <span className="text-xs text-muted">{card.note}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PvLossTable({ view }: Readonly<{ view: PvLossView }>) {
  const reasons = Object.entries(view.missingReasons);
  return (
    <>
      <TableScroll label="PV 미활용 원인 기간 합 표">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>원인</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>기간 합 [kWh]</th>
              <th scope="col" className={`${TH_CLASS} text-right`}>기대 발전 대비</th>
            </tr>
          </thead>
          <tbody>
            {view.totals.map((row) => (
              <tr key={row.bucket}>
                <th scope="row" className={`${TD_CLASS} font-normal text-ink`}>{row.label}</th>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.kwh, 1)}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.pctOfExpected === null ? '—' : `${formatNumber(row.pctOfExpected, 2)}%`}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className={`${TD_CLASS} font-medium text-ink`}>기대 발전 / 실제 발전</th>
              <td className={`${TD_CLASS} ${NUM_CLASS}`} colSpan={2}>
                {formatNumber(view.expectedKwh, 0)} / {formatNumber(view.actualKwh, 0)}
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
      <p className="text-xs text-muted">
        분해가 있는 날 {view.daysWithBreakdown}일{reasons.length > 0 && ` · 분해 없음: ${reasons.map(([code, n]) => `${PV_LOSS_REASON_LABELS[code] ?? code} ${n}일`).join(', ')}`}. 한 시간이 여러 조건에 걸리면 정지 → ESS 만충 → 출력제어 → 클리핑 → 열 저감 → 오염 추정 순서로 먼저 가져갑니다. 설명 안 됨이 음수면 기준 PR이 낮게 잡힌 신호입니다.
      </p>
    </>
  );
}

type Props = Readonly<{ siteCode: string; period: ChainPeriod; view: ChainView; maxDay: string }>;

/** 사이트 상세 · 에너지·수소 체인 원장 (설계 §3·§5.2 site_energy_daily, P3) */
export function ChainSection({ siteCode, period, view, maxDay }: Props) {
  const { days, threshold } = view;
  const energy = energySankey(days);
  const hydrogen = hydrogenSankey(days);
  const summary = summarizeChainPeriod(days);
  const shares = shareView(days);
  const residuals = residualPoints(days, threshold.minCompleteness);
  const pvLoss = pvLossView(days);
  const dq = ledgerDqSummary(days);
  const lastDayText = view.lastDay === null ? '저장된 원장 없음' : `원장 마지막 날짜 ${view.lastDay}`;

  const cards: readonly KpiCard[] = [
    { key: 'sec', label: '전해조 비에너지 (SEC)', value: summary.elzSecKwhPerKg === null ? null : formatNumber(summary.elzSecKwhPerKg, 1), unit: 'kWh/kg', note: '전해조 설비 AC kWh ÷ 생산 kg (기간 합)' },
    { key: 'fc', label: '연료전지 수소 원단위', value: summary.fcKgPerMwh === null ? null : formatNumber(summary.fcKgPerMwh, 1), unit: 'kg/MWh', note: '수소 소비 kg ÷ AC MWh (기간 합)' },
    { key: 'p2p', label: 'P2P 효율', value: pct(summary.p2pEfficiency), unit: '%', note: '연료전지 AC ÷ 소비 수소를 만든 전력 (재고 변화 보정)' },
    { key: 'renewable', label: '전해조 재생 비율', value: pct(shares.renewableShare), unit: '%', note: '태양광·ESS 방전 할당 kWh ÷ 전해조 kWh' },
    { key: 'grid', label: '전해조 계통전력 비율', value: pct(shares.gridShare), unit: '%', note: '계통 수전 할당 kWh ÷ 전해조 kWh' },
    { key: 'residual', label: '물질수지 잔차율', value: summary.residualPct === null ? null : formatNumber(summary.residualPct, 2), unit: '%', note: summary.daysUsed === 0 ? '수소 원장 값이 모두 있는 날 없음' : `잔차 ${formatNumber(summary.residualKg, 1)} kg · ${summary.daysUsed}일 합` },
  ];

  return (
    <section id="chain" aria-labelledby="chain-title" className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="chain-title" className="text-lg font-semibold text-ink">
            에너지·수소 체인 원장
          </h2>
          <p className="text-xs text-muted">
            {period.label} ({period.fromDay} ~ {period.toDay}) · 저장된 날 {days.length}일 · {lastDayText}
          </p>
        </div>
        <ChainPeriodForm siteCode={siteCode} period={period} maxDay={maxDay} />
        <p className="text-xs text-muted">분석 실행이 1시간 롤업으로 계산해 저장한 일 단위 원장입니다(분석을 실행하지 않은 날은 없습니다). 청정수소 인증 공식 산정이 아닙니다.</p>
      </div>

      {days.length === 0 ? (
        <EmptyNote>이 기간에 저장된 체인 원장이 없습니다. {lastDayText}. 분석 데스크에서 이 사이트를 분석하면 채워집니다.</EmptyNote>
      ) : (
        <>
          {dq.warnings.length > 0 && (
            <div role="note" aria-label="원장 데이터 품질 경고" className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-fill px-3 py-2 text-sm text-warn">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <ul className="flex flex-col gap-0.5">
                {dq.warnings.map((w) => (
                  <li key={w.code}>
                    {w.message}
                    {w.sampleDays.length > 0 && <span className="ml-1 font-mono text-xs">({w.sampleDays.join(', ')}{w.sampleDays.length < 5 ? '' : ' …'})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Panel title="체인 KPI" meta={`기간 합 기준 · 계측 불일치율 ${dq.periodUnmeteredRatio === null ? '—' : `${formatNumber(dq.periodUnmeteredRatio * 100, 2)}%`}`}>
            <KpiCards cards={cards} />
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel
              title="에너지 흐름 [kWh]"
              meta={
                <span className="inline-flex items-center gap-1" title={ALLOCATION_NOTE}>
                  <Info aria-hidden="true" className="size-3.5" />
                  비례 할당 가정 (pool_hourly@1) · {energy.days}일 합 {formatNumber(energy.total, 0)} kWh
                </span>
              }
            >
              {energy.links.length === 0 ? (
                <EmptyNote>전력 흐름을 계산할 계측이 없습니다</EmptyNote>
              ) : (
                <ChainSankeyChart data={energy} unit="kWh" tones={ENERGY_TONES} linkNote={ALLOCATION_NOTE} ariaLabel="에너지 흐름 Sankey: 공급원(태양광·ESS 방전·연료전지·계통 수전)에서 수요처로 비례 할당한 kWh" />
              )}
              <p className="text-xs text-muted">{ALLOCATION_NOTE} 옅은 회색 흐름은 계측 불일치(미계측 공급·수요)입니다.</p>
            </Panel>

            <Panel title="수소 흐름 [kg]" meta={`수소 원장 값이 모두 있는 ${hydrogen.days}일 합 · 에너지와 단위가 달라 따로 그립니다`}>
              {hydrogen.links.length === 0 ? (
                <EmptyNote>수소 원장 값이 있는 날이 없습니다 (전해조 생산·연료전지 소비·저장용기 계측 필요)</EmptyNote>
              ) : (
                <ChainSankeyChart data={hydrogen} unit="kg" tones={HYDROGEN_TONES} ariaLabel="수소 흐름 Sankey: 전해조 생산에서 연료전지 소비·저장 증감·배기 추정·잔차로 가는 kg" />
              )}
              <p className="text-xs text-muted">생산 = 연료전지 소비 + 저장 증감 + 배기 추정 + 잔차. 저장 인출·음의 잔차는 왼쪽(공급) 노드로 옮겨 그립니다. 옅은 회색은 설명 안 된 잔차입니다.</p>
            </Panel>
          </div>

          <Panel
            title="수소 물질수지 잔차"
            meta={`기준 ±${formatNumber(threshold.residualPct, 2)}% (${threshold.applied.length === 0 ? '탐지기 코드 기본값' : `설정 ${threshold.applied.join(', ')}`}) · 완결성 ${formatNumber(threshold.minCompleteness * 100, 0)}% 미만인 날은 회색`}
          >
            {threshold.invalidReason && <p className="text-xs text-crit">활성 탐지기 설정이 검증에 실패해 코드 기본값으로 그렸습니다: {threshold.invalidReason}</p>}
            {residuals.length === 0 ? <EmptyNote>잔차를 계산한 날이 없습니다</EmptyNote> : <ResidualChart points={residuals} thresholdPct={threshold.residualPct} />}
            <p className="text-xs text-muted">밴드는 h2chain.mass_balance_gap 잔차율 기준입니다. 탐지기는 하루 값이 아니라 최근 기간 중앙값과 CUSUM으로 판정하므로 하루가 밴드를 넘었다고 발견사항이 되지는 않습니다.</p>
            {view.openFindings.length > 0 ? (
              <ul className="flex flex-col gap-2" aria-label="열린 물질수지 발견사항">
                {view.openFindings.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <FindingSeverityChip severity={f.severity} />
                    {isFindingStatus(f.status) && <FindingStatusBadge status={f.status} />}
                    <Link href={`/desk/${f.id}`} className="font-medium text-accent hover:underline">
                      {f.title}
                    </Link>
                    <span className="text-xs text-muted">최근 탐지 {formatKstDateTime(f.lastDetectedMs)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-2">열린 물질수지 발견사항이 없습니다.</p>
            )}
          </Panel>

          <Panel title="전해조 입력 전력 비율 추세" meta={`전해조 ${formatNumber(shares.electrolyzerKwh, 0)} kWh · 기간 재생 ${pct(shares.renewableShare) ?? '—'}% · 계통 ${pct(shares.gridShare) ?? '—'}%`}>
            {shares.points.length === 0 ? <EmptyNote>전해조 전력이 계측된 날이 없습니다</EmptyNote> : <ShareTrendChart points={shares.points} />}
            <p className="text-xs text-muted">ESS 방전은 태양광으로 충전했다고 가정합니다. 한 시간 안에서 수전과 송전이 번갈아 일어나면 순값만 남습니다.</p>
          </Panel>

          <Panel title="PV 미활용 원인 분해 [kWh]" meta={`기대 발전(일사 × kWp × 기준 PR × 온도 보정) − 실제 발전 · 분해 있는 날 ${pvLoss.daysWithBreakdown}일`}>
            {pvLoss.daysWithBreakdown === 0 ? <EmptyNote>PV 미활용 분해가 있는 날이 없습니다</EmptyNote> : <PvLossChart view={pvLoss} />}
            {pvLoss.daysWithBreakdown > 0 && <PvLossTable view={pvLoss} />}
          </Panel>
        </>
      )}
    </section>
  );
}
