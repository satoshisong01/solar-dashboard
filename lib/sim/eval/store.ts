// 평가 결과를 sim 스키마(sim.run · sim.injection · sim.eval_result)에 기록한다. 로컬·테스트 DB 전용.
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db/types';
import type { Scorecard } from './scorecard';
import type { DetectorScore } from './score';
import type { SiteJobResult } from './types';

const iso = (ms: number): string => new Date(ms).toISOString();

/** 한 번의 sim:eval 실행을 sim.run 한 행으로 남기고 run id를 돌려준다 */
export async function recordEvaluation(db: Kysely<DB>, scorecard: Scorecard, jobs: readonly SiteJobResult[], scores: readonly DetectorScore[]): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const run = await trx
      .insertInto('sim.run')
      .values({
        seed: scorecard.preset.seeds[0] ?? 0,
        config: JSON.stringify({ kind: 'sim:eval', mode: scorecard.mode, preset: scorecard.preset, jobs: jobs.map((j) => ({ id: j.jobId, site: j.siteCode, runs: j.runIds })), gates: scorecard.gates, pass: scorecard.pass }),
        engine_version: Object.values(scorecard.detectors).map((d) => d.detector).join(','),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const injections = jobs.flatMap((job) =>
      job.injections.map((i) => ({
        run_id: run.id,
        site_code: i.injection.siteCode,
        asset_path: i.injection.assetPath,
        kind: i.injection.kind,
        start_ts: iso(i.injection.startTs),
        end_ts: i.injection.endTs === null ? null : iso(i.injection.endTs),
        params: JSON.stringify({ ...i.injection.params, job: job.jobId, seed: job.seed, detected_at: i.firstDetectionTs === null ? null : iso(i.firstDetectionTs), final_effect: i.finalEffect, true_effect: i.trueEffect }),
        expected_failure_modes: [...i.injection.expectedFailureModes],
      })),
    );
    if (injections.length > 0) await trx.insertInto('sim.injection').values(injections).execute();
    await trx
      .insertInto('sim.eval_result')
      .values(
        scores.map((s) => ({
          run_id: run.id,
          detector_id: s.detectorId,
          tp: s.tp,
          fp: s.fp,
          fn: s.fn,
          recall: s.recall,
          precision: s.precision,
          fp_per_asset_month: s.fpPerAssetMonth,
          median_delay_days: s.medianDelayDays,
          magnitude_mae: s.magnitudeMae,
          details: JSON.stringify({ unit: s.unit, asset_months: s.assetMonths, min_detectable_magnitude: s.minDetectableMagnitude, curve: s.curve, false_positives: s.falsePositives.slice(0, 50) }),
        })),
      )
      .execute();
    return run.id;
  });
}
