'use server';

import { revalidatePath } from 'next/cache';
import { DETECTORS } from '@/lib/analytics/detectors';
import { targetingOf } from '@/lib/analytics/pipeline/targets';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { paramFields } from '@/lib/detector-config/fields';
import { parseDetectorConfigForm } from '@/lib/detector-config/form';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { assetHasClass, createDetectorConfigVersion, setDetectorConfigActive } from '@/lib/ops/detector-config';

export type ConfigSaveData = Readonly<{ scope: string; version: number }>;

const APPLY_NOTE = '변경은 다음 분석 실행부터 적용되며 기존 발견사항은 바뀌지 않습니다.';
const SCOPE_PATTERN = /^(default|class:[a-z][a-z0-9]*(\.[a-z0-9_]+)*|asset:[1-9][0-9]{0,9})$/;

const detectorOf = (id: unknown) => (typeof id === 'string' ? (DETECTORS.find((d) => d.id === id) ?? null) : null);

/** 새 설정 버전: 서버에서 paramSchema로 다시 검증 → 새 version INSERT + 같은 (탐지기, 범위) 이전 활성 비활성화 (한 트랜잭션) */
export async function createDetectorConfigAction(prev: ActionState<ConfigSaveData>, formData: FormData): Promise<ActionState<ConfigSaveData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const detector = detectorOf(values.detectorId);
  const targeting = detector ? targetingOf(detector.id) : null;
  if (!detector || !targeting) return errorState(prev, '탐지기를 찾을 수 없습니다. 목록에서 다시 고르세요.');

  const parsed = parseDetectorConfigForm({ values, fields: paramFields(detector.paramSchema), schema: detector.paramSchema, defaultParams: detector.defaultParams, targeting });
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });
  const { input } = parsed;
  if (input.assetId !== null && (targeting.configClass === null || !(await assetHasClass(db, input.assetId, targeting.configClass)))) {
    return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: { assetId: `설비 종류가 ${targeting.configClass ?? '—'}인 설비를 고르세요` } });
  }

  const version = await createDetectorConfigVersion(db, { detectorId: detector.id, scope: input.scope, params: input.params, referenceWindow: input.referenceWindow, actor: session.user.email });
  revalidatePath('/settings/detectors', 'layout');
  return successState(prev, `${input.scope} 버전 ${version}을 저장하고 활성으로 바꿨습니다. ${APPLY_NOTE}`, { scope: input.scope, version });
}

/** 버전 활성·비활성 전환. 활성으로 켜면 같은 범위의 다른 활성 버전을 끈다 */
export async function toggleDetectorConfigAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const values = formValues(formData);
  const detector = detectorOf(values.detectorId);
  const scope = values.scope ?? '';
  const version = Number(values.version);
  const active = values.active === 'true' ? true : values.active === 'false' ? false : null;
  if (!detector || !SCOPE_PATTERN.test(scope) || !Number.isInteger(version) || version < 1 || active === null) return errorState(prev, '요청 값이 올바르지 않습니다. 화면을 새로 고친 뒤 다시 시도하세요.');

  const result = await setDetectorConfigActive(db, { detectorId: detector.id, scope, version, active });
  if (result === 'not_found') return errorState(prev, '설정 버전을 찾을 수 없습니다. 화면을 새로 고치세요.');
  revalidatePath('/settings/detectors', 'layout');
  return successState(prev, `${scope} 버전 ${version}을 ${active ? '활성으로 바꿨습니다' : '비활성으로 바꿨습니다'}. ${APPLY_NOTE}`, null);
}
