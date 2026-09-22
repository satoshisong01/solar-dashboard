'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { buildViewSearch, type RangeSelection } from '@/lib/data/range';
import { SERIES_LIMITS } from '@/lib/data/series-types';
import { fitsAxes } from './series-window';
import { CHECK_CLASS } from '@/components/ui/form-styles';
import { SkeletonSpinner } from '@/components/ui/skeleton';

export interface PickablePoint {
  readonly id: number;
  readonly label: string;
  readonly unit: string;
}

type SelectionUrl = Readonly<{ basePath: string; selection: RangeSelection }>;

/** 선택을 바꾼 URL. 선택은 URL 쿼리(points=)에 두고 서버가 다시 그린다.
 * 같은 화면 안에서 쿼리만 바뀌어 loading.tsx 골격이 뜨지 않는다 — 진행 상태를 함께 돌려줘 부르는 쪽이 배지를 띄운다. */
export function useSelectionNavigator({ basePath, selection }: SelectionUrl) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const navigate = (pointIds: readonly number[]) =>
    startNavigation(() => router.replace(`${basePath}?${buildViewSearch(pointIds, selection)}`, { scroll: false }));
  return { navigate, navigating };
}

/** 선택할 수 없는 이유. 없으면 null */
export function blockReason(point: PickablePoint, selected: readonly PickablePoint[]): string | null {
  if (selected.some((item) => item.id === point.id)) return null;
  if (selected.length >= SERIES_LIMITS.maxPointIds) return `최대 ${SERIES_LIMITS.maxPointIds}개`;
  if (!fitsAxes(selected.map((item) => item.unit), point.unit)) return '단위 2개 초과';
  return null;
}

type PointPickerProps = SelectionUrl &
  Readonly<{
    points: readonly PickablePoint[];
    selectedIds: readonly number[];
  }>;

/** 자산 상세의 차트 포인트 선택 (최대 8개, 단위 2개) */
export function PointPicker({ points, selectedIds, basePath, selection }: PointPickerProps) {
  const { navigate, navigating } = useSelectionNavigator({ basePath, selection });
  const selected = points.filter((point) => selectedIds.includes(point.id));

  function toggle(point: PickablePoint, checked: boolean) {
    navigate(checked ? [...selectedIds, point.id] : selectedIds.filter((id) => id !== point.id));
  }

  return (
    <fieldset className="flex flex-col gap-2">
      {navigating && <SkeletonSpinner />}
      <legend className="mb-1 text-xs text-muted">
        차트에 표시할 포인트 ({selectedIds.length}/{SERIES_LIMITS.maxPointIds}, 단위는 2개까지)
      </legend>
      <ul className="flex flex-wrap gap-2">
        {points.map((point) => {
          const checked = selectedIds.includes(point.id);
          const reason = blockReason(point, selected);
          return (
            <li key={point.id}>
              <label
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${
                  checked ? 'border-accent bg-hydrogen-fill text-ink' : 'border-rule-strong bg-sunken text-ink-2'
                } ${reason ? 'opacity-60' : 'cursor-pointer hover:bg-sunken'}`}
                title={reason ?? undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={reason !== null}
                  onChange={(event) => toggle(point, event.target.checked)}
                  className={CHECK_CLASS}
                />
                {point.label}
                {point.unit && <span className="font-mono text-xs text-muted">{point.unit}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
