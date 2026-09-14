import { EmptyNote, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { RunHistoryRow } from '@/lib/data/analysis-runs';
import { formatElapsedMs, runStatusLabel } from '@/lib/desk/run-summary';
import { formatKstDate, formatKstDateTime } from '@/lib/format';

const STATUS_TONE: Readonly<Record<string, string>> = {
  succeeded: 'text-ok',
  partial: 'text-warn',
  failed: 'text-crit',
  running: 'text-ink-2',
};

const periodText = (run: RunHistoryRow): string => (run.fromMs === null || run.toMs === null ? '—' : `${formatKstDate(run.fromMs)} ~ ${formatKstDate(run.toMs)} (${Math.round((run.toMs - run.fromMs) / 86_400_000)}일)`);

const elapsedText = (run: RunHistoryRow): string => (run.finishedMs === null ? '실행 중' : formatElapsedMs(run.finishedMs - run.startedMs));

/** 최근 분석 실행 (om.analysis_run) */
export function RunHistory({ runs }: Readonly<{ runs: readonly RunHistoryRow[] }>) {
  if (runs.length === 0) return <EmptyNote>아직 실행한 분석이 없습니다</EmptyNote>;
  return (
    <TableScroll label="최근 분석 실행 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>실행</th>
            <th scope="col" className={TH_CLASS}>시작 (KST)</th>
            <th scope="col" className={TH_CLASS}>범위</th>
            <th scope="col" className={TH_CLASS}>상태</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>새 발견</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>갱신</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>판정 불가</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>소요</th>
            <th scope="col" className={TH_CLASS}>요청자</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className={`${TD_CLASS} font-mono`}>#{run.id}</td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{formatKstDateTime(run.startedMs)}</td>
              <td className={TD_CLASS}>
                <span className="block font-medium text-ink">
                  {run.siteCodes.join(', ')}
                  {run.assetCount !== null && <span className="font-normal text-muted"> · 설비 {run.assetCount}개</span>}
                  {run.verifyOnly && <span className="font-normal text-muted"> · 조치 효과 검증만</span>}
                </span>
                <span className="block text-xs text-muted">{periodText(run)}</span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                <span className={`font-medium ${STATUS_TONE[run.status] ?? 'text-ink-2'}`}>{runStatusLabel(run.status)}</span>
                {(run.error || run.summary.runErrors > 0) && (
                  <span className="block max-w-64 truncate text-xs text-crit" title={run.error ?? undefined}>
                    {run.error ?? `오류 ${run.summary.runErrors}건`}
                  </span>
                )}
              </td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{run.summary.created}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{run.summary.updated}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS}`}>{run.summary.insufficient}</td>
              <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap`}>{elapsedText(run)}</td>
              <td className={`${TD_CLASS} font-mono text-xs text-ink-2`}>{run.requestedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
