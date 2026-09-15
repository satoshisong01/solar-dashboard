// 플릿 매트릭스 셀(사이트 × 도메인) 상태 규칙. 순수 함수 (now 주입).
// 신호: 데이터 신선도 · 최근 알람 · 미확인 안전 이벤트 · 데이터 품질 비트 비율 · (P2) 열린 발견사항 최고 심각도 · (P3) 열린 안전 발견사항 · 수소 원장 잔차율.
import { formatDuration } from '@/lib/format';

export type StatusLevel = 'ok' | 'warn' | 'crit' | 'unknown' | 'na';

export interface CellSignals {
  /** 이 도메인의 설비가 사이트에 있는가. 없으면 na */
  readonly hasAssets: boolean;
  /** 도메인 포인트 중 가장 최근 샘플 시각. 수신 기록이 없으면 null */
  readonly lastSampleMs: number | null;
  /** 최근 24시간 알람(안전 이벤트 제외) */
  readonly majorAlarms24h: number;
  readonly criticalAlarms24h: number;
  /** 확인(ack)되지 않은 안전 이벤트. 기간 제한 없음 (자동 해제 불가) */
  readonly unackedSafety: number;
  /** 최근 24시간 샘플 수와 그중 유효성 비트(INVALID_QUALITY_MASK)가 켜진 수 */
  readonly samples24h: number;
  readonly invalidSamples24h: number;
  /** 이 셀에 속한 열린 발견사항(기각·효과 확인 제외) 수와 최고 심각도(없으면 null) */
  readonly openFindings: number;
  readonly maxFindingSeverity: number | null;
  /** 이 셀의 열린 안전 발견사항(안전 카테고리·심각도 4 이상) 수 */
  readonly safetyFindings: number;
  /** 수소 원장 최근 잔차율 요약 (저장 열만, 원장이 없거나 판단할 날이 모자라면 null) */
  readonly ledgerResidual: LedgerResidual | null;
}

export interface LedgerResidual {
  /** 최근 유효일 잔차율 중앙값 [%] */
  readonly medianPct: number;
  readonly days: number;
  /** 물질수지 탐지기 잔차율 기준 [%] (활성 설정) */
  readonly thresholdPct: number;
}

export interface LedgerDayResidual {
  /** KST 'YYYY-MM-DD' */
  readonly day: string;
  readonly residualPct: number | null;
  readonly completeness: number | null;
}

/** 수소 원장 잔차 규칙 기본값: h2chain.mass_balance_gap 기본 최근 기간 7일·최근 최소 유효일 5일 */
export const LEDGER_RESIDUAL_RULES = Object.freeze({ recentDays: 7, minDays: 5 });

/**
 * 원장 저장일 중 마지막 recentDays일(달력 기준, 마지막 저장일부터)에서 완결성 기준 이상인 날의 잔차율 중앙값.
 * 유효일이 minDays 미만이면 null (판단하지 않음)
 */
export function summarizeLedgerResidual(days: readonly LedgerDayResidual[], rule: { readonly thresholdPct: number; readonly minCompleteness: number }, recentDays = LEDGER_RESIDUAL_RULES.recentDays, minDays = LEDGER_RESIDUAL_RULES.minDays): LedgerResidual | null {
  const last = [...days].map((d) => d.day).sort().at(-1);
  if (last === undefined) return null;
  const from = new Date(Date.parse(`${last}T00:00:00Z`) - (recentDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const values = days.filter((d) => d.day >= from && d.residualPct !== null && Number.isFinite(d.residualPct) && (d.completeness ?? 0) >= rule.minCompleteness).map((d) => d.residualPct as number).sort((a, b) => a - b);
  if (values.length < minDays) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? (values[mid] as number) : ((values[mid - 1] as number) + (values[mid] as number)) / 2;
  return { medianPct: Math.round(median * 100) / 100, days: values.length, thresholdPct: rule.thresholdPct };
}

export interface CellStatus {
  readonly level: StatusLevel;
  readonly reasons: readonly string[];
}

export const FLEET_THRESHOLDS = Object.freeze({
  /** 게이트웨이 기본 flush 5분 × 3회 */
  staleWarnMs: 15 * 60_000,
  staleCritMs: 60 * 60_000,
  dqWarnRatio: 0.01,
  dqCritRatio: 0.05,
  findingWarnSeverity: 2,
  findingCritSeverity: 4,
  alarmWindowMs: 24 * 3_600_000,
});

const LEVEL_RANK: Readonly<Record<StatusLevel, number>> = { na: -1, ok: 0, unknown: 1, warn: 2, crit: 3 };

type Finding = Readonly<{ level: Exclude<StatusLevel, 'na'>; reason: string }>;

function freshness(lastSampleMs: number | null, nowMs: number): Finding | null {
  if (lastSampleMs === null) return { level: 'unknown', reason: '수신 기록 없음' };
  const ageMs = nowMs - lastSampleMs;
  if (ageMs > FLEET_THRESHOLDS.staleCritMs) return { level: 'crit', reason: `수신 끊김 ${formatDuration(ageMs)}` };
  if (ageMs > FLEET_THRESHOLDS.staleWarnMs) return { level: 'warn', reason: `수신 지연 ${formatDuration(ageMs)}` };
  return null;
}

function alarms(signals: CellSignals): Finding[] {
  const found: Finding[] = [];
  if (signals.criticalAlarms24h > 0) found.push({ level: 'crit', reason: `심각 알람 ${signals.criticalAlarms24h}건` });
  if (signals.majorAlarms24h > 0) found.push({ level: 'warn', reason: `주요 알람 ${signals.majorAlarms24h}건` });
  return found;
}

function dataQuality(samples: number, invalid: number): Finding | null {
  if (samples <= 0) return null;
  const ratio = invalid / samples;
  const reason = `품질 이상 ${(ratio * 100).toFixed(1)}%`;
  if (ratio >= FLEET_THRESHOLDS.dqCritRatio) return { level: 'crit', reason };
  if (ratio >= FLEET_THRESHOLDS.dqWarnRatio) return { level: 'warn', reason };
  return null;
}

/** 열린 발견사항: 최고 심각도 4 이상 위험, 2 이상 주의, 1(관찰)은 수준을 올리지 않고 사유만 남긴다 */
function openFindings(count: number, maxSeverity: number | null): Finding | null {
  if (count <= 0 || maxSeverity === null) return null;
  const reason = `열린 발견사항 ${count}건 (최고 심각도 ${maxSeverity})`;
  if (maxSeverity >= FLEET_THRESHOLDS.findingCritSeverity) return { level: 'crit', reason };
  if (maxSeverity >= FLEET_THRESHOLDS.findingWarnSeverity) return { level: 'warn', reason };
  return { level: 'ok', reason };
}

/** 수소 원장 잔차율 중앙값이 기준을 넘으면 주의 (발견사항 여부와 별개로 원장 자체의 이상 신호) */
function ledgerResidual(signal: LedgerResidual | null): Finding | null {
  if (signal === null || !(Math.abs(signal.medianPct) > signal.thresholdPct)) return null;
  const sign = signal.medianPct > 0 ? '+' : '−';
  return { level: 'warn', reason: `수소 원장 잔차율 중앙값 ${sign}${Math.abs(signal.medianPct).toFixed(2)}% (최근 ${signal.days}일, 기준 ±${signal.thresholdPct}%)` };
}

export function evaluateCell(signals: CellSignals, nowMs: number): CellStatus {
  if (!signals.hasAssets) return { level: 'na', reasons: [] };

  const findings = [
    freshness(signals.lastSampleMs, nowMs),
    ...alarms(signals),
    signals.unackedSafety > 0 ? { level: 'crit', reason: `미확인 안전 이벤트 ${signals.unackedSafety}건` } : null,
    dataQuality(signals.samples24h, signals.invalidSamples24h),
    openFindings(signals.openFindings, signals.maxFindingSeverity),
    signals.safetyFindings > 0 ? { level: 'crit', reason: `안전 발견사항 ${signals.safetyFindings}건 (현장 확인 우선)` } : null,
    ledgerResidual(signals.ledgerResidual),
  ].filter((finding): finding is Finding => finding !== null);

  return {
    level: worstLevel(['ok', ...findings.map((finding) => finding.level)]),
    reasons: findings.map((finding) => finding.reason),
  };
}

/** 가장 나쁜 수준. na는 무시하고, 모두 na이거나 비어 있으면 na */
export function worstLevel(levels: readonly StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), 'na');
}
