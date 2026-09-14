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
