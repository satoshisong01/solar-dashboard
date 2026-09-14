'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseMappingForm } from '@/lib/forms/mapping';
import { parseGatewayIdForm } from '@/lib/forms/settings';
import { createPointFromInbox, replayMappedTags, type CreatePointResult } from '@/lib/ops/mapping';

export interface MappedPointLink {
  readonly sourceKey: string;
  readonly siteCode: string;
  readonly assetId: number;
  readonly assetCode: string;
  readonly pointId: number;
  readonly metricName: string;
}

export type CreatePointData = Readonly<{ pointId: number; assetId: number; siteCode: string }>;

const CREATE_ERRORS: Readonly<Record<Exclude<CreatePointResult['kind'], 'created'>, string>> = {
  inbox_missing: '인박스에 없는 태그입니다. 목록을 새로 고친 뒤 다시 시도하세요.',
  already_mapped: '이미 매핑된 태그입니다.',
  asset_not_in_site: '이 게이트웨이 사이트의 설비만 고를 수 있습니다.',
  metric_missing: '없는 메트릭입니다. 설정 › 카탈로그에서 먼저 추가하세요.',
  duplicate_point: '이 설비에 같은 메트릭·구분자 포인트가 이미 있습니다. 구분자를 다르게 입력하세요.',
};

/** 미매핑 태그를 포인트로 매핑한다. 과거 값은 이어서 재처리해야 채워진다 */
export async function createPointMappingAction(prev: ActionState<CreatePointData>, formData: FormData): Promise<ActionState<CreatePointData>> {
  await requireAdmin();
  const values = formValues(formData);
  const parsed = parseMappingForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await createPointFromInbox(db, parsed.input);
  if (result.kind !== 'created') return errorState(prev, CREATE_ERRORS[result.kind], { values });

  revalidatePath('/', 'layout');
  return successState(prev, '포인트를 만들었습니다. 재처리를 실행하면 보존된 원본에서 과거 값이 채워집니다.', {
    pointId: result.pointId,
    assetId: result.assetId,
    siteCode: result.siteCode,
  });
}

export interface ReplayData {
  readonly batches: number;
  readonly failedBatches: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly missing: number;
  readonly rollupHours: number;
  readonly clearedInbox: number;
  readonly points: readonly MappedPointLink[];
}

async function loadPointLinks(gatewayId: number, sourceKeys: readonly string[]): Promise<readonly MappedPointLink[]> {
  const rows = await db
    .selectFrom('om.point as p')
    .innerJoin('om.asset as a', 'a.id', 'p.asset_id')
    .innerJoin('om.site as s', 's.id', 'a.site_id')
    .innerJoin('om.metric_def as m', 'm.key', 'p.metric_key')
    .select(['p.source_key', 's.code as site_code', 'a.id as asset_id', 'a.code as asset_code', 'p.id as point_id', 'm.name_ko'])
    .where('p.gateway_id', '=', gatewayId)
    .where('p.source_key', 'in', [...sourceKeys])
    .orderBy('p.source_key')
    .execute();
  return rows.map((row) => ({
    sourceKey: row.source_key,
    siteCode: row.site_code,
    assetId: row.asset_id,
    assetCode: row.asset_code,
    pointId: row.point_id,
    metricName: row.name_ko,
  }));
}

/** 게이트웨이의 "매핑됐지만 인박스에 남은" 태그를 원본 배치에서 다시 적재한다. 게이트웨이 배치 수에 따라 수십 초 걸릴 수 있다 */
export async function replayMappedTagsAction(prev: ActionState<ReplayData>, formData: FormData): Promise<ActionState<ReplayData>> {
  await requireAdmin();
  const parsed = parseGatewayIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, '게이트웨이가 올바르지 않습니다.');
  const { gatewayId } = parsed.input;

  try {
    const result = await replayMappedTags(db, gatewayId);
    if (result.kind === 'nothing') return errorState(prev, '재처리할 매핑 태그가 없습니다. 이미 재처리했을 수 있습니다.');

    revalidatePath('/', 'layout');
    const { replay } = result;
    return successState(prev, `재처리를 마쳤습니다. 새로 적재된 행 ${replay.accepted.toLocaleString('ko-KR')}개`, {
      batches: replay.batches,
      failedBatches: replay.failed,
      accepted: replay.accepted,
      duplicate: replay.duplicate,
      rejected: replay.rejected,
      missing: replay.missing,
      rollupHours: replay.rollup.upserted,
      clearedInbox: result.clearedInbox,
      points: await loadPointLinks(gatewayId, result.sourceKeys),
    });
  } catch (error) {
    console.error('[data/replay] 재처리 실패:', error);
    return errorState(prev, '재처리 중 오류가 났습니다. 이미 들어간 행은 그대로이며, 다시 실행해도 중복되지 않습니다.');
  }
}
