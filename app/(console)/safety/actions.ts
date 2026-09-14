'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseAckForm } from '@/lib/forms/settings';
import { ackSafetyEvent } from '@/lib/ops/safety';

/** 안전 이벤트 확인(ack). 메모 필수, 확인자는 세션 이메일. 미확인 수는 여러 화면(오늘·플릿·사이트)에 보이므로 콘솔 전체를 다시 그린다 */
export async function ackSafetyEventAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseAckForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await ackSafetyEvent(db, { eventId: parsed.input.eventId, note: parsed.input.note, actor: session.user.email });
  if (result === 'not_found') return errorState(prev, '안전 이벤트를 찾을 수 없습니다.', { values });

  revalidatePath('/', 'layout');
  if (result === 'already_acked') return errorState(prev, '이미 다른 관리자가 확인한 이벤트입니다.', { values });
  return successState(prev, '확인했습니다. 확인 이력으로 옮겼습니다.', null);
}
