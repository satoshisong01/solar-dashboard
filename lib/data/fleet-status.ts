// 플릿 매트릭스 셀(사이트 × 도메인) 상태 규칙. 순수 함수 (now 주입).
// P1 신호: 데이터 신선도 · 최근 알람 · 미확인 안전 이벤트 · 데이터 품질 비트 비율.
// P2에서 발견사항(finding) 기반 신호가 이 입력에 추가된다.
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

export function evaluateCell(signals: CellSignals, nowMs: number): CellStatus {
  if (!signals.hasAssets) return { level: 'na', reasons: [] };

  const findings = [
    freshness(signals.lastSampleMs, nowMs),
    ...alarms(signals),
    signals.unackedSafety > 0 ? { level: 'crit', reason: `미확인 안전 이벤트 ${signals.unackedSafety}건` } : null,
    dataQuality(signals.samples24h, signals.invalidSamples24h),
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
