import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { formatSigned } from '@/lib/desk/effect';
import type { MassBalanceEvidence } from '@/lib/desk/p3-evidence-types';
import { chainSectionHref } from '@/lib/desk/p3-view';
import { formatKstDate, formatNumber } from '@/lib/format';
import { LedgerBarChart, ResidualCusumChart } from './mass-balance-charts';

const LINK_CLASS = 'inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline';

function Windows({ evidence }: Readonly<{ evidence: MassBalanceEvidence }>) {
  const items = [
    ['기준', `${evidence.reference.days}일${evidence.reference.from === null ? '' : ` (${formatKstDate(evidence.reference.from)}부터)`} · 잔차율 중앙값 ${formatSigned(evidence.reference.medianPct, 3)}%${evidence.reference.sigmaPct === null ? '' : ` · σ ${formatNumber(evidence.reference.sigmaPct, 3)}%p`}`],
    ['최근', `${evidence.recent.days}일${evidence.recent.from === null ? '' : ` (${formatKstDate(evidence.recent.from)}부터)`} · 잔차율 중앙값 ${formatSigned(evidence.recent.medianPct, 3)}% · 하루 ${formatNumber(evidence.recent.medianKg, 3)} kg`],
    ['CUSUM', `${evidence.cusum.direction === 'down' ? '하향' : '상향'} k ${formatNumber(evidence.cusum.k, 2)} · h ${formatNumber(evidence.cusum.h, 2)} · 변화 시작 ${evidence.cusum.changeStartDay ?? '—'} · 경보 ${evidence.cusum.alarmDay ?? '—'}`],
  ] as const;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** h2chain.mass_balance_gap 근거: 일 수소 원장 막대 · 잔차율 CUSUM · 사이트 체인 원장 섹션 링크 */
export function MassBalanceCanvas({ evidence, siteCode }: Readonly<{ evidence: MassBalanceEvidence; siteCode: string }>) {
  const chainLink = (
    <Link href={chainSectionHref(siteCode, evidence.days)} className={LINK_CLASS}>
      사이트 체인 원장에서 보기
      <ArrowRight aria-hidden="true" className="size-4" />
    </Link>
  );
  return (
    <>
      <Panel title="일 수소 원장" meta="잔차 = 생산 − 연료전지 소비 − 저장 증감 − 배기 추정 (kg, KST 하루 · 근거 스냅샷 ≤ 120일)" action={chainLink}>
        {evidence.days.length === 0 ? <EmptyNote>근거에 일 원장 행이 없습니다</EmptyNote> : <LedgerBarChart days={evidence.days} withTerms={evidence.hasBalanceTerms} />}
        {!evidence.hasBalanceTerms && evidence.days.length > 0 && <p className="text-xs text-ink-2">이 근거 스냅샷의 일 행에는 연료전지 소비·저장 증감·배기 추정 값이 없습니다(이전 버전 스냅샷이거나 계측 없음). 생산과 잔차만 그렸습니다. 분석을 다시 실행하면 함께 저장됩니다.</p>}
        <p className="text-xs text-muted">양수 잔차 = 계량되지 않은 손실 또는 생산 과다 계량입니다. 원장 할당은 회계상 가정이며 청정수소 인증 공식 산정이 아닙니다.</p>
      </Panel>
      <Panel title="잔차율 CUSUM" meta="기준 구간 중앙값·σ로 표준화한 일 잔차율의 표 CUSUM (같은 부호 방향)">
        <Windows evidence={evidence} />
        {evidence.days.length === 0 && evidence.cusum.points.length === 0 ? <EmptyNote>근거에 잔차율 점이 없습니다</EmptyNote> : <ResidualCusumChart evidence={evidence} />}
        {evidence.cusum.points.length === 0 && <p className="text-xs text-ink-2">이 근거 스냅샷에는 CUSUM 누적합 경로가 없습니다(이전 버전 스냅샷). 잔차율과 경보일만 표시합니다.</p>}
      </Panel>
    </>
  );
}
