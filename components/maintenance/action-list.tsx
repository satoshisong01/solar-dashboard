import Link from 'next/link';
import { EmptyNote, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { isFindingStatus, statusLabel } from '@/lib/analysis/transition-rules';
import type { ActionListRow } from '@/lib/data/maintenance';
import { formatKstDateTime } from '@/lib/format';
import { actionProgress, type ActionProgress } from '@/lib/maintenance/progress';
import { ProgressBar, VerificationBadge } from './verification-badge';
import { VerifyOnlyButton } from './verify-only-button';

const SOURCE_LABELS: Readonly<Record<string, string>> = { manual: '직접', csv: 'CSV' };

export const progressOf = (row: ActionListRow, nowMs: number): ActionProgress => actionProgress({ performedAt: row.performedAtMs, expectedEffect: row.expectedEffect, verdict: row.verification?.verdict ?? null }, nowMs);

/** 조치 목록: 사이트·설비·조치 유형·수행일·연결 발견사항·검증 상태 */
export function ActionList({ rows, nowMs }: Readonly<{ rows: readonly ActionListRow[]; nowMs: number }>) {
  if (rows.length === 0) return <EmptyNote>기록된 조치가 없습니다. 아래에서 직접 등록하거나 CSV로 가져오세요.</EmptyNote>;
  return (
    <TableScroll label="조치 목록 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>수행일시 (KST)</th>
            <th scope="col" className={TH_CLASS}>설비</th>
            <th scope="col" className={TH_CLASS}>조치 유형</th>
            <th scope="col" className={TH_CLASS}>연결 발견사항</th>
            <th scope="col" className={TH_CLASS}>검증 상태</th>
            <th scope="col" className={TH_CLASS}>출처</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(row.performedAtMs)}</td>
              <td className={TD_CLASS}>
                <span className="block font-mono text-xs text-ink">{row.assetPath}</span>
                <span className="block text-xs text-muted">{row.siteCode}</span>
              </td>
              <td className={TD_CLASS}>
                <Link href={`/actions/${row.id}`} className="font-medium text-ink underline">
                  {row.actionType}
                </Link>
                {row.performedBy && <span className="block text-xs text-muted">{row.performedBy}</span>}
              </td>
              <td className={TD_CLASS}>
                {row.finding ? (
                  <Link href={`/desk/${row.finding.id}`} className="text-sm text-ink underline">
                    #{row.finding.id} {row.finding.title}
                    <span className="block text-xs text-muted no-underline">{isFindingStatus(row.finding.status) ? statusLabel(row.finding.status) : row.finding.status}</span>
                  </Link>
                ) : (
                  <span className="text-xs text-muted">없음</span>
                )}
              </td>
              <td className={TD_CLASS}>
                <VerificationBadge progress={progressOf(row, nowMs)} />
              </td>
              <td className={`${TD_CLASS} text-xs text-ink-2`}>{SOURCE_LABELS[row.source] ?? row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 검증 대기 큐: 기대 효과가 있고 아직 판정 전인 조치. 창이 채워진 조치는 "검증만 실행" */
export function VerificationQueue({ rows, nowMs }: Readonly<{ rows: readonly ActionListRow[]; nowMs: number }>) {
  const queue = rows.map((row) => ({ row, progress: progressOf(row, nowMs) })).filter(({ progress }) => progress.state === 'stabilizing' || progress.state === 'collecting' || progress.state === 'ready');
  if (queue.length === 0) return <EmptyNote>검증을 기다리는 조치가 없습니다</EmptyNote>;
  return (
    <ul className="flex flex-col divide-y divide-rule">
      {queue.map(({ row, progress }) => (
        <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link href={`/actions/${row.id}`} className="font-medium text-ink underline">
              {row.actionType}
            </Link>
            <span className="font-mono text-xs text-muted">
              {row.assetPath} · 수행 {formatKstDateTime(row.performedAtMs)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ProgressBar fraction={progress.fraction} label={progress.label} />
            <span className="text-sm text-ink-2">{progress.label}</span>
            {progress.state === 'ready' && <VerifyOnlyButton actionId={row.id} compact />}
          </div>
        </li>
      ))}
    </ul>
  );
}
