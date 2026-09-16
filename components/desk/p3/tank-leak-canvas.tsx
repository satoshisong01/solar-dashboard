import { NUM_CLASS, Panel, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll, EmptyNote } from '@/components/ui/panel';
import { formatSigned } from '@/lib/desk/effect';
import type { TankLeakEvidence } from '@/lib/desk/p3-evidence-types';
import { SAFETY_FINDING_NOTICE } from '@/lib/desk/safety';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { HoldCurveChart, LeakRateChart } from './tank-leak-charts';

const EOS_LABELS: Readonly<Record<string, string>> = { lemmon2008: 'NIST Lemmon 2008 상태식', abel_noble: 'Abel–Noble 근사식' };

function Summary({ evidence }: Readonly<{ evidence: TankLeakEvidence }>) {
  const items = [
    ['결합 누설률', `${formatNumber(evidence.leakKgPerDay, 3)} kg/일 (95% CI ${formatNumber(evidence.ciLow, 3)} ~ ${formatNumber(evidence.ciHigh, 3)})`],
    ['저장량 대비', evidence.pctPerDay === null ? '—' : `${formatNumber(evidence.pctPerDay, 2)}%/일`],
    ['센서 잡음 σ · 표준오차', `${formatNumber(evidence.noiseSigma, 3)} · ${evidence.seKgPerDay === null ? '—' : `${formatNumber(evidence.seKgPerDay, 3)} kg/일`} (SE = √(π/2)·σ·√(1/n_eff최근 + 1/n기준))`],
    ['유의 기준', `${formatNumber(evidence.thresholdKgPerDay, 3)} kg/일 (${formatNumber(evidence.zSigma, 1)}σ × SE)`],
    ['기준 겉보기 손실 편향 (뺌)', evidence.biasKgPerDay === null ? '—' : `${formatSigned(evidence.biasKgPerDay, 4)} kg/일`],
    ['안전 카테고리 기준', evidence.safetyKgPerDay === null ? '—' : `CI 하한 > ${formatNumber(evidence.safetyKgPerDay, 2)} kg/일 → ${evidence.safetyCategory ? '해당 (severity 4)' : '미해당'}`],
    ['상태식 · 내용적', `${EOS_LABELS[evidence.eosModel ?? ''] ?? evidence.eosModel ?? '—'} · ${formatNumber(evidence.volumeM3, 3)} m³`],
  ] as const;
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

function HoldsTable({ evidence }: Readonly<{ evidence: TankLeakEvidence }>) {
  return (
    <TableScroll label="정지 보유 구간 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            {['구간', '시작 (KST)', '길이 (h)', '손실률 (kg/일)', '95% CI', '평균 압력 (bar)', '평균 온도 (°C)', '온도 변화 (°C/일)'].map((head, i) => (
              <th key={head} scope="col" className={`${TH_CLASS} ${i >= 2 ? 'text-right' : ''}`}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...evidence.holds].reverse().map((hold) => (
            <tr key={`${hold.role}-${hold.start}`} className={hold.role === 'recent' ? 'font-medium' : 'text-ink-2'}>
              <td className={TD_CLASS}>{hold.role === 'recent' ? '최근' : '기준'}</td>
              <td className={`${TD_CLASS} whitespace-nowrap font-mono text-xs`}>{formatKstDateTime(hold.start)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(hold.hours, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(hold.lossKgPerDay, 4)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap`}>
                {formatNumber(hold.ciLow, 3)} ~ {formatNumber(hold.ciHigh, 3)}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(hold.pMeanBar, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(hold.tMeanC, 1)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(hold.tRateCPerDay, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** tank.static_leak 근거: 판정 요약 · 정지 보유 구간 표 · 대표 구간 P·T·보정 질량 · 구간 손실률 추세 */
export function TankLeakCanvas({ evidence }: Readonly<{ evidence: TankLeakEvidence }>) {
  return (
    <>
      <Panel title="정지 보유 구간" meta="유입·유출이 없는 구간마다 온도 보정 질량 기울기 → 최근 구간 가중 중앙값 결합 (최근 위, 기준 아래)">
        <Summary evidence={evidence} />
        {evidence.holds.length === 0 ? <EmptyNote>근거에 정지 보유 구간 표가 없습니다</EmptyNote> : <HoldsTable evidence={evidence} />}
        {!evidence.safetyCategory && <p className="text-xs text-ink-2">미세 누설 의심 단계입니다. 가스 검지기 기록 확인과 휴대용 검지기·발포액 누설 점검을 권고합니다. {SAFETY_FINDING_NOTICE}</p>}
      </Panel>
      <Panel title="대표 정지 구간 곡선" meta={evidence.representative ? `누설률이 결합값에 가장 가까운 최근 구간 · ${formatKstDateTime(evidence.representative.start)} ~ ${formatKstDateTime(evidence.representative.end)}` : undefined}>
        {evidence.representative === null || evidence.representative.points.length === 0 ? <EmptyNote>근거에 대표 구간 곡선이 없습니다</EmptyNote> : <HoldCurveChart points={evidence.representative.points} />}
        <p className="text-xs text-muted">압력은 밤사이 온도가 내려가면 함께 내려갑니다. 판정은 압력이 아니라 상태식으로 온도를 보정한 질량의 기울기로 합니다.</p>
      </Panel>
      <Panel title="누설률 추세" meta="정지 보유 구간별 손실률 (구간 안 Theil–Sen)">
        {evidence.holds.length === 0 ? (
          <EmptyNote>근거에 구간 손실률이 없습니다</EmptyNote>
        ) : (
          <LeakRateChart holds={evidence.holds} lines={{ leakKgPerDay: evidence.leakKgPerDay, thresholdKgPerDay: evidence.thresholdKgPerDay, safetyKgPerDay: evidence.safetyKgPerDay }} />
        )}
      </Panel>
    </>
  );
}
