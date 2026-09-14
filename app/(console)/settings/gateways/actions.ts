'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { getServerEnv } from '@/lib/env';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseGatewayForm, parseGatewayIdForm, parseKeyIdForm } from '@/lib/forms/settings';
import { decodeEncryptionKey } from '@/lib/ingest/key-crypto';
import { revokeGatewayKey } from '@/lib/ingest/keys';
import { createGateway, issueKeyForGateway, MAX_ACTIVE_GATEWAY_KEYS } from '@/lib/ops/gateways';

export async function createGatewayAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const values = formValues(formData);
  const parsed = parseGatewayForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const result = await createGateway(db, parsed.input);
  if (result.kind === 'site_missing') return errorState(prev, '사이트를 찾을 수 없습니다.', { values, fieldErrors: { siteId: '사이트를 다시 고르세요' } });
  if (result.kind === 'duplicate_code') return errorState(prev, '같은 코드의 게이트웨이가 이미 있습니다.', { values, fieldErrors: { code: '다른 코드를 입력하세요' } });

  revalidatePath('/', 'layout');
  return successState(prev, `게이트웨이 ${parsed.input.code}를 만들었습니다. 키를 발급해야 수집할 수 있습니다.`, null);
}

export type IssuedKeyData = Readonly<{ gatewayCode: string; keyId: string; secret: string }>;

/** 비밀값은 이 응답으로 한 번만 돌려준다. DB에는 INGEST_KEY_ENC_KEY로 암호화한 값만 남는다 */
export async function issueGatewayKeyAction(prev: ActionState<IssuedKeyData>, formData: FormData): Promise<ActionState<IssuedKeyData>> {
  await requireAdmin();
  const parsed = parseGatewayIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, '게이트웨이가 올바르지 않습니다.');

  const encryptionKey = decodeEncryptionKey(getServerEnv().INGEST_KEY_ENC_KEY);
  const result = await issueKeyForGateway(db, parsed.input.gatewayId, encryptionKey);
  if (result.kind !== 'issued') {
    return errorState(prev, result.kind === 'gateway_missing' ? '게이트웨이를 찾을 수 없습니다.' : `활성 키는 최대 ${MAX_ACTIVE_GATEWAY_KEYS}개입니다. 기존 키를 먼저 폐기하세요.`);
  }

  revalidatePath('/settings/gateways');
  revalidatePath('/data');
  return successState(prev, `${result.gatewayCode}에 새 키를 발급했습니다.`, {
    gatewayCode: result.gatewayCode,
    keyId: result.key.keyId,
    secret: result.key.secret,
  });
}

export async function revokeGatewayKeyAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseKeyIdForm(formValues(formData));
  if (!parsed.ok) return errorState(prev, '키 ID가 올바르지 않습니다.');

  const revoked = await revokeGatewayKey(db, parsed.input.keyId);
  if (!revoked) return errorState(prev, '이미 폐기됐거나 없는 키입니다.');

  revalidatePath('/settings/gateways');
  revalidatePath('/data');
  return successState(prev, `키 ${parsed.input.keyId}를 폐기했습니다. 이 키로 서명한 수집 요청은 이제 401입니다.`, null);
}
