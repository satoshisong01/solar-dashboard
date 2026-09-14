'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseMetricDefForm } from '@/lib/forms/metric-def';
import { createMetricDef, updateMetricDef, type SaveMetricDefResult } from '@/lib/ops/catalog';

const SAVE_ERRORS: Readonly<Record<Exclude<SaveMetricDefResult, 'saved'>, string>> = {
  duplicate_key: '같은 키의 메트릭이 이미 있습니다.',
  not_found: '메트릭을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도하세요.',
  invalid: 'DB 규칙에 맞지 않는 값입니다 (범위 하한·상한 등).',
};

/** 메트릭 추가 = INSERT (스키마 변경 없음). 저장하면 카탈로그 목록에서 새 메트릭을 보여 준다 */
export async function createMetricDefAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const values = formValues(formData);
  const parsed = parseMetricDefForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await createMetricDef(db, parsed.input);
  if (result !== 'saved') {
    const fieldErrors: Readonly<Record<string, string>> = result === 'duplicate_key' ? { key: SAVE_ERRORS.duplicate_key } : {};
    return errorState(prev, SAVE_ERRORS[result], { values, fieldErrors });
  }

  revalidatePath('/', 'layout');
  redirect(`/settings/catalog?${new URLSearchParams({ q: parsed.input.key, saved: parsed.input.key }).toString()}`);
}

/** 키는 바꾸지 않는다 (포인트가 참조). 이름·단위·범위·롤업 등을 고친다 */
export async function updateMetricDefAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const values = formValues(formData);
  const parsed = parseMetricDefForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await updateMetricDef(db, parsed.input);
  if (result !== 'saved') return errorState(prev, SAVE_ERRORS[result], { values });

  revalidatePath('/', 'layout');
  return successState(prev, '저장했습니다.', null);
}
