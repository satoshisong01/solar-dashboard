// 안전 이벤트 확인(ack). 자동 해제는 없고, 사람이 메모와 함께 확인해야만 미확인 목록에서 빠진다 (설계 §3 안전 레인).
// 'server-only'를 넣지 않는다: integration 테스트에서도 쓴다. 호출 전 권한 확인은 Server Action이 한다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';

export interface AckSafetyEventInput {
  /** om.event_log.id (bigint 문자열) */
  readonly eventId: string;
  readonly note: string;
  /** 확인한 관리자 이메일 */
  readonly actor: string;
  readonly now?: Date;
}

export type AckSafetyEventResult = 'acked' | 'already_acked' | 'not_found';

/** 미확인 안전 이벤트만 확인 처리한다. 이미 확인됐거나 안전 이벤트가 아니면 바꾸지 않는다 */
export async function ackSafetyEvent(db: Kysely<DB>, input: AckSafetyEventInput): Promise<AckSafetyEventResult> {
  const updated = await db
    .updateTable('om.event_log')
    .set({ acked_by: input.actor, acked_at: input.now ?? new Date(), ack_note: input.note })
    .where('id', '=', input.eventId)
    .where('is_safety', '=', true)
    .where('acked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (updated) return 'acked';

  const existing = await db
    .selectFrom('om.event_log')
    .select('acked_at')
    .where('id', '=', input.eventId)
    .where('is_safety', '=', true)
    .executeTakeFirst();
  return existing ? 'already_acked' : 'not_found';
}
