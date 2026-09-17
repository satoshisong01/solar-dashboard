import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { gatewayLevel } from '@/components/sites/site-panels';
import { StatusBadge } from '@/components/ui/status';
import type { GatewayIngestRow } from '@/lib/data/ingest-status';
import { formatAgo, formatKstDateTime, formatNumber } from '@/lib/format';
// 서버 컴포넌트에서만 쓴다: 수집 규칙과 같은 시계 오차 기준 (넘으면 샘플에 CLOCK_SUSPECT)
import { CLOCK_SKEW_LIMIT_MS } from '@/lib/ingest/normalize';

function ClockOffset({ offsetMs }: Readonly<{ offsetMs: number | null }>) {
  if (offsetMs === null) return <span className="text-muted">—</span>;
  const suspect = Math.abs(offsetMs) > CLOCK_SKEW_LIMIT_MS;
  return (
    <span className={suspect ? 'font-medium text-warn' : undefined}>
      {offsetMs > 0 ? '+' : ''}
      {formatNumber(offsetMs, 0)} ms
      {suspect && <span className="block font-sans text-xs">시계 의심 (±120초 초과)</span>}
    </span>
  );
}

const count = (value: number) => formatNumber(value, 0);

export function GatewayIngestTable({ rows, nowMs }: Readonly<{ rows: readonly GatewayIngestRow[]; nowMs: number }>) {
  if (rows.length === 0) return <EmptyNote>등록된 게이트웨이가 없습니다. 설정 › 게이트웨이·키에서 만드세요.</EmptyNote>;

  return (
    <TableScroll label="게이트웨이 수집 상태 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>게이트웨이</th>
            <th scope="col" className={TH_CLASS}>상태</th>
            <th scope="col" className={TH_CLASS}>마지막 수신</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>시계 오차</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>24h 배치</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>24h 적재 샘플</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>24h 중복 샘플</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>24h 거부 샘플</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>24h 미매핑 샘플</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>활성 키</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className={`${TD_CLASS} font-medium`}>
                <span className="font-mono text-ink">{row.code}</span>
                <span className="block text-xs font-normal text-muted">{row.siteCode}</span>
              </th>
              <td className={TD_CLASS}>
                {row.status === 'active' ? <StatusBadge level={gatewayLevel(row, nowMs)} /> : <span className="text-xs text-muted">비활성</span>}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-ink-2`}>
                {row.lastSeenMs === null ? (
                  '수신 기록 없음'
                ) : (
                  <>
                    {formatAgo(row.lastSeenMs, nowMs)}
                    <span className="block font-mono text-xs text-muted">{formatKstDateTime(row.lastSeenMs)}</span>
                  </>
                )}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}><ClockOffset offsetMs={row.clockOffsetMs} /></td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{count(row.batches24h)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{count(row.accepted24h)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{count(row.duplicate24h)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} ${row.rejected24h > 0 ? 'text-warn' : ''}`}>{count(row.rejected24h)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} ${row.unmapped24h > 0 ? 'text-warn' : ''}`}>{count(row.unmapped24h)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} ${row.activeKeys === 0 ? 'text-crit' : ''}`}>{row.activeKeys}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
