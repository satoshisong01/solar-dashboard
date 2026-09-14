import { CircleCheck, RadioTower, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { EmptyNote, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import { SeverityChip } from '@/components/ui/status';
import type { SafetyEventRow } from '@/lib/data/safety';
import type { SilenceGap } from '@/lib/data/safety-silence';
import { formatAgo, formatDuration, formatKstDateTime, formatKstDateTimeSeconds } from '@/lib/format';
import { AckForm } from './ack-form';

/** 서버 수신 시각 − 이벤트 발생 시각 */
export function receiveDelayText(event: Pick<SafetyEventRow, 'tsMs' | 'receivedAtMs'>): string {
  if (event.receivedAtMs === null) return '기록 없음';
  const delayMs = event.receivedAtMs - event.tsMs;
  if (delayMs < 0) return `발생 시각이 수신보다 ${formatDuration(-delayMs)} 늦음 (시계 오차)`;
  return formatDuration(delayMs);
}

function AssetLabel({ event }: Readonly<{ event: SafetyEventRow }>) {
  if (event.assetId === null || event.assetName === null) return <span className="font-mono">{event.sourceKey}</span>;
  return (
    <Link href={`/sites/${encodeURIComponent(event.siteCode)}/assets/${event.assetId}`} className="hover:underline">
      {event.assetName}
    </Link>
  );
}

export function SafetyNotice() {
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border-2 border-warn bg-warn-fill px-4 py-3 text-sm font-medium text-ink">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warn" />
      이 콘솔은 법정 안전설비·현장 PLC 인터록을 대체하지 않습니다. 현장 경보와 인터록 동작을 먼저 확인하세요.
    </p>
  );
}

export function SilenceList({ gaps, nowMs }: Readonly<{ gaps: readonly SilenceGap[]; nowMs: number }>) {
  if (gaps.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-ok">
        <CircleCheck aria-hidden="true" className="size-4" />
        안전감시 공백이 없습니다.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {gaps.map((gap) => (
        <li key={gap.kind === 'no_gateway' ? gap.siteCode : `${gap.siteCode}/${gap.gatewayCode}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-crit/40 bg-crit-fill px-3 py-2">
          <RadioTower aria-hidden="true" className="size-4 shrink-0 text-crit" />
          <span className="font-medium text-ink">{gap.siteCode}</span>
          {gap.kind === 'no_gateway' ? (
            <span className="text-crit">활성 게이트웨이가 없어 안전 데이터를 받지 못합니다</span>
          ) : (
            <>
              <span className="font-mono text-ink-2">{gap.gatewayCode}</span>
              <span className="text-crit">
                {gap.kind === 'never_seen' ? '수신 기록 없음 — 안전 데이터 불확실' : `${formatDuration(gap.silentMs)} 무수신 — 안전 데이터 불확실`}
              </span>
              {gap.kind === 'silent' && (
                <span className="text-xs text-muted">
                  마지막 수신 {formatKstDateTime(gap.lastSeenMs)} ({formatAgo(gap.lastSeenMs, nowMs)})
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function UnackedEventList({ events }: Readonly<{ events: readonly SafetyEventRow[] }>) {
  if (events.length === 0) return <EmptyNote>미확인 안전 이벤트가 없습니다</EmptyNote>;
  return (
    <ol className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id} className="grid gap-4 rounded-lg border border-crit/40 p-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] md:p-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-xs text-muted">발생</dt>
            <dd className="font-mono text-xs text-ink">{formatKstDateTimeSeconds(event.tsMs)}</dd>
            <dt className="text-xs text-muted">코드</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={event.severity} />
              <span className="font-mono font-medium text-ink">{event.code}</span>
              {event.text && <span className="text-ink-2">{event.text}</span>}
            </dd>
            <dt className="text-xs text-muted">위치</dt>
            <dd className="text-ink-2">
              <span className="font-medium text-ink">{event.siteCode}</span> · <AssetLabel event={event} />
            </dd>
            <dt className="text-xs text-muted">수신</dt>
            <dd className="text-ink-2">
              <span className="font-mono text-xs">{event.gatewayCode}</span> · <span className="font-mono text-xs">{event.sourceKey}</span>
              <span className="block text-xs">수신 지연 {receiveDelayText(event)}</span>
            </dd>
          </dl>
          <AckForm eventId={event.id} eventLabel={`${event.siteCode} ${event.code} ${formatKstDateTime(event.tsMs)}`} />
        </li>
      ))}
    </ol>
  );
}

export function AckHistoryTable({ events }: Readonly<{ events: readonly SafetyEventRow[] }>) {
  if (events.length === 0) return <EmptyNote>확인 기록이 없습니다</EmptyNote>;
  return (
    <TableScroll label="안전 이벤트 확인 이력 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>확인 시각</th>
            <th scope="col" className={TH_CLASS}>확인자</th>
            <th scope="col" className={TH_CLASS}>메모</th>
            <th scope="col" className={TH_CLASS}>발생</th>
            <th scope="col" className={TH_CLASS}>사이트 · 설비</th>
            <th scope="col" className={TH_CLASS}>코드</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{event.ackedAtMs === null ? '—' : formatKstDateTime(event.ackedAtMs)}</td>
              <td className={`${TD_CLASS} text-ink-2`}>{event.ackedBy ?? '—'}</td>
              <td className={`${TD_CLASS} max-w-72 whitespace-pre-wrap text-ink`}>{event.ackNote ?? '—'}</td>
              <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDateTime(event.tsMs)}</td>
              <td className={`${TD_CLASS} text-ink-2`}>
                <span className="font-medium text-ink">{event.siteCode}</span> · <AssetLabel event={event} />
              </td>
              <td className={TD_CLASS}>
                <span className="flex items-center gap-2">
                  <SeverityChip severity={event.severity} />
                  <span className="font-mono">{event.code}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
