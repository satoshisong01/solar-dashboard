// 보존한 원본 배치(bronze)를 다시 정규화해 원시에 채운다 (설계 §3 기둥 1, §5.1 규칙 5).
// 미매핑 태그를 포인트로 매핑한 뒤 호출하면, 이미 있던 샘플은 ON CONFLICT로 건너뛰고 새로 매핑된 포인트 샘플만
// REPROCESSED 비트와 함께 들어간다. LATE·CLOCK_SUSPECT·미래 거부는 원래 수신 시각 기준으로 다시 판정한다.
// 미매핑 인박스·이벤트·게이트웨이 상태·배치 통계는 원래 수신 기록이므로 건드리지 않는다.
// 'server-only'를 넣지 않는다: 관리 스크립트와 테스트에서도 쓴다.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import { decodeGzipJson } from './body';
import { parseEnvelope, type IngestEnvelope } from './envelope';
import { normalizeSamples, type NormalizedBatch } from './normalize';
import { drainDirty, type ProcessDirtyResult } from './rollup';
import { ensurePartitionsFor, insertSamples, loadPointMappings } from './store';

const DEFAULT_CHUNK_SIZE = 20;

export interface ReplayOptions {
  /** 이 시각 이후에 받은 배치만 (received_at 기준) */
  readonly from?: Date;
  /** 한 트랜잭션에서 처리할 배치 수 */
  readonly chunkSize?: number;
}

export interface ReplayTotals {
  readonly batches: number;
  /** 본문을 풀거나 검증하지 못해 건너뛴 배치 */
  readonly failed: number;
  /** 이번에 새로 들어간 샘플 (주로 새로 매핑된 포인트) */
  readonly accepted: number;
  /** 이미 있던 샘플 */
  readonly duplicate: number;
  readonly rejected: number;
  readonly unmapped: number;
  readonly missing: number;
}

export interface ReplayResult extends ReplayTotals {
  readonly rollup: ProcessDirtyResult;
}

interface BatchRow {
  readonly id: string;
  readonly received_at: Date;
  readonly body_gzip: Buffer;
}

/** 재처리할 배치 id를 받은 순서대로 (본문은 청크마다 따로 읽는다) */
async function listBatchIds(db: Kysely<DB>, gatewayId: number, from: Date | undefined): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('om.ingest_batch')
    .select('id')
    .where('gateway_id', '=', gatewayId)
    .$if(from !== undefined, (qb) => qb.where('received_at', '>=', from ?? new Date(0)))
    .orderBy('received_at')
    .orderBy('id')
    .execute();
  return rows.map((row) => row.id);
}

async function fetchBatches(db: Kysely<DB>, ids: readonly string[]): Promise<readonly BatchRow[]> {
  return db
    .selectFrom('om.ingest_batch')
    .select(['id', 'received_at', 'body_gzip'])
    .where('id', 'in', [...ids])
    .orderBy('received_at')
    .orderBy('id')
    .execute();
}

async function decodeBatch(row: BatchRow): Promise<IngestEnvelope | null> {
  try {
    const { json } = await decodeGzipJson(row.body_gzip);
    const parsed = parseEnvelope(json);
    return parsed.ok ? parsed.envelope : null;
  } catch {
    return null;
  }
}

const EMPTY_TOTALS: ReplayTotals = { batches: 0, failed: 0, accepted: 0, duplicate: 0, rejected: 0, unmapped: 0, missing: 0 };

/** 청크 하나: 매핑 조회 → 정규화 → 파티션 준비 → 한 트랜잭션에서 배치별 원시 INSERT */
async function replayChunk(db: Kysely<DB>, gatewayId: number, rows: readonly BatchRow[]): Promise<{ readonly totals: ReplayTotals; readonly pointIds: readonly number[] }> {
  const decoded = await Promise.all(rows.map(async (row) => ({ row, envelope: await decodeBatch(row) })));
  const valid = decoded.flatMap(({ row, envelope }) => (envelope ? [{ row, envelope }] : []));
  const pointsBySource = await loadPointMappings(db, gatewayId, valid.flatMap(({ envelope }) => envelope.series.map((s) => s.src)));
  const normalized: readonly NormalizedBatch[] = valid.map(({ row, envelope }) =>
    normalizeSamples(envelope, { pointsBySource, receivedAtMs: row.received_at.getTime(), reprocessed: true }),
  );
  await ensurePartitionsFor(db, normalized.flatMap((batch) => batch.samples.map((sample) => sample.tsMs)));

  const results = await db.transaction().execute(async (trx) => {
    const perBatch = [];
    for (const batch of normalized) perBatch.push(await insertSamples(trx, batch.samples));
    return perBatch;
  });
  const inserted = results.reduce((total, result) => total + result.inserted, 0);

  const sum = (pick: (batch: NormalizedBatch) => number) => normalized.reduce((total, batch) => total + pick(batch), 0);
  const candidates = sum((batch) => batch.stats.candidates);
  const totals: ReplayTotals = {
    batches: rows.length,
    failed: rows.length - valid.length,
    accepted: inserted,
    duplicate: candidates - inserted,
    rejected: sum((batch) => batch.stats.rejected),
    unmapped: sum((batch) => batch.stats.unmapped),
    missing: sum((batch) => batch.stats.missing),
  };
  return { totals, pointIds: results.flatMap((result) => result.pointIds) };
}

function addTotals(a: ReplayTotals, b: ReplayTotals): ReplayTotals {
  return {
    batches: a.batches + b.batches,
    failed: a.failed + b.failed,
    accepted: a.accepted + b.accepted,
    duplicate: a.duplicate + b.duplicate,
    rejected: a.rejected + b.rejected,
    unmapped: a.unmapped + b.unmapped,
    missing: a.missing + b.missing,
  };
}

/** 게이트웨이의 보존 배치를 받은 순서대로 청크 단위로 재처리하고, 새로 들어간 포인트의 dirty 롤업을 처리한다. */
export async function replayGateway(db: Kysely<DB>, gatewayId: number, options: ReplayOptions = {}): Promise<ReplayResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error(`chunkSize는 1 이상의 정수여야 합니다: ${chunkSize}`);

  const ids = await listBatchIds(db, gatewayId, options.from);
  let totals = EMPTY_TOTALS;
  let touched: ReadonlySet<number> = new Set();
  for (let start = 0; start < ids.length; start += chunkSize) {
    const rows = await fetchBatches(db, ids.slice(start, start + chunkSize));
    const chunk = await replayChunk(db, gatewayId, rows);
    totals = addTotals(totals, chunk.totals);
    touched = new Set([...touched, ...chunk.pointIds]);
  }

  const rollup = touched.size > 0 ? await drainDirty(db, { pointIds: [...touched] }) : { picked: 0, upserted: 0, cleared: 0 };
  return { ...totals, rollup };
}
