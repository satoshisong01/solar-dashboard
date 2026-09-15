'use client';

import { useActionState } from 'react';
import { toggleDetectorConfigAction } from '@/app/(console)/settings/detectors/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { EmptyNote, TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { ScopeHistory, VersionView } from '@/lib/detector-config/history';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime } from '@/lib/format';

const CHANGE_LABELS = { added: '추가', removed: '삭제(물려받음)', changed: '변경' } as const;

function ToggleForm({ detectorId, scope, version, active }: Readonly<{ detectorId: string; scope: string; version: number; active: boolean }>) {
  const [state, action] = useActionState<ActionState, FormData>(toggleDetectorConfigAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="detectorId" value={detectorId} />
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="active" value={active ? 'false' : 'true'} />
      <SubmitButton variant={active ? 'danger' : 'secondary'} pendingText="바꾸는 중…">
        {active ? '비활성으로' : '활성으로'}
      </SubmitButton>
      <div className="max-w-72">
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

function Changes({ version }: Readonly<{ version: VersionView }>) {
  if (version.changes.length === 0 && !version.windowChanged) return <span className="text-xs text-muted">앞 버전과 같음</span>;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {version.changes.map((c) => (
        <li key={c.key}>
          <span className="text-muted">{CHANGE_LABELS[c.change]}</span> {c.label} <span className="font-mono text-muted">({c.key})</span>{' '}
          <span className="font-mono">
            {c.before ?? '—'} → {c.after ?? '—'}
          </span>
        </li>
      ))}
      {version.windowChanged && <li className="text-muted">기준 창 변경</li>}
    </ul>
  );
}

type Props = Readonly<{ detectorId: string; history: readonly ScopeHistory[]; scopeNames: Readonly<Record<string, string>> }>;

/** 범위별 활성 버전과 이력. 활성 전환은 같은 범위의 다른 활성 버전을 끈다 */
export function DetectorConfigHistory({ detectorId, history, scopeNames }: Props) {
  if (history.length === 0) return <EmptyNote>저장된 설정이 없습니다. 분석은 코드 기본값으로 실행됩니다.</EmptyNote>;
  return (
    <div className="flex flex-col gap-5">
      {history.map((h) => (
        <section key={h.scope} aria-label={`${scopeNames[h.scope] ?? h.scope} 설정 이력`} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">
            {scopeNames[h.scope] ?? h.scope} <span className="font-mono text-xs font-normal text-muted">{h.scope}</span>
            <span className="ml-2 text-xs font-normal text-ink-2">{h.active ? `활성 버전 ${h.active.version}` : '활성 버전 없음 (물려받음)'}</span>
          </h3>
          <TableScroll label={`${h.scope} 버전 이력 표`}>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>버전</th>
                  <th scope="col" className={TH_CLASS}>상태</th>
                  <th scope="col" className={TH_CLASS}>작성자 · 작성일</th>
                  <th scope="col" className={TH_CLASS}>params 차이 (앞 버전 대비)</th>
                  <th scope="col" className={TH_CLASS}>기준 창</th>
                  <th scope="col" className={TH_CLASS}>전환</th>
                </tr>
              </thead>
              <tbody>
                {h.versions.map((v) => (
                  <tr key={v.version}>
                    <td className={`${TD_CLASS} font-mono`}>{v.version}</td>
                    <td className={TD_CLASS}>
                      {v.active ? <span className="rounded-full border border-ok/40 bg-ok-fill px-2 py-0.5 text-xs font-medium text-ok">활성</span> : <span className="text-xs text-muted">비활성</span>}
                    </td>
                    <td className={`${TD_CLASS} text-xs text-ink-2`}>
                      {v.createdBy}
                      <span className="block font-mono text-muted">{formatKstDateTime(v.createdAtMs)}</span>
                    </td>
                    <td className={TD_CLASS}>
                      <Changes version={v} />
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{v.referenceWindow ? `${v.referenceWindow.startDay} ~ ${v.referenceWindow.endDay}` : '—'}</td>
                    <td className={TD_CLASS}>
                      <ToggleForm detectorId={detectorId} scope={v.scope} version={v.version} active={v.active} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>
      ))}
    </div>
  );
}
