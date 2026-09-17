import Link from 'next/link';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { ReportListRow } from '@/lib/data/reports';
import { formatKstDateTime } from '@/lib/format';
import { ReportStatusBadge, ValidationBadge } from './report-badges';

/** 리포트 목록: 사이트·기간·상태·검증 결과 */
export function ReportList({ reports }: Readonly<{ reports: readonly ReportListRow[] }>) {
  if (reports.length === 0) return <EmptyNote>아직 만든 리포트가 없습니다. 위에서 사이트와 기간을 고르고 리포트를 만드세요.</EmptyNote>;
  return (
    <TableScroll label="리포트 목록 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>리포트</th>
            <th scope="col" className={TH_CLASS}>사이트</th>
            <th scope="col" className={TH_CLASS}>기간</th>
            <th scope="col" className={TH_CLASS}>상태</th>
            <th scope="col" className={TH_CLASS}>검증</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>발견사항</th>
            <th scope="col" className={TH_CLASS}>작성 · 승인</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td className={TD_CLASS}>
                <Link href={`/reports/${r.id}`} className="font-mono font-medium text-ink underline">
                  #{r.id}
                </Link>
              </td>
              <td className={TD_CLASS}>
                <span className="block font-medium text-ink">{r.siteCode}</span>
                <span className="block text-xs text-muted">{r.siteName}</span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{r.periodLabel}</td>
              <td className={TD_CLASS}>
                <ReportStatusBadge status={r.status} />
              </td>
              <td className={TD_CLASS}>
                <ValidationBadge ok={r.validationOk} issueCount={r.issueCount} />
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{r.findingCount}</td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>
                {r.createdBy}
                <span className="block font-mono text-muted">{formatKstDateTime(r.createdAtMs)}</span>
                {r.approvedBy && r.approvedAtMs !== null && (
                  <span className="block text-ok">
                    승인 {r.approvedBy} · <span className="font-mono">{formatKstDateTime(r.approvedAtMs)}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
