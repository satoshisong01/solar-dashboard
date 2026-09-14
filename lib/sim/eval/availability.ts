// ess.capacity_fade 판정 가능 기간 집계 (순수): 사이트별 insufficient 비율, 여름 연속 insufficient 최장 일수, SOC 상한 변경 대조군.
// 규칙
//   여름 = 점검 시각의 KST 월이 6~8월
//   연속 insufficient 일수 = 한 설비에서 연달아 insufficient인 여름 점검들의 (마지막 − 처음) + 점검 간격
//   SOC 상한 변경 대조군 = control.soc_upper_limit_change의 ESS 설비 아래 랙. 변경 시각 + 7일 이후 점검에서
//     판정 ok 점검 수(랙마다, 가장 적은 값)와 변경 이후 그 랙들의 ess.capacity_fade finding 수(전부 오탐)
import { DAYS_PER_MONTH, KST_OFFSET_MS, MS_PER_DAY } from '@/lib/analytics/types';
import { evalSite } from './assets';
import type { CheckpointStatus, SiteJobResult } from './types';

const SUMMER_MONTHS: readonly number[] = [6, 7, 8];
const CONTROL_SETTLE_DAYS = 7;

const kstMonth = (ts: number): number => new Date(ts + KST_OFFSET_MS).getUTCMonth() + 1;

export interface SiteAvailability {
  readonly siteCode: string;
  readonly checkpoints: number;
  readonly insufficient: number;
  readonly insufficientRatio: number | null;
  readonly summerInsufficientRatio: number | null;
  /** 여름 연속 insufficient 최장 일수 */
  readonly summerLongestInsufficientDays: number;
}

function longestRunDays(statuses: readonly CheckpointStatus[], stepDays: number): number {
  const byAsset = new Map<number, CheckpointStatus[]>();
  for (const s of statuses) byAsset.set(s.assetId, [...(byAsset.get(s.assetId) ?? []), s]);
  let longest = 0; // 설비·구간을 돌며 갱신하는 최댓값
  for (const list of byAsset.values()) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    let runStart: number | null = null;
    let runEnd = 0;
    for (const s of sorted) {
      if (s.status === 'insufficient') {
        runStart ??= s.ts;
        runEnd = s.ts;
        longest = Math.max(longest, (runEnd - runStart) / MS_PER_DAY + stepDays);
      } else {
        runStart = null;
      }
    }
  }
  return longest;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export function capacityAvailability(jobs: readonly SiteJobResult[]): SiteAvailability[] {
  const sites = [...new Set(jobs.map((j) => j.siteCode))].sort();
  return sites.map((siteCode) => {
    const own = jobs.filter((j) => j.siteCode === siteCode);
    const all = own.flatMap((j) => j.capacityStatuses);
    const summer = all.filter((s) => SUMMER_MONTHS.includes(kstMonth(s.ts)));
    const longest = Math.max(0, ...own.map((j) => longestRunDays(j.capacityStatuses.filter((s) => SUMMER_MONTHS.includes(kstMonth(s.ts))), ((j.checkpointTs[1] ?? 0) - (j.checkpointTs[0] ?? 0)) / MS_PER_DAY)));
    return {
      siteCode,
      checkpoints: all.length,
      insufficient: all.filter((s) => s.status === 'insufficient').length,
      insufficientRatio: ratio(all.filter((s) => s.status === 'insufficient').length, all.length),
      summerInsufficientRatio: ratio(summer.filter((s) => s.status === 'insufficient').length, summer.length),
      summerLongestInsufficientDays: longest,
    };
  });
}

export interface SocLimitControlScore {
  readonly racks: number;
  /** 변경 이후 판정 ok 점검 수 (랙 중 가장 적은 값). 대조군이 없으면 null */
  readonly minOkCheckpoints: number | null;
  readonly falsePositives: number;
  /** 변경 이후 점검 기간 [자산·월] */
  readonly assetMonths: number;
}

export function socLimitControlScore(jobs: readonly SiteJobResult[]): SocLimitControlScore {
  const perRack = jobs.flatMap((job) => {
    const site = evalSite(job.siteCode);
    return job.controls
      .filter((c) => c.kind === 'control.soc_upper_limit_change' && c.assetPath !== null)
      .flatMap((control) =>
        site.assets
          .filter((a) => a.classKey === 'ess.rack' && `${site.site.code}/${a.code}`.startsWith(`${control.assetPath}/`))
          .map((rack) => {
            const settled = control.startTs + CONTROL_SETTLE_DAYS * MS_PER_DAY;
            const after = job.capacityStatuses.filter((s) => s.assetId === rack.id && s.ts >= settled);
            const lastTs = job.checkpointTs.at(-1) ?? settled;
            return {
              ok: after.filter((s) => s.status === 'ok').length,
              fp: job.detections.filter((d) => d.detectorId === 'ess.capacity_fade' && d.assetId === rack.id && d.ts >= control.startTs).length,
              months: Math.max(0, lastTs - settled) / MS_PER_DAY / DAYS_PER_MONTH,
            };
          }),
      );
  });
  return {
    racks: perRack.length,
    minOkCheckpoints: perRack.length === 0 ? null : Math.min(...perRack.map((r) => r.ok)),
    falsePositives: perRack.reduce((sum, r) => sum + r.fp, 0),
    assetMonths: perRack.reduce((sum, r) => sum + r.months, 0),
  };
}
