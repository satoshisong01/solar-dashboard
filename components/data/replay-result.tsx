'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReplayData } from '@/app/(console)/data/actions';
import { formatNumber } from '@/lib/format';

const n = (value: number) => formatNumber(value, 0);

/** 재처리 결과 요약과 자산 상세 차트 링크 (새 포인트를 30일 범위로 선택) */
export function ReplayResult({ data }: Readonly<{ data: ReplayData }>) {
  return (
    <div className="flex flex-col gap-2 text-ink">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">새로 적재된 행</dt>
          <dd className="font-mono text-base tabular-nums">{n(data.accepted)}</dd>
        </div>
        <div>
          <dt className="text-muted">이미 있던 행</dt>
          <dd className="font-mono tabular-nums">{n(data.duplicate)}</dd>
        </div>
        <div>
          <dt className="text-muted">거부 · 결측</dt>
          <dd className="font-mono tabular-nums">
            {n(data.rejected)} · {n(data.missing)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">원본 배치 (실패)</dt>
          <dd className="font-mono tabular-nums">
            {n(data.batches)} ({n(data.failedBatches)})
          </dd>
        </div>
        <div>
          <dt className="text-muted">다시 계산한 시간 롤업</dt>
          <dd className="font-mono tabular-nums">{n(data.rollupHours)}</dd>
        </div>
        <div>
          <dt className="text-muted">인박스에서 정리한 태그</dt>
          <dd className="font-mono tabular-nums">{n(data.clearedInbox)}</dd>
        </div>
      </dl>
      {data.points.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {data.points.map((point) => (
            <li key={point.pointId}>
              <Link
                href={`/sites/${encodeURIComponent(point.siteCode)}/assets/${point.assetId}?points=${point.pointId}&range=30d`}
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                {point.siteCode} {point.assetCode} · {point.metricName} 차트 보기
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
              <span className="ml-2 font-mono text-xs text-muted">{point.sourceKey}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
