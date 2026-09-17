import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 기술 근거를 접어 둔다 (기본 접힘). 브라우저가 찾기(Ctrl+F)로 접힌 내용을 펼치고,
 * 인쇄에는 globals.css의 @media print details::details-content 규칙으로 함께 나온다.
 */
export function TechnicalDetails({ label, defaultOpen = false, children }: Readonly<{ label: string; defaultOpen?: boolean; children: ReactNode }>) {
  return (
    <details open={defaultOpen} className="group flex min-w-0 flex-col">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-rule-strong bg-sunken px-3 py-2 text-sm font-medium text-ink-2 hover:bg-rule [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
        자세히 보기
        <span className="font-normal text-muted">— {label}</span>
      </summary>
      <div className="mt-6 flex min-w-0 flex-col gap-6">{children}</div>
    </details>
  );
}
