import type { ReactNode } from 'react';

type PanelProps = Readonly<{
  title: string;
  /** 제목 옆 보조 설명 (기준 시각·기간 등) */
  meta?: ReactNode;
  /** 제목 줄 오른쪽 (링크·버튼) */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}>;

/** 화면 안의 한 영역. 제목은 h2 */
export function Panel({ title, meta, action, children, className = '' }: PanelProps) {
  return (
    <section className={`flex min-w-0 flex-col gap-4 rounded-lg border border-rule bg-surface p-4 md:p-5 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {meta && <p className="text-xs text-muted">{meta}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 데이터가 없을 때의 안내. 가짜 수치 대신 이것을 보여 준다 */
export function EmptyNote({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="rounded-md border border-dashed border-rule-strong px-4 py-5 text-center text-sm text-muted">{children}</p>;
}

/** 표가 좁은 화면에서 페이지 대신 자기 안에서 가로 스크롤되게 한다. relative: 표 안 sr-only(absolute) 요소가 페이지 폭을 넓히지 않게 */
export function TableScroll({ children, label }: Readonly<{ children: ReactNode; label: string }>) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="relative -mx-4 overflow-x-auto px-4 md:-mx-5 md:px-5">
      {children}
    </div>
  );
}

export const TABLE_CLASS = 'w-full min-w-max border-collapse text-left text-sm';
export const TH_CLASS = 'border-b border-rule px-3 py-2 text-xs font-medium whitespace-nowrap text-muted first:pl-0 last:pr-0';
export const TD_CLASS = 'border-b border-rule px-3 py-2 align-top first:pl-0 last:pr-0';
export const NUM_CLASS = 'text-right font-mono tabular-nums';
