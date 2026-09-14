'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { db } from '@/lib/db/kysely';
import { errorState, formValues, INVALID_FORM_MESSAGE, successState, type ActionState } from '@/lib/forms/action-state';
import { parseMarketManualForm } from '@/lib/forms/settings';
import { MARKET_CSV_MAX_CHARS, parseMarketCsv } from '@/lib/market/market-csv';
import { upsertMarketRows } from '@/lib/ops/market';

export type MarketSaveData = Readonly<{ inserted: number; updated: number }>;

const savedMessage = (data: MarketSaveData) => `저장했습니다. 새로 ${data.inserted}건, 덮어씀 ${data.updated}건`;

/** 수기 입력 (날짜 하나 × 항목별 값). 오늘 화면의 수익 요약 위젯이 바로 반영하도록 콘솔 전체를 다시 그린다 */
export async function saveMarketManualAction(prev: ActionState<MarketSaveData>, formData: FormData): Promise<ActionState<MarketSaveData>> {
  const session = await requireAdmin();
  const values = formValues(formData);
  const parsed = parseMarketManualForm(values);
  if (!parsed.ok) return errorState(prev, INVALID_FORM_MESSAGE, { values, fieldErrors: parsed.fieldErrors });

  const data = await upsertMarketRows(db, parsed.input, { source: 'manual', actor: session.user.email });
  revalidatePath('/', 'layout');
  return successState(prev, savedMessage(data), data);
}

/** CSV 적용. 미리보기 결과를 믿지 않고 서버에서 같은 규칙으로 다시 검증하며, 오류가 한 행이라도 있으면 아무것도 저장하지 않는다 */
export async function applyMarketCsvAction(prev: ActionState<MarketSaveData>, formData: FormData): Promise<ActionState<MarketSaveData>> {
  const session = await requireAdmin();
  const csv = formData.get('csv');
  if (typeof csv !== 'string' || csv.length === 0) return errorState(prev, 'CSV 내용이 없습니다. 파일을 다시 고르세요.');
  if (csv.length > MARKET_CSV_MAX_CHARS) return errorState(prev, '파일이 너무 큽니다.');

  const result = parseMarketCsv(csv);
  if (result.errorCount > 0) {
    const first = result.errors[0];
    return errorState(prev, `검증 오류 ${result.errorCount}건이 있어 적용하지 않았습니다.${first ? ` 첫 오류: ${first.line}행 ${first.message}` : ''}`);
  }

  const data = await upsertMarketRows(db, result.rows, { source: 'csv', actor: session.user.email });
  revalidatePath('/', 'layout');
  return successState(prev, savedMessage(data), data);
}
