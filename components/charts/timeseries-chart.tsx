'use client';

import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SERIES_LIMITS, buildSeriesSearch, type SeriesPayload } from '@/lib/data/series-types';
import { formatDuration } from '@/lib/format';
import { useChartTheme } from './chart-theme';
import { EChart, type ZoomRange } from './echart';
import { buildSeriesOption, type ChartEventMark, type ChartPointMeta } from './series-options';
import { assignAxes, isFullZoom, mergeWindow, zoomWindow } from './series-window';

export type { ChartEventMark, ChartPointMeta };

const ZOOM_DEBOUNCE_MS = 350;

type FetchState = Readonly<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string }>;

type TimeseriesChartProps = Readonly<{
  points: readonly ChartPointMeta[];
  /** 서버에서 전체 기간으로 먼저 조회한 데이터 */
  initial: SeriesPayload;
  events?: readonly ChartEventMark[];
}>;

function isSeriesPayload(value: unknown): value is SeriesPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.source === 'raw' || record.source === '1h') &&
    typeof record.bucketSeconds === 'number' &&
    typeof record.fromMs === 'number' &&
    typeof record.toMs === 'number' &&
    Array.isArray(record.series)
  );
}

async function fetchDetail(query: Parameters<typeof buildSeriesSearch>[0], signal: AbortSignal): Promise<SeriesPayload> {
  const response = await fetch(`/api/series?${buildSeriesSearch(query)}`, { signal, cache: 'no-store' });
  if (response.status === 401 || response.status === 403) throw new Error('세션이 끝났습니다. 다시 로그인하세요.');
  if (!response.ok) throw new Error('확대 구간을 불러오지 못했습니다.');
  const body: unknown = await response.json();
  if (!isSeriesPayload(body)) throw new Error('확대 구간 응답 형식이 올바르지 않습니다.');
  return body;
}

/**
 * 여러 포인트의 시계열(버킷 평균 선, 툴팁에 최소·최대). 단위별 y축은 최대 2개.
 * 확대하면 디바운스 후 /api/series로 그 구간을 더 촘촘하게 다시 받아 끼워 넣는다.
 */
export function TimeseriesChart({ points, initial, events = [] }: TimeseriesChartProps) {
  const theme = useChartTheme();
  const [detail, setDetail] = useState<SeriesPayload | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' });
  const [showEvents, setShowEvents] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const pointIds = useMemo(() => points.map((point) => point.id), [points]);

  const handleZoom = useCallback(
    (zoom: ZoomRange) => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        abortRef.current?.abort();
        if (isFullZoom(zoom.startPct, zoom.endPct)) {
          setDetail(null);
          setFetchState({ kind: 'idle' });
          return;
        }
        const zoomed = zoomWindow(initial.fromMs, initial.toMs, zoom.startPct, zoom.endPct);
        const controller = new AbortController();
        abortRef.current = controller;
        setFetchState({ kind: 'loading' });
        try {
          const payload = await fetchDetail({ pointIds, ...zoomed, maxPoints: SERIES_LIMITS.defaultMaxPoints }, controller.signal);
          setDetail(payload);
          setFetchState({ kind: 'idle' });
        } catch (error) {
          if (controller.signal.aborted) return;
          setFetchState({ kind: 'error', message: error instanceof Error ? error.message : '확대 구간을 불러오지 못했습니다.' });
        }
      }, ZOOM_DEBOUNCE_MS);
    },
    [initial.fromMs, initial.toMs, pointIds],
  );

  const data = useMemo(() => (detail ? mergeWindow(initial, detail) : initial), [initial, detail]);
  const option = useMemo(
    () => (theme ? buildSeriesOption({ theme, points, data, events: showEvents ? events : [] }) : null),
    [theme, points, data, events, showEvents],
  );

  const { axisIndexes } = assignAxes(points.map((point) => point.unit));
  const hidden = points.filter((_, index) => axisIndexes[index] === null);
  const empty = initial.series.every((series) => series.rows.length === 0);
  const resolution = detail ?? initial;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted">
        <p>
          {resolution.source === 'raw' ? '원시' : '1시간 롤업'} · {formatDuration(resolution.bucketSeconds * 1_000)} 구간의 평균
          (툴팁에 최소·최대){detail ? ' · 확대 구간 재조회' : ''}
        </p>
        <div className="flex items-center gap-3">
          {fetchState.kind === 'loading' && (
            <span className="inline-flex items-center gap-1" role="status">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              불러오는 중
            </span>
          )}
          {events.length > 0 && (
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={showEvents} onChange={(event) => setShowEvents(event.target.checked)} className="accent-accent" />
              이벤트 밴드 {events.length}건
            </label>
          )}
        </div>
      </div>
      {fetchState.kind === 'error' && (
        <p role="alert" className="rounded-md border border-crit/40 bg-crit-fill px-3 py-2 text-sm text-crit">
          {fetchState.message}
        </p>
      )}
      {hidden.length > 0 && (
        <p className="text-sm text-warn">단위가 세 가지 이상이라 {hidden.map((point) => point.label).join(', ')}은(는) 그리지 않았습니다.</p>
      )}
      <div className="relative">
        <EChart
          option={option}
          onDataZoom={handleZoom}
          className="h-80 w-full md:h-96"
          ariaLabel={`시계열 차트: ${points.map((point) => point.label).join(', ')}`}
        />
        {empty && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
            이 기간에 수신한 데이터가 없습니다
          </p>
        )}
      </div>
    </div>
  );
}
