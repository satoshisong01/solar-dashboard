// sim:backfill 적재 결과를 개발 DB(.env.development.local의 DATABASE_URL)에서 검증한다.
//   npm run verify:ingest [-- --manifest .data/sim/backfill-manifest.json]
// (a) 사이트별 measurement 행 수 = 기대 고유 샘플 수  (b) dirty 전부 처리 후 m_1h = 원시 전체 재집계
// (c) unmapped_source에 의도한 태그  (d) 안전 이벤트  (e) CLOCK_SUSPECT(기대치와 정확히 일치)·LATE 비트
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SIM_SITES } from '../db/seed/sites';
import { db } from '../lib/db/kysely';
import { getServerEnv } from '../lib/env';
import { drainAllDirty, observeRollup, observeSites } from '../lib/ingest/verify-queries';
import { DEFAULT_MANIFEST_PATH, parseManifest, type BackfillManifest } from '../lib/sim/manifest';
import { evaluateIngest, type CheckStatus } from '../lib/sim/verify-checks';
import { formatCount, formatDuration, formatKst } from './sim-shared';

const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = { pass: '통과', fail: '실패', skip: '해당 없음' };

function readManifest(): BackfillManifest {
  const { values } = parseArgs({ options: { manifest: { type: 'string', default: DEFAULT_MANIFEST_PATH } } });
  const path = resolve(process.cwd(), values.manifest);
  if (!existsSync(path)) throw new Error(`${path}이 없습니다. 먼저 npm run sim:backfill 을 실행하세요.`);
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

async function timed<T>(label: string, task: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await task();
  console.log(`[verify] ${label} (${formatDuration(Date.now() - started)})`);
  return result;
}

async function main(): Promise<void> {
  const manifest = readManifest();
  const window = manifest.summary.sampleWindow;
  if (!window) throw new Error('적재 기록에 샘플 시각 범위가 없습니다 (보낸 샘플이 없음)');
  const database = new URL(getServerEnv().DATABASE_URL).pathname.slice(1);
  console.log(
    `[verify] DB ${database} · 적재 기록 ${manifest.createdAt} · ${manifest.sites.join(',')} · 시나리오 ${manifest.scenario} · ` +
      `샘플 시각 ${formatKst(window.minTsMs)} ~ ${formatKst(window.maxTsMs)}`,
  );
  if (manifest.summary.aborted || manifest.summary.results.failed > 0) {
    console.warn(`[verify] 주의: 적재 중 실패한 배치가 ${manifest.summary.results.failed}건 있습니다. 기대치와 다를 수 있습니다.`);
  }

  try {
    const drained = await timed('남은 dirty 롤업 처리', () => drainAllDirty(db));
    const sites = await timed('사이트별 행 수·품질 비트·이벤트·미매핑 조회', () => observeSites(db, manifest.sites, window));
    const rollup = await timed('m_1h ↔ 원시 전체 재집계 비교', () => observeRollup(db));
    console.log(`[verify] dirty 처리 ${formatCount(drained.processed)} 버킷 · 남은 dirty ${formatCount(drained.remaining)}`);

    const intendedUnmapped = new Map(SIM_SITES.filter((site) => manifest.sites.includes(site.code)).map((site) => [site.code, site.unmappedTags.map((tag) => tag.sourceKey)]));
    const checks = evaluateIngest({ sites: manifest.summary.sites, intendedUnmapped }, { sites, rollup: { ...rollup, dirtyRemaining: drained.remaining } });
    for (const check of checks) {
      console.log(`[verify] (${check.id}) ${STATUS_LABEL[check.status]} — ${check.title}`);
      check.details.forEach((line) => console.log(`[verify]     ${line}`));
    }
    const failed = checks.filter((check) => check.status === 'fail');
    console.log(failed.length === 0 ? '[verify] 모든 항목 통과' : `[verify] 실패 ${failed.length}개: ${failed.map((check) => `(${check.id})`).join(' ')}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('[verify] 실패:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
