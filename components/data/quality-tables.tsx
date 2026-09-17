import Link from 'next/link';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { PointLabel, PointQualityRow, StuckPointRow } from '@/lib/data/data-quality';
import { isInvalidFlag, QUALITY_LABELS } from '@/lib/data/quality';
import { formatDuration, formatKstDateTime, formatNumber } from '@/lib/format';
import type { QualityFlag } from '@/lib/ingest/quality';

const FLAGS = Object.keys(QUALITY_LABELS) as QualityFlag[];

function PointCell({ point }: Readonly<{ point: PointLabel }>) {
  const href = `/sites/${encodeURIComponent(point.siteCode)}/assets/${point.assetId}?points=${point.pointId}&range=24h`;
  return (
    <th scope="row" className={`${TD_CLASS} font-normal`}>
      <Link href={href} className="font-medium text-ink hover:underline">
        {point.metricName}
        {point.qualifier && <span className="text-muted"> ({point.qualifier})</span>}
      </Link>
      <span className="block font-mono text-xs text-muted">
        {point.siteCode} · {point.assetCode}
      </span>
    </th>
  );
}

const percent = (count: number, total: number) => (total > 0 ? `${formatNumber((count / total) * 100, 1)}%` : '—');

export function PointQualityTable({ rows }: Readonly<{ rows: readonly PointQualityRow[] }>) {
  if (rows.length === 0) return <EmptyNote>조건에 맞는 품질 비트가 있는 포인트가 없습니다</EmptyNote>;
  return (
    <TableScroll label="포인트별 품질 비트 비율 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>포인트</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>샘플</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>품질 이상</th>
            {FLAGS.map((flag) => (
              <th key={flag} scope="col" className={`${TH_CLASS} text-right ${isInvalidFlag(flag) ? '' : 'text-muted'}`}>
                {QUALITY_LABELS[flag]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.pointId}>
              <PointCell point={row} />
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{formatNumber(row.samples, 0)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} ${row.invalid > 0 ? 'font-medium text-warn' : 'text-muted'}`}>{percent(row.invalid, row.samples)}</td>
              {FLAGS.map((flag) => (
                <td key={flag} className={`${TD_CLASS} ${NUM_CLASS} ${row.bitCounts[flag] === 0 ? 'text-muted' : ''}`}>
                  {row.bitCounts[flag] === 0 ? '—' : percent(row.bitCounts[flag], row.samples)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function StuckPointTable({ rows }: Readonly<{ rows: readonly StuckPointRow[] }>) {
  if (rows.length === 0) return <EmptyNote>조건에 맞는 고착 의심 포인트가 없습니다</EmptyNote>;
  return (
    <TableScroll label="고착 의심 포인트 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>포인트</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>그대로인 값</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>변화 없음</th>
            <th scope="col" className={TH_CLASS}>같은 값 시작 ~ 마지막 샘플</th>
            <th scope="col" className={TH_CLASS}>메트릭 고착 기준</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const stuckMs = row.lastTsMs - row.runStartMs;
            const overLimit = row.flatlineMaxS !== null && stuckMs > row.flatlineMaxS * 1000;
            return (
              <tr key={row.pointId}>
                <PointCell point={row} />
                <td className={`${TD_CLASS} ${NUM_CLASS}`}>
                  {formatNumber(row.lastValue, 3)} <span className="text-xs text-muted">{row.unit}</span>
                </td>
                <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap`}>
                  {row.wholeWindow ? '≥ ' : ''}
                  {formatDuration(stuckMs)}
                </td>
                <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>
                  {formatKstDateTime(row.runStartMs)} ~ {formatKstDateTime(row.lastTsMs)}
                  {row.wholeWindow && <span className="block font-sans text-muted">조회 구간 내내 같은 값</span>}
                </td>
                <td className={`${TD_CLASS} text-xs`}>
                  {row.flatlineMaxS === null ? (
                    <span className="text-muted">없음</span>
                  ) : (
                    <span className={overLimit ? 'font-medium text-warn' : 'text-ink-2'}>
                      {formatDuration(row.flatlineMaxS * 1000)}
                      {overLimit ? ' 초과' : ' 이내'}
                    </span>
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
