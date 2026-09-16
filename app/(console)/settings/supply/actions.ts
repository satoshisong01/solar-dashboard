'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { requestTimeMs } from '@/lib/data/time';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseDeliveryForm } from '@/lib/forms/h2-delivery';
import { DELIVERY_CSV_MAX_CHARS, type DeliveryCsvResult } from '@/lib/h2delivery/delivery-csv';
import { checkDeliveryCsvText, deliveryRowToInput, insertDeliveries } from '@/lib/ops/h2-delivery';

export type DeliverySaveData = Readonly<{ inserted: number; duplicates: number }>;
export type DeliveryPreviewData = Readonly<{ result: DeliveryCsvResult }>;

const savedMessage = (data: DeliverySaveData) => `반입 기록 ${data.inserted}건을 저장했습니다.${data.duplicates > 0 ? ` 이미 등록되어 건너뛴 건 ${data.duplicates}건.` : ''}`;

/** 직접 입력 한 건. 저장하면 다음 분석 실행에서 원장 delivered 항에 들어간다 */
export async function recordDeliveryAction(prev: ActionState<DeliverySaveData>, formData: FormData): Promise<ActionState<DeliverySaveData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseDeliveryForm(values, { nowMs: requestTimeMs() });
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const data = await insertDeliveries(db, [{ ...parsed.input, assetId: null }], { source: 'manual', actor: session.user.email });
  if (data.inserted === 0) return errorState(prev, '같은 사이트·일시·공급사·차량번호의 반입 기록이 이미 있습니다.', { values });
  revalidatePath('/settings/supply');
  return successState(prev, savedMessage(data), data);
}

/** CSV 적용. 미리보기 결과를 믿지 않고 서버에서 같은 규칙으로 다시 검증하며, 오류가 한 행이라도 있으면 아무것도 저장하지 않는다 */
export async function applyDeliveryCsvAction(prev: ActionState<DeliverySaveData>, formData: FormData): Promise<ActionState<DeliverySaveData>> {
  const session = await requireAdmin();
  const csv = formData.get('csv');
  if (typeof csv !== 'string' || csv.length === 0) return errorState(prev, 'CSV 내용이 없습니다. 파일을 다시 고르세요.');
  if (csv.length > DELIVERY_CSV_MAX_CHARS) return errorState(prev, '파일이 너무 큽니다.');

  const result = await checkDeliveryCsvText(db, csv, requestTimeMs());
  if (result.errorCount > 0) {
    const first = result.errors[0];
    return errorState(prev, `검증 오류 ${result.errorCount}건이 있어 적용하지 않았습니다.${first ? ` 첫 오류: ${first.line}행 ${first.message}` : ''}`);
  }

  const data = await insertDeliveries(db, result.rows.map(deliveryRowToInput), { source: 'csv', actor: session.user.email });
  revalidatePath('/settings/supply');
  return successState(prev, savedMessage(data), data);
}

/** CSV 미리보기: 사이트 코드와 이미 등록된 건을 서버에서 대조해 행별 오류를 돌려준다 (적용은 다시 검증한다) */
export async function previewDeliveryCsvAction(prev: ActionState<DeliveryPreviewData>, formData: FormData): Promise<ActionState<DeliveryPreviewData>> {
  await requireAdmin();
  const csv = formData.get('csv');
  if (typeof csv !== 'string' || csv.length === 0 || csv.length > DELIVERY_CSV_MAX_CHARS) {
    return errorState(prev, `CSV 내용이 없거나 너무 큽니다 (최대 ${DELIVERY_CSV_MAX_CHARS.toLocaleString('ko-KR')}자).`);
  }
  const result = await checkDeliveryCsvText(db, csv, requestTimeMs());
  return successState(prev, result.errorCount > 0 ? `검증 오류 ${result.errorCount}건이 있습니다. 고친 뒤 파일을 다시 고르세요.` : `${result.rows.length}행을 가져올 수 있습니다.`, { result });
}
