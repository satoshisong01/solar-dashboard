import { Panel } from '@/components/ui/panel';
import { TermLink } from '@/components/ui/term-link';
import type { FindingDetail } from '@/lib/data/finding-workspace';
import { formatEffectLevels, formatEffectWithCi } from '@/lib/desk/effect';
import type { EvidenceView, WindowView } from '@/lib/desk/evidence-types';
import { evidenceConditionText } from '@/lib/desk/evidence-summary';
import { formatKstDate, formatKstDateTime } from '@/lib/format';

const windowText = (label: string, w: WindowView): string | null => (w.from === null || w.to === null ? null : `${label} ${formatKstDate(w.from)} ~ ${formatKstDate(w.to)} (${w.n}회)`);

function comparisonWindows(evidence: EvidenceView, finding: FindingDetail): string {
  if (evidence.kind === 'capacity' || evidence.kind === 'rise') {
    return [windowText('기준', evidence.reference), windowText('최근', evidence.recent)].filter((part): part is string => part !== null).join(' · ');
  }
  return `탐지 창 ${formatKstDate(finding.windowStartMs)} ~ ${formatKstDate(finding.windowEndMs)}`;
}

const LEVEL_LABELS: Readonly<Record<string, string>> = {
  capacity: '유효용량 기준 → 최근',
  stack: '셀 전압 추세 처음 → 마지막',
  cell_imbalance: '셀 전압 편차 기준 → 최근',
  pv_peer: 'kWh/kWp 동종 중앙값 → 이 인버터',
  dq: '수신 완결성 기대 → 실제',
  tank_leak: '기준 구간 겉보기 손실 → 결합 누설률',
  mass_balance: '잔차율 기준 → 최근',
  soiling: '성능지수 구간 시작 → 마지막 맑은 날',
  thermal: '저감 손실률 기준 → 최근',
};

/** 수준 표기 자릿수: 작은 값이 0으로 뭉개지는 단위는 늘린다 */
const LEVEL_DIGITS: Readonly<Record<string, number>> = { 'kg/일': 3, PI: 3, 'kWh/kg': 3 };

const levelLabel = (evidence: EvidenceView): string => (evidence.kind === 'rise' ? `${evidence.subject} 기준 → 최근` : (LEVEL_LABELS[evidence.kind] ?? '기준 → 최근'));

type EffectCardProps = Readonly<{ finding: FindingDetail; chargeTimeText: string | null }>;

/** 효과 카드: 기준 대비 효과 크기 + 95% CI + 같은 조건 문장 */
export function EffectCard({ finding, chargeTimeText }: EffectCardProps) {
  const { effect, evidence } = finding;
  const effectText = formatEffectWithCi(effect, 2);
  const ci = effectText.ci;
  const levels = formatEffectLevels(effect, LEVEL_DIGITS[effect.levelUnit ?? ''] ?? 2);
  const condition = evidenceConditionText(evidence);
  const trendText = evidence.kind === 'stack' || evidence.kind === 'cell_imbalance' || evidence.kind === 'capacity' || evidence.kind === 'rise' ? (evidence.trend?.slopeText ?? null) : null;

  return (
    <Panel title="효과" meta={finding.evidenceAtMs === null ? undefined : `근거 계산 ${formatKstDateTime(finding.evidenceAtMs)} KST`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="font-mono text-3xl font-semibold text-ink tabular-nums">{effectText.value}</p>
          {ci && (
            <p className="font-mono text-sm text-ink-2 tabular-nums">
              {ci} <TermLink termId="ci" term="95% 신뢰구간" />
            </p>
          )}
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {levels && (
            <div>
              <dt className="text-xs text-muted">{levelLabel(evidence)}</dt>
              <dd className="font-mono text-ink tabular-nums">{levels}</dd>
            </div>
          )}
          {chargeTimeText && (
            <div>
              <dt className="text-xs text-muted">기준 전류 환산 충전시간 (0 → 100%)</dt>
              <dd className="font-mono text-ink tabular-nums">{chargeTimeText}</dd>
            </div>
          )}
          {trendText && (
            <div>
              <dt className="text-xs text-muted">추세 기울기</dt>
              <dd className="font-mono text-ink tabular-nums">{trendText}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted">비교 기간</dt>
            <dd className="text-ink">{comparisonWindows(evidence, finding)}</dd>
          </div>
        </dl>
        {condition && (
          <p className="rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink">
            <span className="block text-xs text-muted">
              같은 조건 <TermLink termId="matched" term="같은 조건 비교" />
            </span>
            {condition}
          </p>
        )}
        {finding.configVersions.length > 0 && <p className="text-xs text-muted">적용한 탐지기 설정: {finding.configVersions.join(', ')}</p>}
      </div>
    </Panel>
  );
}
