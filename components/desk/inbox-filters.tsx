import Link from 'next/link';
import { CONTROL_CLASS } from '@/components/ui/form-styles';
import { statusLabel } from '@/lib/analysis/transition-rules';
import { FLEET_COLUMNS } from '@/lib/data/domains';
import { STATUS_FILTER_OPTIONS, type InboxFilter, type StatusFilter } from '@/lib/desk/inbox';
import { CATEGORY_LABELS, FINDING_CATEGORIES, SEVERITY_LEVELS, severityLabel } from '@/lib/desk/labels';
import { severityAction } from '@/lib/desk/plain/common';

const statusFilterLabel = (value: StatusFilter): string => (value === 'open' ? '열린 건 (기각·효과 확인 제외)' : value === 'all' ? '전체' : statusLabel(value));

const SELECT_CLASS = `${CONTROL_CLASS} min-w-32`;

type InboxFiltersProps = Readonly<{ filter: InboxFilter; siteCodes: readonly string[] }>;

/** 인박스 필터. 상태는 URL 쿼리에 두므로 JavaScript 없이도 동작하는 GET 폼이다 */
export function InboxFilters({ filter, siteCodes }: InboxFiltersProps) {
  return (
    <form method="get" action="/desk" className="flex flex-wrap items-end gap-3" aria-label="발견사항 필터">
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        사이트
        <select name="site" defaultValue={filter.site ?? ''} className={SELECT_CLASS}>
          <option value="">전체</option>
          {siteCodes.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        도메인
        <select name="domain" defaultValue={filter.domain ?? ''} className={SELECT_CLASS}>
          <option value="">전체</option>
          {FLEET_COLUMNS.map((column) => (
            <option key={column.key} value={column.key}>
              {column.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        카테고리
        <select name="category" defaultValue={filter.category ?? ''} className={SELECT_CLASS}>
          <option value="">전체</option>
          {FINDING_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        급함(심각도)
        <select name="severity" defaultValue={filter.minSeverity === null ? '' : String(filter.minSeverity)} className={SELECT_CLASS}>
          <option value="">전체</option>
          {SEVERITY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {severityAction(level)}({severityLabel(level)}) 이상
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        상태
        <select name="status" defaultValue={filter.status} className={SELECT_CLASS}>
          {STATUS_FILTER_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {statusFilterLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" className="rounded-md border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink-2 hover:bg-sunken hover:text-ink">
          적용
        </button>
        <Link href="/desk#inbox" className="text-sm text-ink-2 underline hover:text-ink">
          초기화
        </Link>
      </div>
    </form>
  );
}
