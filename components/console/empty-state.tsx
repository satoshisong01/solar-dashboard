type Phase = Readonly<{ code: 'P1' | 'P2' | 'P3'; note?: string }>;

type EmptyStateProps = Readonly<{
  phases: readonly Phase[];
  /** 이 화면에 들어올 핵심 요소 2~4개 */
  items: readonly string[];
  /** 기본값: "이 화면은 P1에서 제공됩니다" */
  title?: string;
}>;

/** 아직 구현되지 않은 화면의 자리. 가짜 수치·차트는 넣지 않는다. */
export function EmptyState({ phases, items, title }: EmptyStateProps) {
  const codes = [...new Set(phases.map((phase) => phase.code))].join('·');
  const availability = `이 화면은 ${codes}에서 제공됩니다`;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-dashed border-rule-strong bg-surface p-5 md:p-6">
      <ul aria-label="제공 단계" className="flex flex-wrap gap-2">
        {phases.map((phase) => (
          <li
            key={`${phase.code}-${phase.note ?? ''}`}
            className="rounded-full border border-hydrogen-edge bg-hydrogen-fill px-2.5 py-0.5 font-mono text-xs text-hydrogen"
          >
            {phase.note ? `${phase.code} ${phase.note}` : phase.code}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink">{title ?? availability}</h2>
        {title && <p className="text-sm text-ink-2">{availability}.</p>}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">들어올 내용</p>
        <ul className="flex flex-col gap-2 text-sm text-ink-2">
          {items.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-hydrogen-edge" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
