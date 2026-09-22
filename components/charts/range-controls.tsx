'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { SkeletonSpinner } from '@/components/ui/skeleton';
import {
  RANGE_PRESETS,
  RANGE_PRESET_KEYS,
  buildViewSearch,
  fromKstInputValue,
  type RangeSelection,
} from '@/lib/data/range';
import { SERIES_LIMITS } from '@/lib/data/series-types';
import { toKstInputValue } from '@/lib/format';

type RangeControlsProps = Readonly<{
  basePath: string;
  pointIds: readonly number[];
  selection: RangeSelection;
  fromMs: number;
  toMs: number;
}>;

const PRESET_CLASS =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors max-lg:min-h-11 ' +
  'border-rule-strong bg-sunken text-ink-2 hover:bg-rule hover:text-ink ' +
  'aria-[current=true]:border-accent aria-[current=true]:bg-hydrogen-fill aria-[current=true]:text-ink';

/** 기간 선택: 24시간 · 7일 · 30일(링크) + 사용자 지정(KST 시각 입력). 상태는 URL 쿼리에 둔다 */
export function RangeControls({ basePath, pointIds, selection, fromMs, toMs }: RangeControlsProps) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const formId = useId();
  const [customOpen, setCustomOpen] = useState(selection.kind === 'custom');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = fromKstInputValue(String(form.get('from') ?? ''));
    const to = fromKstInputValue(String(form.get('to') ?? ''));
    if (from === null || to === null) return setError('시작·끝 시각을 모두 입력하세요.');
    if (from >= to) return setError('끝 시각은 시작 시각보다 뒤여야 합니다.');
    if (to - from > SERIES_LIMITS.maxSpanMs) return setError('기간은 366일 이하로 지정하세요.');
    setError(null);
    startNavigation(() => router.push(`${basePath}?${buildViewSearch(pointIds, { kind: 'custom', fromMs: from, toMs: to })}`, { scroll: false }));
  }

  return (
    <div className="flex flex-col gap-3">
      {navigating && <SkeletonSpinner />}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="기간">
        {RANGE_PRESET_KEYS.map((preset) => (
          <Link
            key={preset}
            href={`${basePath}?${buildViewSearch(pointIds, { kind: 'preset', preset })}`}
            scroll={false}
            aria-current={selection.kind === 'preset' && selection.preset === preset}
            className={PRESET_CLASS}
          >
            {RANGE_PRESETS[preset].label}
          </Link>
        ))}
        <button
          type="button"
          aria-expanded={customOpen}
          aria-controls={formId}
          aria-current={selection.kind === 'custom'}
          onClick={() => setCustomOpen((open) => !open)}
          className={PRESET_CLASS}
        >
          사용자 지정
        </button>
      </div>

      {customOpen && (
        <form id={formId} onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            시작 (KST)
            <input
              type="datetime-local"
              name="from"
              defaultValue={toKstInputValue(fromMs)}
              className="rounded-md border border-rule-strong bg-field px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            끝 (KST)
            <input
              type="datetime-local"
              name="to"
              defaultValue={toKstInputValue(toMs)}
              className="rounded-md border border-rule-strong bg-field px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <Button type="submit" variant="secondary" className="py-1.5">
            적용
          </Button>
          {error && (
            <p role="alert" className="basis-full text-sm text-crit">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
