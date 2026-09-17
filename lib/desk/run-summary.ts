// 분석 실행(om.analysis_run) 통계·범위 요약. 순수 모듈 (서버·클라이언트 공용).
// stats 형식은 lib/analysis/run.ts AnalysisRunStats를 따르지만 jsonb라 좁혀 읽는다.
import { asArray, asNumber, asRecord, asString } from './json-read';

export interface RunSummary {
  readonly created: number;
  readonly updated: number;
  readonly worsened: number;
  readonly suppressed: number;
  readonly recurrences: number;
  /** 표본 부족으로 판정하지 못한 탐지기 실행 수 */
  readonly insufficient: number;
  /** 판정 불가였던 탐지기 id (중복 없이) */
  readonly insufficientDetectors: readonly string[];
  readonly detectorErrors: number;
  readonly runErrors: number;
  readonly verificationsChecked: number;
  readonly verifiedFindings: number;
  readonly elapsedMs: number | null;
  readonly budgetExceeded: boolean;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

export function summarizeRunStats(stats: unknown): RunSummary {
  const root = asRecord(stats);
  const sites = asArray(root.sites).map(asRecord);
  const findings = sites.map((site) => asRecord(site.findings));
  const detectorTallies = sites.flatMap((site) => Object.entries(asRecord(site.detectors)).map(([id, tally]) => ({ id, tally: asRecord(tally) })));
  const verifications = sites.map((site) => asRecord(site.verification));
  const pick = (rows: readonly Readonly<Record<string, unknown>>[], key: string) => sum(rows.map((row) => asNumber(row[key]) ?? 0));
  return {
    created: pick(findings, 'created'),
    updated: pick(findings, 'updated'),
    worsened: pick(findings, 'worsened'),
    suppressed: pick(findings, 'suppressed'),
    recurrences: pick(findings, 'recurrences'),
    insufficient: sum(detectorTallies.map((d) => asNumber(d.tally.insufficient) ?? 0)),
    insufficientDetectors: [...new Set(detectorTallies.filter((d) => (asNumber(d.tally.insufficient) ?? 0) > 0).map((d) => d.id))].sort(),
    detectorErrors: sum(detectorTallies.map((d) => asNumber(d.tally.error) ?? 0)),
    runErrors: asArray(root.errors).length,
    verificationsChecked: pick(verifications, 'checked'),
    verifiedFindings: pick(verifications, 'verifiedFindings'),
    elapsedMs: asNumber(root.elapsedMs),
    budgetExceeded: root.budgetExceeded === true,
  };
}

export interface RunScope {
  readonly siteIds: readonly number[];
  readonly assetIds: readonly number[] | null;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  /** 조치 추적의 "검증만 실행" (분석 단계 없이 조치 효과 검증만) */
  readonly verifyOnly: boolean;
}

export function parseRunScope(scope: unknown): RunScope {
  const s = asRecord(scope);
  const ids = (value: unknown) => asArray(value).flatMap((v) => (asNumber(v) === null ? [] : [asNumber(v) as number]));
  const time = (value: unknown) => {
    const text = asString(value);
    const ms = text === null ? Number.NaN : Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  };
  return { siteIds: ids(s.siteIds), assetIds: Array.isArray(s.assetIds) ? ids(s.assetIds) : null, fromMs: time(s.from), toMs: time(s.to), verifyOnly: s.mode === 'verify' };
}

export const RUN_STATUS_LABELS: Readonly<Record<string, string>> = {
  running: '실행 중',
  succeeded: '완료',
  partial: '일부 완료',
  failed: '실패',
};

export const runStatusLabel = (status: string): string => RUN_STATUS_LABELS[status] ?? status;

/** 실행 소요 시간: '43초' · '1분 7초' · 1시간 이상은 '1시간 5분' */
export function formatElapsedMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  return `${Math.floor(seconds / 3_600)}시간 ${Math.floor((seconds % 3_600) / 60)}분`;
}

/**
 * 실행 중 진행 상황 (om.analysis_run.stats.progress). 실행이 끝나면 stats가 최종 통계로 바뀌며 사라진다.
 * 쓰는 쪽은 lib/analysis/run.ts, 읽는 쪽은 분석 데스크의 진행 표시다.
 */
export interface RunProgress {
  readonly siteCode: string | null;
  /** 1부터. 사이트별 실행에 들어가기 전이면 0 */
  readonly siteIndex: number;
  readonly siteCount: number;
  readonly stage: string;
  readonly atMs: number;
}

export function parseRunProgress(stats: unknown): RunProgress | null {
  const row = asRecord(asRecord(stats).progress);
  const stage = asString(row.stage);
  if (stage === null) return null;
  return { siteCode: asString(row.siteCode), siteIndex: asNumber(row.siteIndex) ?? 0, siteCount: asNumber(row.siteCount) ?? 0, stage, atMs: asNumber(row.atMs) ?? 0 };
}

const RUN_STAGE_LABELS: Readonly<Record<string, string>> = {
  rollup: '남은 롤업 처리',
  extract: '에피소드 추출',
  kpi: '일 KPI',
  aux: '보조 입력',
  detect: '탐지',
  ledger: '체인 원장',
  findings: '발견사항 저장',
  verify: '조치 효과 검증',
};

export const runStageLabel = (stage: string): string => RUN_STAGE_LABELS[stage] ?? stage;

/** 진행 표시 한 줄: '준비 중' · '남은 롤업 처리' · 'SIM-B (2/4) · 탐지' */
export function runProgressText(progress: RunProgress | null): string {
  if (progress === null) return '준비 중';
  const stage = runStageLabel(progress.stage);
  if (progress.siteCode === null) return stage;
  return `${progress.siteCode}${progress.siteCount > 1 ? ` (${progress.siteIndex}/${progress.siteCount})` : ''} · ${stage}`;
}

/**
 * 실행이 끝내지 못한 사이트 id: 통계에 없거나 건너뛴 단계가 있는 사이트. '이어서 실행'의 대상이다.
 * (사이트는 순서대로 돌므로 시간 예산을 넘기면 뒤쪽 사이트가 통째로 남는다)
 */
export function unfinishedSiteIds(scope: RunScope, stats: unknown): readonly number[] {
  const finished = new Set(
    asArray(asRecord(stats).sites)
      .map(asRecord)
      .filter((site) => asArray(site.skipped).length === 0)
      .flatMap((site) => {
        const id = asNumber(site.siteId);
        return id === null ? [] : [id];
      }),
  );
  return scope.siteIds.filter((id) => !finished.has(id));
}
