import { formatKstDate, formatNumber } from '@/lib/format';
import type { PackEnergyLedger } from '@/lib/report/pack-types-p3';
import { buildBarChart, type BarItem } from '@/lib/report/svg-chart';

const TH = 'border-b border-rule-strong bg-sunken px-2 py-1 text-left text-[11px] font-semibold text-ink-2';
const TD = 'border-b border-rule px-2 py-1 align-top text-[12px]';
const BOX = { width: 640, height: 170 };

/** 원장 기간 합 막대 (정적 SVG, 서버 렌더). 음수는 기준선 아래 */
function BarsSvg({ items, unit, label }: Readonly<{ items: readonly BarItem[]; unit: string; label: string }>) {
  const chart = buildBarChart(items, BOX);
  if (!chart) return null;
  const { plot } = chart;
  return (
    <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={label} className="h-auto w-full" style={{ fontFamily: 'inherit' }}>
      {chart.yTicks.map((tick) => (
        <g key={`y-${tick.at}`}>
          <line x1={plot.left} x2={plot.right} y1={tick.at} y2={tick.at} stroke="var(--rule)" strokeDasharray="2 3" />
          <text x={plot.left - 6} y={tick.at + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
            {tick.label}
          </text>
        </g>
      ))}
      <line x1={plot.left} x2={plot.right} y1={chart.baseline} y2={chart.baseline} stroke="var(--ink-2)" />
      {chart.bars.map((bar) => (
        <g key={bar.label}>
          <rect x={bar.x} y={bar.y} width={bar.width} height={Math.max(bar.height, 0.5)} fill={bar.negative ? 'var(--muted)' : 'var(--accent)'} opacity={0.85} />
          <text x={bar.x + bar.width / 2} y={bar.negative ? bar.y + bar.height + 10 : bar.y - 3} textAnchor="middle" fontSize={9.5} fill="var(--ink)">
            {formatNumber(bar.value, Math.abs(bar.value) >= 100 ? 0 : 1)}
          </text>
          <text x={bar.x + bar.width / 2} y={plot.bottom + 16} textAnchor="middle" fontSize={10} fill="var(--muted)">
            {bar.label}
          </text>
        </g>
      ))}
      <text x={plot.left} y={10} fontSize={10} fill="var(--muted)">
        [{unit}]
      </text>
    </svg>
  );
}

const pct = (value: number | null): string => (value === null ? '—' : `${formatNumber(value, 1)}%`);

/** 인쇄 리포트 '에너지·수소 원장' 절 부록: 기간 합 표 + 수소 원장·PV 미활용 막대 */
export function LedgerPrint({ ledger }: Readonly<{ ledger: PackEnergyLedger }>) {
  const h = ledger.hydrogen;
  const rows = [
    ['원장 기간', `${formatKstDate(ledger.firstDay)} ~ ${formatKstDate(ledger.lastDay)} (${ledger.days}일, ${ledger.allocVersion})`],
    ['공급 (태양광·ESS 방전·연료전지·계통 수전)', `${[ledger.energy.pvKwh, ledger.energy.essDischargeKwh, ledger.energy.fcKwh, ledger.energy.gridImportKwh].map((v) => formatNumber(v, 0)).join(' · ')} kWh`],
    ['수요 (보조부하·ESS 충전·전해조·압축기·계통 송전)', `${[ledger.energy.siteAuxKwh, ledger.energy.essChargeKwh, ledger.energy.electrolyzerKwh, ledger.energy.compressorKwh, ledger.energy.gridExportKwh].map((v) => formatNumber(v, 0)).join(' · ')} kWh`],
    ['전해조 비에너지 · 연료전지 원단위', `${formatNumber(ledger.kpis.elzSecKwhPerKg, 1)} kWh/kg · ${formatNumber(ledger.kpis.fcKgPerMwh, 1)} kg/MWh`],
    ['전해조 재생 · 계통전력 비율 · P2P 효율', `${pct(ledger.kpis.renewableSharePct)} · ${pct(ledger.kpis.gridSharePct)} · ${pct(ledger.kpis.p2pEfficiencyPct)}`],
    ['수소 원장 (생산 − 소비 − 저장 증감 − 배기 = 잔차)', h === null ? '값이 모두 있는 날 없음' : `${formatNumber(h.producedKg, 1)} − ${formatNumber(h.fcConsumedKg, 1)} − ${formatNumber(h.storedDeltaKg, 1)} − ${formatNumber(h.ventedEstKg, 2)} = ${formatNumber(h.residualKg, 2)} kg (잔차율 ${h.residualPct === null ? '—' : `${formatNumber(h.residualPct, 2)}%`}, ${h.daysUsed}일)`],
    ['계측 불일치율', ledger.unmeteredRatioPct === null ? '—' : `${formatNumber(ledger.unmeteredRatioPct, 2)}%`],
  ] as const;
  const hydrogenBars: BarItem[] = h === null ? [] : [
    { label: '생산', value: h.producedKg },
    { label: '연료전지 소비', value: h.fcConsumedKg },
    { label: '저장 증감', value: h.storedDeltaKg },
    { label: '배기 추정', value: h.ventedEstKg },
    { label: '잔차', value: h.residualKg },
  ];
  const pvBars: BarItem[] = ledger.pvLoss === null ? [] : ledger.pvLoss.items.map((item) => ({ label: item.label, value: item.kwh }));
  return (
    <div className="print-keep mt-2 flex flex-col gap-2">
      <table className="w-full border-collapse">
        <caption className="pb-1 text-left text-[11px] text-muted">[표] 에너지·수소 원장 기간 합 (om.site_energy_daily, 비례 할당 회계 흐름 · 청정수소 인증 공식 산정 아님)</caption>
        <thead>
          <tr>
            <th className={TH}>항목</th>
            <th className={TH}>값</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className={TD}>{label}</td>
              <td className={`${TD} font-mono`}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hydrogenBars.length > 0 && (
        <figure className="print-keep">
          <BarsSvg items={hydrogenBars} unit="kg" label="수소 원장 기간 합 막대: 생산·연료전지 소비·저장 증감·배기 추정·잔차" />
          <figcaption className="text-center text-[10px] text-muted">[그림] 수소 원장 기간 합 (kg, 음수는 기준선 아래 회색)</figcaption>
        </figure>
      )}
      {pvBars.length > 0 && (
        <figure className="print-keep">
          <BarsSvg items={pvBars} unit="kWh" label="PV 미활용 원인 기간 합 막대" />
          <figcaption className="text-center text-[10px] text-muted">[그림] PV 미활용 원인 분해 기간 합 (kWh, 기대 발전 {formatNumber(ledger.pvLoss?.expectedKwh ?? null, 0)} kWh)</figcaption>
        </figure>
      )}
    </div>
  );
}
