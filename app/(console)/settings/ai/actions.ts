'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { setGlobalAiSetting, setSiteAiSetting } from '@/lib/ops/ai-settings';
import { errorState, formValues, successState, type ActionState } from '@/lib/forms/action-state';

const CHOICES = ['on', 'off', 'inherit'] as const;
type Choice = (typeof CHOICES)[number];

const isChoice = (value: string): value is Choice => (CHOICES as readonly string[]).includes(value);
const APPLY_NOTE = '이미 만들어 둔 설명은 그대로 남고, 다음에 새 근거가 생기거나 다시 생성할 때부터 바뀝니다.';

/** 전역 AI 설명 사용 여부 */
export async function setGlobalAiAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const choice = formValues(formData).enabled ?? '';
  if (choice !== 'on' && choice !== 'off') return errorState(prev, '값이 올바르지 않습니다. 화면을 새로 고치세요.');

  await setGlobalAiSetting(db, { enabled: choice === 'on', actor: session.user.email });
  revalidatePath('/settings/ai');
  return successState(prev, `전역 설정을 ${choice === 'on' ? '사용' : '사용 안 함'}으로 바꿨습니다. ${APPLY_NOTE}`, null);
}

/** 사이트별 AI 설명 사용 여부. inherit이면 사이트 설정을 지워 전역을 따른다 */
export async function setSiteAiAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const siteId = Number(values.siteId);
  const choice = values.enabled ?? '';
  if (!Number.isInteger(siteId) || siteId < 1 || !isChoice(choice)) return errorState(prev, '값이 올바르지 않습니다. 화면을 새로 고치세요.');

  const site = await db.selectFrom('om.site').select(['name']).where('id', '=', siteId).executeTakeFirst();
  if (!site) return errorState(prev, '사이트를 찾을 수 없습니다. 화면을 새로 고치세요.');

  await setSiteAiSetting(db, { siteId, enabled: choice === 'inherit' ? null : choice === 'on', actor: session.user.email });
  revalidatePath('/settings/ai');
  const label = choice === 'inherit' ? '전역 따름' : choice === 'on' ? '사용' : '사용 안 함';
  return successState(prev, `${site.name}을(를) ${label}으로 바꿨습니다. ${APPLY_NOTE}`, null);
}
