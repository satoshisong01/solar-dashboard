import { CircleCheck, CircleHelp, CircleMinus, CircleX, type LucideIcon } from 'lucide-react';
import type { Playbook } from '@/lib/analytics/playbooks';
import type { CheckStatus } from '@/lib/analytics/detectors/types';
import { EmptyNote, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { CheckView, MeasuredValue } from '@/lib/desk/evidence-types';
import { CHECK_STATUS_LABELS } from '@/lib/desk/labels';
import { formatNumber } from '@/lib/format';

const STATUS_META: Readonly<Record<CheckStatus, { icon: LucideIcon; className: string }>> = {
  supports: { icon: CircleCheck, className: 'border-warn/40 bg-warn-fill text-warn' },
  refutes: { icon: CircleX, className: 'border-ok/40 bg-ok-fill text-ok' },
  unknown: { icon: CircleHelp, className: 'border-rule-strong bg-sunken text-ink-2' },
  no_data: { icon: CircleMinus, className: 'border-rule bg-surface text-muted' },
};

const measuredText = (value: MeasuredValue): string => (typeof value === 'number' ? formatNumber(value, 3) : value === null ? '—' : String(value));

function CheckStatusChip({ status }: Readonly<{ status: CheckStatus }>) {
  const { icon: Icon, className } = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}>
      <Icon aria-hidden="true" className="size-3.5" />
      {CHECK_STATUS_LABELS[status]}
    </span>
  );
}

/** 원인 후보 판별 체크 표: 지지/반박/불명/데이터없음 + 측정값 + 설명 */
export function ChecksTable({ checks }: Readonly<{ checks: readonly CheckView[] }>) {
  if (checks.length === 0) return <EmptyNote>이 탐지기는 원인 판별 체크를 내지 않습니다. 아래 플레이북 점검 항목으로 확인하세요.</EmptyNote>;
  return (
    <TableScroll label="원인 후보 판별 체크 표">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>원인 후보</th>
            <th scope="col" className={TH_CLASS}>판별</th>
            <th scope="col" className={TH_CLASS}>측정값</th>
            <th scope="col" className={TH_CLASS}>설명</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id}>
              <td className={`${TD_CLASS} min-w-40 font-medium text-ink`}>{check.label}</td>
              <td className={TD_CLASS}>
                <CheckStatusChip status={check.status} />
              </td>
              <td className={`${TD_CLASS} min-w-48`}>
                {check.measured.length === 0 ? (
                  <span className="text-muted">—</span>
                ) : (
                  <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs">
                    {check.measured.map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-ink-2">{label}</dt>
                        <dd className="text-right font-mono text-ink tabular-nums">{measuredText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </td>
              <td className={`${TD_CLASS} min-w-56 text-sm text-ink-2`}>{check.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function BulletList({ title, items }: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** 플레이북: 원인 후보와 확인 방법 · 점검 항목 · 기각 전 오탐 함정 */
export function PlaybookDetails({ playbook }: Readonly<{ playbook: Playbook }>) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium text-ink">원인 후보와 확인 방법</h3>
        <ul className="flex flex-col gap-1.5 text-sm">
          {playbook.causes.map((cause) => (
            <li key={cause.id} className="flex flex-col">
              <span className="text-ink">{cause.label}</span>
              <span className="text-xs text-ink-2">{cause.check}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-4">
        <BulletList title="점검 항목" items={playbook.inspections} />
        <BulletList title="기각 전에 확인할 오탐 함정" items={playbook.falsePositiveTraps} />
        <p className="text-xs text-muted">출처: {playbook.sources.join(', ')}</p>
      </div>
    </div>
  );
}
