'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useActionState } from 'react';
import { createPointMappingAction, replayMappedTagsAction, type CreatePointData, type ReplayData } from '@/app/(console)/data/actions';
import { ActionMessage, SubmitButton } from '@/components/forms/controls';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDateTime, formatNumber } from '@/lib/format';
import { MappingForm, type AssetOption, type MetricOption } from './mapping-form';
import { ReplayResult } from './replay-result';

export interface MappingTagView {
  readonly gatewayId: number;
  readonly gatewayCode: string;
  readonly siteCode: string;
  readonly sourceKey: string;
  readonly unit: string | null;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  readonly sampleCount: number;
  readonly mapped: Readonly<{ pointId: number; assetId: number; assetCode: string; metricKey: string; qualifier: string }> | null;
}

type WorkspaceProps = Readonly<{ tag: MappingTagView | null; assets: readonly AssetOption[]; metrics: readonly MetricOption[] }>;

const BACK_LINK = (
  <Link href="/data/unmapped" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
    <ArrowLeft aria-hidden="true" className="size-4" />
    미매핑 태그 목록
  </Link>
);

function TagSummary({ tag }: Readonly<{ tag: MappingTagView }>) {
  const items = [
    ['원본 태그', <span key="k" className="font-mono">{tag.sourceKey}</span>],
    ['게이트웨이', `${tag.siteCode} · ${tag.gatewayCode}`],
    ['원본 단위', tag.unit || '없음'],
    ['수신', `${formatKstDateTime(tag.firstSeenMs)} ~ ${formatKstDateTime(tag.lastSeenMs)}`],
    ['보존된 샘플', `${formatNumber(tag.sampleCount, 0)}개`],
  ] as const;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 매핑 → 재처리 흐름. 재처리가 끝나면 인박스 행이 지워져 서버가 tag=null로 다시 그리지만,
 * 이 컴포넌트는 같은 자리에 남아 결과(상태)를 계속 보여 준다.
 */
export function MappingWorkspace({ tag, assets, metrics }: WorkspaceProps) {
  const [mapState, mapAction] = useActionState<ActionState<CreatePointData>, FormData>(createPointMappingAction, IDLE_STATE);
  const [replayState, replayAction] = useActionState<ActionState<ReplayData>, FormData>(replayMappedTagsAction, IDLE_STATE);

  if (tag === null) {
    return (
      <Panel title="재처리 결과" action={BACK_LINK}>
        {replayState.status === 'success' ? (
          <ActionMessage state={replayState}>
            <ReplayResult data={replayState.data} />
          </ActionMessage>
        ) : (
          <EmptyNote>인박스에 없는 태그입니다. 이미 재처리해 정리됐거나 주소가 잘못됐습니다.</EmptyNote>
        )}
      </Panel>
    );
  }

  return (
    <>
      <Panel title="수신 태그" action={BACK_LINK}>
        <TagSummary tag={tag} />
      </Panel>
      {tag.mapped === null ? (
        <Panel title="1. 포인트 매핑">
          <MappingForm gatewayId={tag.gatewayId} sourceKey={tag.sourceKey} sourceUnit={tag.unit} assets={assets} metrics={metrics} state={mapState} action={mapAction} />
        </Panel>
      ) : (
        <Panel title="2. 재처리" meta={`${tag.mapped.assetCode} · ${tag.mapped.metricKey}${tag.mapped.qualifier ? ` (${tag.mapped.qualifier})` : ''} 포인트로 매핑됨`}>
          <div className="flex flex-col gap-3">
            {mapState.status === 'success' && <ActionMessage state={mapState} />}
            <p className="text-sm text-ink-2">
              {tag.gatewayCode}에서 받은 원본 배치를 다시 읽어 매핑한 태그의 과거 값을 채웁니다. 같은 게이트웨이에 재처리를 기다리는 다른 태그가 있으면 함께 처리합니다.
            </p>
            <form action={replayAction}>
              <input type="hidden" name="gatewayId" value={tag.gatewayId} />
              <SubmitButton pendingText="재처리 중… (배치 수에 따라 수십 초)">재처리 실행</SubmitButton>
            </form>
            <ActionMessage state={replayState}>{replayState.status === 'success' && <ReplayResult data={replayState.data} />}</ActionMessage>
          </div>
        </Panel>
      )}
    </>
  );
}
