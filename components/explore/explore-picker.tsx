'use client';

import { ChevronRight, Link2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { blockReason, useSelectionNavigator } from '@/components/charts/point-picker';
import { SkeletonSpinner } from '@/components/ui/skeleton';
import type { RangeSelection } from '@/lib/data/range';
import { SERIES_LIMITS } from '@/lib/data/series-types';
import { explorePointLabel, visibleTree, type ExploreAsset, type ExplorePoint, type VisibleNode } from './explore-filter';
import { CHECK_CLASS } from '@/components/ui/form-styles';

type ExplorePickerProps = Readonly<{
  assets: readonly ExploreAsset[];
  points: readonly ExplorePoint[];
  metrics: readonly Readonly<{ key: string; name: string }>[];
  selectedIds: readonly number[];
  selection: RangeSelection;
}>;

type CopyState = 'idle' | 'copied' | 'failed';

function PointOption({ point, selected, onToggle }: Readonly<{ point: ExplorePoint; selected: readonly ExplorePoint[]; onToggle: (id: number, on: boolean) => void }>) {
  const checked = selected.some((item) => item.id === point.id);
  const reason = blockReason({ id: point.id, label: point.metricName, unit: point.unit }, selected.map((item) => ({ id: item.id, label: item.metricName, unit: item.unit })));
  return (
    <li>
      <label className={`flex items-baseline gap-2 rounded px-1 py-0.5 text-sm max-lg:min-h-11 max-lg:items-center ${reason ? 'text-muted' : 'cursor-pointer text-ink-2 hover:bg-sunken'}`} title={reason ?? undefined}>
        <input type="checkbox" checked={checked} disabled={reason !== null} onChange={(event) => onToggle(point.id, event.target.checked)} className={CHECK_CLASS} />
        <span>
          {point.metricName}
          {point.qualifier && <span className="text-muted"> ({point.qualifier})</span>}
        </span>
        {point.unit && <span className="font-mono text-xs text-muted">{point.unit}</span>}
        {reason && <span className="text-xs">{reason}</span>}
      </label>
    </li>
  );
}

const containsSelected = (node: VisibleNode, selected: readonly ExplorePoint[]): boolean =>
  node.points.some((point) => selected.some((item) => item.id === point.id)) || node.children.some((child) => containsSelected(child, selected));

function AssetBranch(props: Readonly<{ node: VisibleNode; filtering: boolean; selected: readonly ExplorePoint[]; onToggle: (id: number, on: boolean) => void }>) {
  const { node, filtering, selected, onToggle } = props;
  return (
    <li>
      <details open={filtering || containsSelected(node, selected)}>
        <summary className="flex cursor-pointer list-none items-baseline gap-1.5 rounded py-0.5 text-sm max-lg:min-h-11 max-lg:items-center hover:bg-sunken [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted transition-transform [details[open]>summary>&]:rotate-90" />
          <span className="font-medium text-ink">{node.asset.name}</span>
          <span className="font-mono text-xs text-muted">{node.asset.code}</span>
        </summary>
        <div className="ml-1.5 border-l border-rule pl-3">
          {node.points.length > 0 && (
            <ul className="flex flex-col">
              {node.points.map((point) => (
                <PointOption key={point.id} point={point} selected={selected} onToggle={onToggle} />
              ))}
            </ul>
          )}
          {node.children.length > 0 && (
            <ul className="flex flex-col">
              {node.children.map((child) => (
                <AssetBranch key={child.asset.id} node={child} filtering={filtering} selected={selected} onToggle={onToggle} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

/** 탐색기: 사이트·설비 트리 + 메트릭 필터로 포인트를 최대 8개 고른다. 선택·기간은 URL에 두어 링크로 공유한다 */
export function ExplorePicker({ assets, points, metrics, selectedIds, selection }: ExplorePickerProps) {
  const { navigate, navigating } = useSelectionNavigator({ basePath: '/explore', selection });
  const [metricKey, setMetricKey] = useState('');
  const [text, setText] = useState('');
  const [copy, setCopy] = useState<CopyState>('idle');

  const selected = useMemo(() => selectedIds.flatMap((id) => points.filter((point) => point.id === id)), [points, selectedIds]);
  const tree = useMemo(() => visibleTree(assets, points, { metricKey, text }), [assets, points, metricKey, text]);
  const filtering = metricKey !== '' || text.trim() !== '';

  const toggle = (id: number, on: boolean) => navigate(on ? [...selectedIds, id] : selectedIds.filter((item) => item !== id));

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {navigating && <SkeletonSpinner />}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-2">
            선택 {selected.length}/{SERIES_LIMITS.maxPointIds} <span className="text-xs text-muted">(단위는 2개까지)</span>
          </p>
          <div className="flex items-center gap-2">
            {selected.length > 0 && (
              <button type="button" onClick={() => navigate([])} className="inline-flex items-center rounded-md px-2 py-1 text-sm text-ink-2 max-lg:min-h-11 hover:bg-sunken">
                모두 해제
              </button>
            )}
            <button type="button" onClick={copyLink} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong bg-sunken px-2.5 py-1 text-sm text-ink-2 max-lg:min-h-11 hover:bg-rule">
              <Link2 aria-hidden="true" className="size-4" />
              링크 복사
            </button>
            <span role="status" className="text-xs text-muted">
              {copy === 'copied' ? '현재 보기 링크를 복사했습니다' : copy === 'failed' ? '복사하지 못했습니다. 주소창의 URL을 쓰세요' : ''}
            </span>
          </div>
        </div>
        {selected.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="선택한 포인트">
            {selected.map((point) => (
              <li key={point.id} className="inline-flex items-center gap-1 rounded-md border border-accent bg-hydrogen-fill py-0.5 pr-1 pl-2 text-sm text-ink">
                {explorePointLabel(point)}
                <button type="button" onClick={() => toggle(point.id, false)} aria-label={`${explorePointLabel(point)} 선택 해제`} className="inline-flex items-center justify-center rounded p-0.5 max-lg:size-11 hover:bg-surface">
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
          메트릭
          <select value={metricKey} onChange={(event) => setMetricKey(event.target.value)} className="rounded-md border border-rule-strong bg-field px-2 py-1.5 text-sm text-ink">
            <option value="">모든 메트릭</option>
            {metrics.map((metric) => (
              <option key={metric.key} value={metric.key}>
                {metric.name} ({metric.key})
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
          검색 (설비 코드·이름, 메트릭)
          <input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="예: INV01, 스택 전압" className="rounded-md border border-rule-strong bg-field px-2 py-1.5 text-sm text-ink placeholder:text-muted" />
        </label>
      </div>

      {tree.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-4 py-5 text-center text-sm text-muted">
          {points.length === 0 ? '매핑된 포인트가 없습니다' : '조건에 맞는 포인트가 없습니다'}
        </p>
      ) : (
        <ul className="flex max-h-[28rem] flex-col gap-1 overflow-y-auto rounded-md border border-rule p-2">
          {tree.map((site) => (
            <li key={site.siteCode}>
              <details open={filtering || selected.some((point) => point.siteCode === site.siteCode)}>
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 font-semibold text-ink hover:bg-sunken [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden="true" className="size-4 text-muted transition-transform [details[open]>summary>&]:rotate-90" />
                  {site.siteCode}
                  <span className="text-xs font-normal text-muted">포인트 {site.pointCount}</span>
                </summary>
                <ul className="ml-2 flex flex-col">
                  {site.nodes.map((node) => (
                    <AssetBranch key={node.asset.id} node={node} filtering={filtering} selected={selected} onToggle={toggle} />
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
