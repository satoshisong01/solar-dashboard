import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { LatestSample, PointInfo, QualitySummary } from '@/lib/data/points';
import { QUALITY_LABELS, isInvalidFlag, qualityFlags } from '@/lib/data/quality';
import { formatAgo, formatKstDateTimeSeconds, formatNumber } from '@/lib/format';

type PointTableProps = Readonly<{
  points: readonly PointInfo[];
  latest: ReadonlyMap<number, LatestSample>;
  quality: ReadonlyMap<number, QualitySummary>;
  nowMs: number;
}>;

function QualityCell({ sample, summary }: Readonly<{ sample: LatestSample | undefined; summary: QualitySummary | undefined }>) {
  const flags = sample ? qualityFlags(sample.quality) : [];
  const ratio = summary && summary.samples > 0 ? summary.invalid / summary.samples : null;
  return (
    <td className={`${TD_CLASS} min-w-40`}>
      {sample === undefined ? (
        <span className="text-muted">—</span>
      ) : flags.length === 0 ? (
        <span className="text-ok">정상</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {flags.map((flag) => (
            <span
              key={flag}
              className={`rounded border px-1.5 py-px text-xs ${isInvalidFlag(flag) ? 'border-warn/40 bg-warn-fill text-warn' : 'border-rule bg-sunken text-ink-2'}`}
            >
              {QUALITY_LABELS[flag]}
            </span>
          ))}
        </span>
      )}
      <span className="mt-0.5 block text-xs text-muted">
        24시간 품질 이상 {ratio === null ? '샘플 없음' : `${formatNumber(ratio * 100, 1)}% (${formatNumber(summary?.samples ?? 0, 0)}개 중)`}
      </span>
    </td>
  );
}

/** 설비 포인트별 최신값·단위·품질 비트·마지막 수신 */
export function PointTable({ points, latest, quality, nowMs }: PointTableProps) {
  if (points.length === 0) return <EmptyNote>이 설비에 매핑된 포인트가 없습니다</EmptyNote>;

  return (
    <TableScroll label="포인트 목록 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>메트릭</th>
            <th scope="col" className={TH_CLASS}>원본 태그</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>최신값</th>
            <th scope="col" className={TH_CLASS}>단위</th>
            <th scope="col" className={TH_CLASS}>품질 (최신 샘플)</th>
            <th scope="col" className={TH_CLASS}>마지막 수신</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => {
            const sample = latest.get(point.id);
            return (
              <tr key={point.id}>
                <th scope="row" className={`${TD_CLASS} font-normal`}>
                  <span className="text-ink">{point.metricName}</span>
                  <span className="block font-mono text-xs text-muted">
                    {point.metricKey}
                    {point.qualifier && ` · ${point.qualifier}`}
                  </span>
                </th>
                <td className={`${TD_CLASS} font-mono text-xs text-ink-2`}>{point.sourceKey}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap text-ink`}>
                  {sample === undefined ? <span className="text-muted">수신 없음</span> : sample.value === null ? <span className="text-muted">결측</span> : formatNumber(sample.value, 3)}
                </td>
                <td className={`${TD_CLASS} font-mono text-xs text-ink-2`}>{point.unit || '—'}</td>
                <QualityCell sample={sample} summary={quality.get(point.id)} />
                <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                  {sample === undefined ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      {formatAgo(sample.tsMs, nowMs)}
                      <span className="block font-mono text-xs text-muted">{formatKstDateTimeSeconds(sample.tsMs)}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
