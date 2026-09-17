import { Sparkles } from 'lucide-react';

/** 요약 카드 제목 줄의 작은 배지 한 벌 (발견사항 쉬운 요약·데스크 종합 요약이 함께 쓴다) */
export const BADGE_CLASS = 'inline-flex items-center gap-1 rounded border border-rule-strong bg-sunken px-1.5 py-px text-xs font-medium text-ink-2';

/** 문장을 누가 썼는지. 수치·판정은 어느 쪽이든 분석 엔진 값이다 */
export function AiSourceBadge({ source, model }: Readonly<{ source: 'llm' | 'template'; model: string | null }>) {
  if (source !== 'llm') return <span className={BADGE_CLASS}>규칙 기반 요약</span>;
  return (
    <span className={BADGE_CLASS} title={model ?? undefined}>
      <Sparkles aria-hidden="true" className="size-3" />
      AI가 작성 · 수치는 분석 엔진 값
    </span>
  );
}
