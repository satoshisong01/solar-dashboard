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
    <section className={`flex min-w-0 flex-col gap-4 rounded-lg border border-rule bg-surface p-4 shadow-panel md:p-5 ${className}`}>
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

// 표 스크롤 상자는 넘침을 재야 해서 클라이언트 컴포넌트다. 서버 컴포넌트가 계속 이 모듈에서 가져다 쓰도록 여기서 다시 내보낸다.
export { TableScroll } from './table-scroll';

export const TABLE_CLASS = 'w-full min-w-max border-collapse text-left text-sm';
export const TH_CLASS = 'border-b border-rule-strong px-3 py-2 text-xs font-medium tracking-wide whitespace-nowrap text-muted first:pl-0 last:pr-0';
export const TD_CLASS = 'border-b border-rule px-3 py-2 align-top first:pl-0 last:pr-0';
export const NUM_CLASS = 'text-right font-mono tabular-nums';
