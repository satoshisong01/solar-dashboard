'use client';

import { Search } from 'lucide-react';
import { useState } from 'react';
import { buttonClass, CONTROL_CLASS } from '@/components/forms/controls';
import type { ReportPeriodKind } from '@/lib/report/pack-types';
import { CHECK_CLASS } from '@/components/ui/form-styles';

export interface ScopeDefaults {
  readonly site: string;
  readonly kind: ReportPeriodKind;
  readonly month: string;
  readonly year: string;
  readonly quarter: string;
  readonly from: string;
  readonly to: string;
}

const KINDS: readonly { readonly value: ReportPeriodKind; readonly label: string }[] = [
  { value: 'month', label: '월간' },
  { value: 'quarter', label: '분기' },
  { value: 'custom', label: '사용자 지정' },
];

type Props = Readonly<{ sites: readonly Readonly<{ code: string; name: string }>[]; defaults: ScopeDefaults }>;

/** 1단계: 사이트·기간을 골라 포함할 발견사항 후보를 불러온다 (GET, URL에 선택이 남는다) */
export function ReportScopeForm({ sites, defaults }: Props) {
  const [kind, setKind] = useState<ReportPeriodKind>(defaults.kind);
  return (
    <form method="get" action="/reports" className="flex flex-col gap-3" aria-label="리포트 사이트·기간 선택">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          사이트
          <select name="site" defaultValue={defaults.site} required className={`${CONTROL_CLASS} min-w-44`}>
            <option value="">사이트를 고르세요</option>
            {sites.map((site) => (
              <option key={site.code} value={site.code}>
                {site.code} · {site.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-ink-2">기간</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 py-1.5">
            {KINDS.map((option) => (
              <label key={option.value} className="inline-flex items-center gap-1.5 text-sm text-ink">
                <input type="radio" name="kind" value={option.value} checked={kind === option.value} onChange={() => setKind(option.value)} className={CHECK_CLASS} />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        {kind === 'month' && (
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            월 (KST)
            <input type="month" name="month" required defaultValue={defaults.month} className={CONTROL_CLASS} />
          </label>
        )}
        {kind === 'quarter' && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              연도
              <input type="number" name="year" min={2000} max={2100} required defaultValue={defaults.year} className={`${CONTROL_CLASS} w-24`} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              분기
              <select name="quarter" defaultValue={defaults.quarter} className={CONTROL_CLASS}>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>
                    {q}분기
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {kind === 'custom' && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              시작일
              <input type="date" name="from" required defaultValue={defaults.from} className={CONTROL_CLASS} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              종료일 (포함)
              <input type="date" name="to" required defaultValue={defaults.to} className={CONTROL_CLASS} />
            </label>
          </>
        )}
        <button type="submit" className={buttonClass('secondary')}>
          <Search aria-hidden="true" className="size-4" />
          발견사항 불러오기
        </button>
      </div>
    </form>
  );
}
