import { after } from 'next/server';
import { db } from '@/lib/db/kysely';
import { getPool, isPoolSaturated } from '@/lib/db/pool';
import { getServerEnv } from '@/lib/env';
import { handleIngestRequest } from '@/lib/ingest/handler';
import { decodeEncryptionKey } from '@/lib/ingest/key-crypto';

// 기계용 수집 엔드포인트: 세션(requireAdmin)이 아니라 게이트웨이 HMAC으로만 인증한다. proxy.ts matcher에서도 제외돼 있다.
export const runtime = 'nodejs';

let encryptionKey: Uint8Array | undefined;

// 요청이 올 때 환경변수를 읽는다 (빌드 시 환경변수 불필요).
function getEncryptionKey(): Uint8Array {
  encryptionKey ??= decodeEncryptionKey(getServerEnv().INGEST_KEY_ENC_KEY);
  return encryptionKey;
}

export async function POST(request: Request): Promise<Response> {
  return handleIngestRequest(request, {
    db,
    encryptionKey: getEncryptionKey,
    nowMs: Date.now,
    isDbSaturated: () => isPoolSaturated(getPool()),
    // 응답을 보낸 뒤 이 배치 포인트의 dirty 시간 버킷을 m_1h로 롤업한다 (설계 §0: 크론 없음).
    schedule: (task) => after(task),
  });
}
