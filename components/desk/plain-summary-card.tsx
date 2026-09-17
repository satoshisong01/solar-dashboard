import { Hourglass } from 'lucide-react';
import type { PlainSummary } from '@/lib/desk/plain';
import { AiSourceBadge, BADGE_CLASS } from '@/components/desk/ai-source-badge';
import { RegenerateExplanation } from '@/components/desk/explanation-controls';
import { TermLink } from '@/components/ui/term-link';
import { severityAction } from '@/lib/desk/plain/common';

type Row = Readonly<{ label: string; text: string | null }>;

const rowsOf = (summary: PlainSummary): Row[] =>
  summary.hold
    ? [
        { label: '왜 아직 이른가', text: summary.basis },
        { label: '어떻게 볼까', text: summary.outlook },
        { label: '지금 할 일', text: summary.nextStep },
      ]
    : [
        { label: '어떻게 확인했나', text: summary.basis },
        { label: '왜 문제인가', text: summary.outlook },
        { label: '지금 할 일', text: summary.nextStep },
      ];

type PlainSummaryCardProps = Readonly<{ summary: PlainSummary; severity: number; findingId: string; source: 'llm' | 'template'; model: string | null }>;

/** 발견사항 워크스페이스 맨 위 쉬운 요약 4줄. 수치는 아래 '자세히 보기'의 효과·근거와 같은 값이다 */
export function PlainSummaryCard({ summary, severity, findingId, source, model }: PlainSummaryCardProps) {
  const rows = rowsOf(summary).filter((row): row is Readonly<{ label: string; text: string }> => row.text !== null);
  return (
    <section aria-label="쉬운 요약" className="flex min-w-0 flex-col gap-3 rounded-lg border border-accent/40 bg-hydrogen-fill/40 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink">쉬운 요약</h2>
          {summary.hold ? (
            <span className={BADGE_CLASS}>
              <Hourglass aria-hidden="true" className="size-3" />
              판단 보류 <TermLink termId="hold" term="판정 보류" />
            </span>
          ) : (
            <span className={BADGE_CLASS}>{severityAction(severity)}</span>
          )}
          <AiSourceBadge source={source} model={model} />
        </div>
        <RegenerateExplanation findingId={findingId} />
      </div>
      <p className="text-lg leading-snug font-medium text-pretty text-ink">{summary.what}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted">{row.label}</dt>
            <dd className="text-pretty text-ink-2">{row.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
