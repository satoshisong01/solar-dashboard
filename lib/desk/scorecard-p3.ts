// 시뮬레이터 스코어카드 P3 참고 지표(scorecard.json p3, 게이트 아님) 읽기와 탐지기 단계 표시. 순수 모듈.
//   healthy_mass_balance          대조군 SIM-C 일별 물질수지 |잔차율| 분포 (원장 완결성 0.9 이상인 날)
//   pv_control_findings           PV 대조군(출력제어·흐린 주·비 오는 주) 구간 PV 탐지기 finding 수
//   el_sec_rise_path_support      주입 경로별 판별 체크 지지 비율 (정류기·패러데이·스택)
//   tank_leak_mass_balance_share  누설 0.2 kg/일 이상 주입 중 물질수지 finding이 함께 난 비율
//   fan_failure_delays            냉각팬 고장 시작일(계절)별 탐지 지연
import { asArray, asNumber, asRecord } from './json-read';

export const P2_DETECTORS: readonly string[] = ['ess.capacity_fade', 'ess.cell_imbalance', 'pv.inverter_peer', 'el.voltage_rise', 'fc.voltage_decay', 'dq.gap_flatline'];

/** 설계 §5.3 탐지기 로드맵 단계 */
export const detectorStage = (detectorId: string): 'P2' | 'P3' => (P2_DETECTORS.includes(detectorId) ? 'P2' : 'P3');

export interface MassBalanceDistribution {
  readonly days: number;
  readonly medianPct: number;
  readonly p90Pct: number | null;
  readonly p95Pct: number | null;
  readonly maxPct: number | null;
}

export interface PathSupport {
  readonly overall: number | null;
  readonly detected: number;
  readonly target: number | null;
  readonly byMode: readonly (readonly [mode: string, detected: number, supportRatio: number | null])[];
}

export interface ScorecardP3View {
  readonly healthyMassBalance: MassBalanceDistribution | null;
  readonly pvControlFindings: number | null;
  readonly elSecPathSupport: PathSupport | null;
  readonly tankLeakMassBalance: { readonly injections: number; readonly withFinding: number; readonly share: number | null } | null;
  /** 고장 시작일(평가 시작 기준 일수)·그 날짜(평가 프리셋 시작이 있으면)·시드별 탐지 지연 */
  readonly fanFailureDelays: readonly { readonly startDay: number; readonly startMs: number | null; readonly delaysDays: readonly number[] }[];
}

const numbers = (value: unknown): number[] => asArray(value).flatMap((v) => (asNumber(v) === null ? [] : [asNumber(v) as number]));

export function parseScorecardP3(raw: unknown): ScorecardP3View {
  const p3 = asRecord(asRecord(raw).p3);
  const healthy = asRecord(p3.healthy_mass_balance);
  const median = asNumber(healthy.median_pct);
  const path = asRecord(p3.el_sec_rise_path_support);
  const leak = asRecord(p3.tank_leak_mass_balance_share);
  const injections = asNumber(leak.injections);
  const from = asRecord(asRecord(raw).preset).from;
  const fromMs = typeof from === 'string' && Number.isFinite(Date.parse(from)) ? Date.parse(from) : null;
  return {
    healthyMassBalance: median === null ? null : { days: asNumber(healthy.days) ?? 0, medianPct: median, p90Pct: asNumber(healthy.p90_pct), p95Pct: asNumber(healthy.p95_pct), maxPct: asNumber(healthy.max_pct) },
    pvControlFindings: asNumber(p3.pv_control_findings),
    elSecPathSupport:
      Object.keys(path).length === 0
        ? null
        : {
            overall: asNumber(path.overall),
            detected: asNumber(path.detected) ?? 0,
            target: asNumber(path.target),
            byMode: Object.entries(asRecord(path.by_mode)).map(([mode, v]) => [mode, asNumber(asRecord(v).detected) ?? 0, asNumber(asRecord(v).support_ratio)] as const),
          },
    tankLeakMassBalance: injections === null ? null : { injections, withFinding: asNumber(leak.with_mass_balance_finding) ?? 0, share: asNumber(leak.share) },
    fanFailureDelays: asArray(p3.fan_failure_delays).flatMap((item) => {
      const startDay = asNumber(asRecord(item).start_day);
      return startDay === null ? [] : [{ startDay, startMs: fromMs === null ? null : fromMs + startDay * 86_400_000, delaysDays: numbers(asRecord(item).delays_days) }];
    }),
  };
}

const PATH_LABELS: Readonly<Record<string, string>> = { rectifier: '정류기 효율 경로', faradaic: '패러데이 효율 경로', stack: '스택 전압 경로' };
export const pathLabel = (mode: string): string => PATH_LABELS[mode] ?? mode;

/** 날짜(epoch ms) → KST 월 기준 계절 */
export function seasonOf(ms: number): string {
  const month = new Date(ms + 9 * 3_600_000).getUTCMonth() + 1;
  if (month === 12 || month <= 2) return '겨울';
  if (month <= 5) return '봄';
  if (month <= 8) return '여름';
  return '가을';
}
