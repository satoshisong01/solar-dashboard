'use client';

import { useState } from 'react';
import { buttonClass, CONTROL_CLASS } from '@/components/ui/form-styles';
import { CHAIN_PRESET_DAYS, type ChainPeriod } from '@/lib/chain/period';
import { CHECK_CLASS } from '@/components/ui/form-styles';

type Choice = `${(typeof CHAIN_PRESET_DAYS)[number]}` | 'custom';

type Props = Readonly<{ siteCode: string; period: ChainPeriod; maxDay: string }>;

/** 체인 원장 기간 선택 (GET, URL에 선택이 남는다). 날짜는 KST, 양 끝 포함 */
export function ChainPeriodForm({ siteCode, period, maxDay }: Props) {
  const [choice, setChoice] = useState<Choice>(period.kind === 'custom' || period.presetDays === null ? 'custom' : `${period.presetDays}`);
  const options: readonly { readonly value: Choice; readonly label: string }[] = [...CHAIN_PRESET_DAYS.map((d) => ({ value: `${d}` as Choice, label: `최근 ${d}일` })), { value: 'custom', label: '사용자 지정' }];

  return (
    <form method="get" action={`/sites/${encodeURIComponent(siteCode)}#chain`} className="flex flex-wrap items-end gap-3" aria-label="체인 원장 기간 선택">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-ink-2">기간 (KST, 끝난 날까지)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 py-1.5">
          {options.map((option) => (
            <label key={option.value} className="inline-flex items-center gap-1.5 text-sm text-ink">
              <input type="radio" name="chain" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} className={CHECK_CLASS} />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {choice === 'custom' && (
        <>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            시작일
            <input type="date" name="from" required max={maxDay} defaultValue={period.fromDay} className={CONTROL_CLASS} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            끝일
            <input type="date" name="to" required max={maxDay} defaultValue={period.toDay} className={CONTROL_CLASS} />
          </label>
        </>
      )}
      <button type="submit" className={buttonClass('secondary')}>
        적용
      </button>
    </form>
  );
}
