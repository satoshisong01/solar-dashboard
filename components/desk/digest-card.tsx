import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { AiSourceBadge, BADGE_CLASS } from '@/components/desk/ai-source-badge';
import { RegenerateDigest } from '@/components/desk/digest-controls';
import type { DigestGroup, DigestStats, DigestSummary } from '@/lib/desk/digest';
import { formatKstDateTime } from '@/lib/format';

const CARD_CLASS = 'flex min-w-0 flex-col gap-3 rounded-lg border border-accent/40 bg-hydrogen-fill/40 p-4 md:p-5';

/** 이 요약이 어느 범위를 센 것인지 (사이트 필터가 걸려 있으면 그 사이트만) */
const scopeText = (stats: DigestStats): string => (stats.site === null ? '열린 발견사항 전체' : `${stats.siteLabel ?? stats.site} 범위`);

function DetailList({ group }: Readonly<{ group: DigestGroup }>) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink">
        {group.label} <span className="font-normal text-muted">{group.count}건</span>
      </h3>
      {group.urgencies.map((urgency) => (
        <div key={urgency.key} className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium text-muted">
            {urgency.label} {urgency.items.length}건
          </p>
          <ul className="flex min-w-0 flex-col gap-1">
            {urgency.items.map((item) => (
              <li key={item.id} className="min-w-0">
                <Link href={`/desk/${item.id}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1 hover:bg-sunken">
                  <span className="shrink-0 font-mono text-xs text-muted">{item.siteCode}</span>
                  <span className="min-w-0 text-sm text-pretty text-ink-2">{item.headline}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

type DigestCardProps = Readonly<{
  stats: DigestStats;
  /** 열린 발견사항이 없으면 null (문장을 만들지 않는다) */
  summary: DigestSummary | null;
  source: 'llm' | 'template';
  model: string | null;
  /** 마지막으로 끝난 분석 실행 시각 */
  lastRunMs: number | null;
}>;

/**
 * 분석 데스크 맨 위 종합 요약. 문장은 AI가 다시 쓸 수 있지만 수치·분류는 언제나 분석 엔진이 센 값이다.
 * '상세 보기'를 펼치면 계통별·급함별로 묶인 목록이 나오고 각 줄에서 발견사항으로 간다.
 */
export function DigestCard({ stats, summary, source, model, lastRunMs }: DigestCardProps) {
  if (summary === null) {
    return (
      <section aria-label="종합 요약" className={CARD_CLASS}>
        <h2 className="text-base font-semibold text-ink">종합 요약</h2>
        <p className="text-lg leading-snug font-medium text-pretty text-ink">지금은 확인할 이슈가 없습니다.</p>
        <p className="text-sm text-muted">{lastRunMs === null ? '아직 분석을 실행한 적이 없습니다. 아래에서 사이트와 기간을 골라 실행하세요.' : `마지막 분석 실행 ${formatKstDateTime(lastRunMs)} KST 기준입니다.`}</p>
      </section>
    );
  }

  const lines = [summary.breakdown, summary.urgency, summary.nextStep].filter((line): line is string => line !== null);
  return (
    <section aria-label="종합 요약" className={CARD_CLASS}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink">종합 요약</h2>
          <span className={BADGE_CLASS}>{scopeText(stats)}</span>
          <AiSourceBadge source={source} model={model} />
        </div>
        <RegenerateDigest site={stats.site} />
      </div>
      <p className="text-lg leading-snug font-medium text-pretty text-ink">{summary.headline}</p>
      {lines.map((line) => (
        <p key={line} className="text-sm leading-relaxed text-pretty text-ink-2">
          {line}
        </p>
      ))}
      <details className="group flex min-w-0 flex-col">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 self-start rounded-md border border-rule-strong bg-sunken px-3 py-2 text-sm font-medium text-ink-2 hover:bg-rule [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
          상세 보기
          <span className="font-normal text-muted">— 계통별·급함별 {stats.total}건</span>
        </summary>
        <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
          {stats.groups.map((group) => (
            <DetailList key={group.key} group={group} />
          ))}
        </div>
      </details>
    </section>
  );
}
