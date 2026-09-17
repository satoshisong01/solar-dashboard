import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { AssetClassRow, MetricDefRow } from '@/lib/data/catalog';
import { ASSET_LEVEL_LABELS } from '@/lib/data/domains';
import { formatDuration, formatNumber } from '@/lib/format';
import { labelOf, ROLLUP_LABELS, VALUE_KIND_LABELS } from '@/lib/forms/limits';

function rangeText(min: number | null, max: number | null): string {
  if (min === null && max === null) return '—';
  return `${min === null ? '' : formatNumber(min, 3)} ~ ${max === null ? '' : formatNumber(max, 3)}`;
}

export function MetricDefTable({ rows, highlightKey }: Readonly<{ rows: readonly MetricDefRow[]; highlightKey: string | null }>) {
  if (rows.length === 0) return <EmptyNote>조건에 맞는 메트릭이 없습니다</EmptyNote>;
  return (
    <TableScroll label="메트릭 정의 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>키 · 이름</th>
            <th scope="col" className={TH_CLASS}>단위</th>
            <th scope="col" className={TH_CLASS}>값 종류 · 롤업</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>물리 범위</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>정상 범위</th>
            <th scope="col" className={TH_CLASS}>고착 기준</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>포인트</th>
            <th scope="col" className={TH_CLASS}><span className="sr-only">수정</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.key === highlightKey ? 'bg-ok-fill' : undefined}>
              <th scope="row" className={`${TD_CLASS} font-normal`}>
                <span className="font-mono font-medium text-ink">{row.key}</span>
                <span className="block text-xs text-ink-2">{row.nameKo}</span>
                {row.aliases.length > 0 && <span className="block text-xs text-muted">별칭: {row.aliases.join(', ')}</span>}
              </th>
              <td className={`${TD_CLASS} font-mono text-ink-2`}>{row.unit || '—'}</td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>
                {labelOf(VALUE_KIND_LABELS, row.valueKind)}
                <span className="block text-muted">{labelOf(ROLLUP_LABELS, row.rollup)}</span>
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS} text-xs`}>{rangeText(row.hardMin, row.hardMax)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} text-xs`}>{rangeText(row.expectedMin, row.expectedMax)}</td>
              <td className={`${TD_CLASS} text-xs whitespace-nowrap text-ink-2`}>{row.flatlineMaxS === null ? '—' : formatDuration(row.flatlineMaxS * 1000)}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.pointCount}</td>
              <td className={TD_CLASS}>
                <Link href={`/settings/catalog/metrics/${encodeURIComponent(row.key)}`} className="inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap text-accent hover:underline">
                  <Pencil aria-hidden="true" className="size-3.5" />
                  수정<span className="sr-only"> — {row.key}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function AssetClassTable({ rows }: Readonly<{ rows: readonly AssetClassRow[] }>) {
  if (rows.length === 0) return <EmptyNote>등록된 설비 종류가 없습니다</EmptyNote>;
  return (
    <TableScroll label="설비 종류 표" stickyFirst>
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>키 · 이름</th>
            <th scope="col" className={TH_CLASS}>수준</th>
            <th scope="col" className={TH_CLASS}>상위 종류</th>
            <th scope="col" className={TH_CLASS}>안전 이벤트 코드</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>설비 수</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={`${TD_CLASS} font-normal`}>
                <span className="font-mono font-medium text-ink">{row.key}</span>
                <span className="block text-xs text-ink-2">{row.nameKo}</span>
              </th>
              <td className={`${TD_CLASS} text-ink-2`}>{ASSET_LEVEL_LABELS[row.level] ?? row.level}</td>
              <td className={`${TD_CLASS} font-mono text-xs text-ink-2`}>{row.parentKey ?? '—'}</td>
              <td className={TD_CLASS}>
                {row.safetyEventCodes.length === 0 ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className="flex max-w-96 flex-wrap gap-1">
                    {row.safetyEventCodes.map((code) => (
                      <span key={code} className="rounded border border-crit/40 bg-crit-fill px-1.5 py-px font-mono text-xs text-crit">{code}</span>
                    ))}
                  </span>
                )}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{row.assetCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
