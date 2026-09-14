// 검증을 통과한 봉투 하나를 매핑 조회 → 정규화 → 파티션 준비 → 저장까지 처리한다.
// 'server-only'를 넣지 않는다: 테스트와 스크립트에서도 쓴다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { IngestEnvelope } from './envelope';
import { normalizeEvents, normalizeSamples } from './normalize';
import { ensurePartitionsFor, loadEventContext, loadPointMappings, storeBatch, type StoreBatchResult } from './store';
import { sha256 } from './body';

export interface IngestEnvelopeInput {
  readonly gatewayId: number;
  readonly siteId: number;
  readonly envelope: IngestEnvelope;
  /** 받은 gzip 본문 그대로 (bronze 보존·재처리 원천) */
  readonly bodyGzip: Uint8Array;
  /** 압축을 푼 JSON 바이트 (같은 batch_id 재전송 판별용 해시) */
  readonly bodyJson: Uint8Array;
  readonly receivedAtMs: number;
}

export async function ingestEnvelope(db: Kysely<DB>, input: IngestEnvelopeInput): Promise<StoreBatchResult> {
  const { envelope, gatewayId, siteId, receivedAtMs } = input;
  const pointsBySource = await loadPointMappings(db, gatewayId, envelope.series.map((series) => series.src));
  const normalized = normalizeSamples(envelope, { pointsBySource, receivedAtMs });
  const eventContext = await loadEventContext(db, siteId, envelope.events.map((event) => event.src));
  const events = normalizeEvents(envelope.events, eventContext);

  await ensurePartitionsFor(db, normalized.samples.map((sample) => sample.tsMs));
  return storeBatch(db, {
    gatewayId,
    siteId,
    envelope,
    bodyGzip: input.bodyGzip,
    bodySha256: sha256(input.bodyJson),
    receivedAtMs,
    normalized,
    events,
  });
}
