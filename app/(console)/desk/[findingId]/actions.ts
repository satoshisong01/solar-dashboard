'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/dal';
import { explanationForFinding } from '@/lib/data/finding-explanation';
import { getFindingDetail } from '@/lib/data/finding-workspace';
import { errorState, successState, type ActionState } from '@/lib/forms/action-state';
import { takeSlot } from '@/lib/forms/throttle';
import { REGENERATE_MIN_INTERVAL_MS } from '@/lib/llm/retry';

const BIGINT_ID = /^[1-9]\d{0,17}$/;

/** 쉬운 요약 다시 생성: 저장된 문장을 지우고 한 번 더 만든다 (검증에 걸리면 틀 문장으로 되돌아간다).
 *  저장된 문장을 건너뛰고 늘 모델을 부르므로 같은 사람·같은 발견사항으로는 잠깐 사이에 다시 부르지 못하게 막는다 */
export async function regenerateExplanationAction(prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user } = await requireAdmin();
  const findingId = String(formData.get('findingId') ?? '');
  if (!BIGINT_ID.test(findingId)) return errorState(prev, '발견사항을 찾을 수 없습니다. 화면을 새로 고치세요.');
  const slot = takeSlot(`explanation:${user.id}:${findingId}`, REGENERATE_MIN_INTERVAL_MS);
  if (!slot.ok) return errorState(prev, `방금 다시 만들었습니다. ${slot.retryInSec}초 뒤에 다시 시도하세요.`);

  const finding = await getFindingDetail(findingId);
  if (!finding) return errorState(prev, '발견사항을 찾을 수 없습니다. 화면을 새로 고치세요.');

  try {
    const explanation = await explanationForFinding(finding, true);
    revalidatePath(`/desk/${findingId}`);
    if (explanation.source === 'llm') return successState(prev, 'AI 설명을 다시 만들었습니다.', null);
    return errorState(prev, 'AI 설명을 쓸 수 없어 규칙 기반 요약을 그대로 둡니다. 설정에서 AI 설명이 켜져 있는지 확인하세요.');
  } catch (error) {
    console.error('[desk/explanation] 다시 생성 실패:', error);
    return errorState(prev, '설명을 다시 만들지 못했습니다. 잠시 뒤 다시 시도하세요.');
  }
}
