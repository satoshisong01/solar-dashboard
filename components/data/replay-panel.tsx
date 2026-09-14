'use client';

import { useActionState } from 'react';
import { replayMappedTagsAction, type ReplayData } from '@/app/(console)/data/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { ReplayResult } from './replay-result';

export interface PendingReplayGroup {
  readonly gatewayId: number;
  readonly gatewayCode: string;
  readonly siteCode: string;
  readonly tags: readonly Readonly<{ sourceKey: string; assetCode: string; metricKey: string; qualifier: string }>[];
}

/**
 * 매핑했지만 아직 재처리하지 않은 태그를 게이트웨이별로 보여 주고 재처리를 실행한다.
 * 재처리가 끝나면 목록이 비지만, 이 컴포넌트는 항상 같은 자리에 렌더되므로 결과는 남는다.
 */
export function ReplayPanel({ groups }: Readonly<{ groups: readonly PendingReplayGroup[] }>) {
  const [state, action] = useActionState<ActionState<ReplayData>, FormData>(replayMappedTagsAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-3">
      <ActionMessage state={state}>{state.status === 'success' && <ReplayResult data={state.data} />}</ActionMessage>
      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-4 py-4 text-center text-sm text-muted">재처리를 기다리는 태그가 없습니다</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li key={group.gatewayId} className="flex flex-col gap-2 rounded-md border border-rule p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <span className="font-medium text-ink">{group.siteCode}</span> <span className="font-mono text-ink-2">{group.gatewayCode}</span>
                  <span className="ml-2 text-xs text-muted">태그 {group.tags.length}개</span>
                </p>
                <form action={action}>
                  <input type="hidden" name="gatewayId" value={group.gatewayId} />
                  <SubmitButton pendingText="재처리 중… (배치 수에 따라 수십 초)">재처리</SubmitButton>
                </form>
              </div>
              <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
                {group.tags.map((tag) => (
                  <li key={tag.sourceKey}>
                    <span className="font-mono">{tag.sourceKey}</span> → {tag.assetCode} · <span className="font-mono">{tag.metricKey}</span>
                    {tag.qualifier && <span className="text-muted"> ({tag.qualifier})</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
