import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status';
import { FLEET_COLUMNS } from '@/lib/data/domains';
import type { FleetRow } from '@/lib/data/fleet';

/** 사이트 × 도메인 상태 표. 셀마다 상태 배지와 사유를 글자로 보여 준다 (색만으로 구분하지 않음) */
export function FleetMatrix({ rows }: Readonly<{ rows: readonly FleetRow[] }>) {
  if (rows.length === 0) return <EmptyNote>등록된 사이트가 없습니다</EmptyNote>;

  return (
    <TableScroll label="사이트 × 도메인 상태 매트릭스" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>사이트</th>
            {FLEET_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className={TH_CLASS}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.site.id}>
              <th scope="row" className={`${TD_CLASS} min-w-32 font-medium`}>
                <Link href={`/sites/${encodeURIComponent(row.site.code)}`} className="text-ink hover:underline">
                  {row.site.code}
                </Link>
                <span className="block text-xs font-normal text-muted">{row.site.name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge level={row.overall} />
                  {row.unackedSafety > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-crit">
                      <ShieldAlert aria-hidden="true" className="size-3.5" />
                      안전 {row.unackedSafety}
                    </span>
                  )}
                </span>
              </th>
              {FLEET_COLUMNS.map((column) => {
                const cell = row.cells[column.key];
                return (
                  <td key={column.key} className={`${TD_CLASS} min-w-28`}>
                    <StatusBadge level={cell.level} />
                    {cell.reasons.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-ink-2">
                        {cell.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
