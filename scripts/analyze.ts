// 수동 분석 실행 (로컬 확인용 CLI). 콘솔의 "분석 실행" 버튼과 같은 runAnalysis를 개발 DB에서 부른다.
//   npm run analyze -- --sites SIM-A,SIM-B,SIM-C --days 120
//   npm run analyze -- --sites SIM-A --days 30 --to 2026-09-15T00:00:00+09:00 --assets 12,13
// 끝나면 실행 통계와 대상 사이트의 열린 발견사항을 출력한다. 실행 상태가 failed면 종료 코드 1.
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { runAnalysis, type AnalysisRunResult } from '../lib/analysis/run';
import { db } from '../lib/db/kysely';
import { formatDuration, formatKst } from './sim-shared';

const DAY_MS = 86_400_000;

interface AnalyzeConfig {
  readonly siteCodes: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly assetIds: readonly number[] | undefined;
  readonly budgetMs: number;
  readonly requestedBy: string;
}

function readConfig(): AnalyzeConfig {
  const { values } = parseArgs({
    options: {
      sites: { type: 'string', default: 'SIM-A,SIM-B,SIM-C' },
      days: { type: 'string', default: '30' },
      to: { type: 'string' },
      assets: { type: 'string' },
      'budget-min': { type: 'string', default: '60' },
      by: { type: 'string', default: 'cli:analyze' },
    },
  });
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0 || days > 400) throw new Error(`--days는 0 초과 400 이하여야 합니다 (받은 값: ${values.days})`);
  const to = values.to === undefined ? new Date() : new Date(values.to);
  if (Number.isNaN(to.getTime())) throw new Error(`--to를 시각으로 해석할 수 없습니다: ${values.to}`);
  const assetIds = values.assets?.split(',').map((v) => Number(v.trim()));
  if (assetIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`--assets는 설비 id 쉼표 목록이어야 합니다: ${values.assets}`);
  const budgetMin = Number(values['budget-min']);
  if (!Number.isFinite(budgetMin) || budgetMin <= 0) throw new Error(`--budget-min은 양수여야 합니다: ${values['budget-min']}`);
  return { siteCodes: values.sites.split(',').map((s) => s.trim()).filter(Boolean), from: new Date(to.getTime() - days * DAY_MS), to, assetIds, budgetMs: budgetMin * 60_000, requestedBy: values.by };
}

function printStats(result: AnalysisRunResult): void {
  console.log(`[analyze] 실행 ${result.runId} · ${result.status} · 롤업 ${result.stats.rollup.picked}버킷 · 중단 실행 정리 ${result.stats.abandonedRunsFailed} · ${formatDuration(result.stats.elapsedMs)}`);
  for (const site of result.stats.sites) {
    const detectors = Object.entries(site.detectors).map(([id, t]) => `${id} ok ${t.ok}/부족 ${t.insufficient}/오류 ${t.error}/finding ${t.findings}`).join(' · ');
    console.log(`[analyze] ${site.siteCode}: 설비 ${site.assets} (추출 ${site.extractedAssets}) · 에피소드 저장 ${site.episodesSaved} (누적 ${site.episodesInHistory}) · KPI ${site.kpiRows}행 · ${formatDuration(site.elapsedMs)}`);
    console.log(`[analyze]   탐지: ${detectors}`);
    console.log(`[analyze]   finding: 새 ${site.findings.created} (재발 ${site.findings.recurrences}) · 갱신 ${site.findings.updated} (악화 ${site.findings.worsened}) · 억제 ${site.findings.suppressed}${site.verification ? ` · 조치 검증 ${site.verification.checked} (대기 ${site.verification.pending})` : ''}`);
  }
  result.stats.errors.forEach((e) => console.warn(`[analyze] 오류 ${e.stage} site ${e.siteId}${e.assetId ? ` asset ${e.assetId}` : ''}${e.detectorId ? ` ${e.detectorId}` : ''}: ${e.message}`));
}

interface OpenFindingRow {
  readonly site: string;
  readonly path: string | null;
  readonly detector_id: string;
  readonly status: string;
  readonly severity: number;
  readonly confidence: number;
  readonly title: string;
  readonly effect: { value?: number; unit?: string; ciLow?: number | null; ciHigh?: number | null };
  readonly detection_count: number;
}

async function printOpenFindings(siteIds: readonly number[]): Promise<void> {
  const { rows } = await sql<OpenFindingRow>`
    SELECT s.code AS site, a.path, f.detector_id, f.status, f.severity, f.confidence, f.title, f.effect, f.detection_count
    FROM om.finding f JOIN om.site s ON s.id = f.site_id LEFT JOIN om.asset a ON a.id = f.asset_id
    WHERE f.site_id = ANY(${[...siteIds]}::int4[]) AND f.status NOT IN ('verified', 'dismissed')
    ORDER BY s.code, f.severity DESC, f.confidence DESC
  `.execute(db);
  console.log(`[analyze] 열린 발견사항 ${rows.length}건`);
  for (const f of rows) {
    const ci = f.effect.ciLow == null || f.effect.ciHigh == null ? '' : ` (95% CI ${f.effect.ciLow} ~ ${f.effect.ciHigh})`;
    console.log(`[analyze]   ${f.site} ${f.path ?? '(사이트)'} · ${f.detector_id} · sev ${f.severity} · 신뢰도 ${f.confidence} · ${f.status} · ${f.title} · 효과 ${f.effect.value}${f.effect.unit ?? ''}${ci} · 탐지 ${f.detection_count}회`);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const sites = await db.selectFrom('om.site').select(['id', 'code']).where('code', 'in', [...config.siteCodes]).execute();
  const missing = config.siteCodes.filter((code) => !sites.some((s) => s.code === code));
  if (missing.length > 0) throw new Error(`DB에 없는 사이트: ${missing.join(', ')} (npm run db:seed)`);
  const siteIds = config.siteCodes.map((code) => sites.find((s) => s.code === code)?.id ?? 0);
  console.log(`[analyze] ${config.siteCodes.join(',')} · ${formatKst(config.from.getTime())} ~ ${formatKst(config.to.getTime())} · 시간 예산 ${formatDuration(config.budgetMs)}`);
  const result = await runAnalysis(db, { siteIds, assetIds: config.assetIds ? [...config.assetIds] : undefined, from: config.from, to: config.to, requestedBy: config.requestedBy }, { timeBudgetMs: config.budgetMs, log: (message) => console.log(`[analyze] ${message}`) });
  printStats(result);
  await printOpenFindings(siteIds);
  if (result.status === 'failed') process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('[analyze] 실패:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
