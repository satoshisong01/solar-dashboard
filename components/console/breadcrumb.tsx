import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/** 상세 화면 위치 표시. 마지막 항목은 현재 화면 */
export function Breadcrumb({ items }: Readonly<{ items: readonly Crumb[] }>) {
  return (
    <nav aria-label="위치" className="-mb-3">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight aria-hidden="true" className="size-3.5" />}
            {item.href ? (
              <Link href={item.href} className="hover:text-ink hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-2">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
