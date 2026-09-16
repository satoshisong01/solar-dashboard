// 쉬운 말 요약 unit 테스트 입력: 탐지기 14종 각각의 실제 근거.
//   P2 6종 — 탐지기를 픽스처 입력으로 돌려 나온 발견사항과 근거 스냅샷 (탐지기 출력 형식이 바뀌면 여기서 깨진다)
//   P3 8종 — 개발 DB demo 분석(2026-09-15)이 저장한 스냅샷(p3-evidence-fixtures)과 그때 om.finding.effect에 저장된 값
import { dqGapFlatline, essCapacityFade, essCellImbalance, pvInverterPeer, type DqPointSummary } from '@/lib/analytics/detectors';
import { elVoltageRise, fcVoltageDecay } from '@/lib/analytics/detectors/stack-detectors';
import { capacityHistory, DAY0, elRuns, fcRuns, pvDay } from '@/lib/analytics/detectors/test-fixtures';
import type { CandidateFinding, DetectorResult, FailureMode } from '@/lib/analytics/detectors/types';
import { MS_PER_DAY, MS_PER_HOUR } from '@/lib/analytics/types';
import { createRng } from '@/lib/sim/rng';
import { parseEffect } from '../effect';
import { parseEvidence } from '../evidence';
import type { EvidenceView } from '../evidence-types';
import {
  BLOWER_SNAPSHOT,
  COMP_SEC_RISE_SNAPSHOT,
  EL_SEC_RISE_SNAPSHOT,
  MASS_BALANCE_SNAPSHOT_V1,
  RESISTANCE_SNAPSHOT,
  SOILING_SNAPSHOT_V1,
  TANK_LEAK_SNAPSHOT,
  THERMAL_SNAPSHOT,
} from '../p3-evidence-fixtures';
import type { PlainFinding } from './types';

export interface PlainCase {
  readonly detectorId: string;
  readonly finding: PlainFinding;
  readonly evidence: EvidenceView;
}

const SOLAR_SITE = '영암 태양광·ESS';
const H2_SITE = '새만금 연계형';
const KST_2026_09_01 = Date.UTC(2026, 7, 31, 15);

const firstFinding = (result: DetectorResult): CandidateFinding => {
  if (result.status !== 'ok' || !result.findings[0]) throw new Error('탐지 결과가 없습니다');
  return result.findings[0];
};

type Subject = Readonly<{ siteName: string; assetName: string | null; assetCode: string | null }>;

/** 탐지기가 낸 발견사항을 쉬운 말 요약 입력으로 */
function fromDetector(result: DetectorResult, subject: Subject): PlainCase {
  const finding = firstFinding(result);
  return {
    detectorId: finding.detectorId,
    finding: {
      ...subject,
      detectorId: finding.detectorId,
      failureMode: finding.failureMode,
      severity: finding.severity,
      title: finding.title,
      effect: parseEffect(finding.effect),
      windowStartMs: finding.windowStart,
      windowEndMs: finding.windowEnd,
    },
    evidence: parseEvidence(finding.evidence),
  };
}

type P3Effect = Readonly<{ metric: string; value: number; unit?: string; ciLow: number; ciHigh: number; baseline: number | null; current: number | null; levelUnit: string }>;

/** demo 분석이 저장한 P3 발견사항 */
function fromSnapshot(
  detectorId: string,
  failureMode: FailureMode,
  severity: number,
  title: string,
  effect: P3Effect,
  snapshot: unknown,
  subject: Subject,
  windowDays = 113,
): PlainCase {
  const windowEndMs = KST_2026_09_01 + 13 * MS_PER_DAY;
  return {
    detectorId,
    finding: {
      ...subject,
      detectorId,
      failureMode,
      severity,
      title,
      effect: parseEffect({ ...effect, unit: effect.unit ?? '%' }),
      windowStartMs: windowEndMs - windowDays * MS_PER_DAY,
      windowEndMs,
    },
    evidence: parseEvidence(snapshot),
  };
}

function capacityCase(): PlainCase {
  const sessions = capacityHistory(400, 375, 11);
  const curves = sessions.map((s) => ({ start: s.start, points: [{ elapsed_s: 0, ah: 0, soc: 10 }, { elapsed_s: 28_800, ah: s.features.ah_in, soc: 100 }] }));
  const result = essCapacityFade.detect(
    { assetId: 7, ratedCapacityAh: 400, commissionedAt: DAY0 - MS_PER_DAY, sessions, events: [], curves },
    { now: DAY0 + 90 * MS_PER_DAY, rng: createRng(1), params: { cRateBinWidth: 0.05, tempBinWidthC: 5 } },
  );
  return fromDetector(result, { siteName: SOLAR_SITE, assetName: '배터리 랙 1', assetCode: 'RACK01' });
}

function cellImbalanceCase(): PlainCase {
  const rng = createRng(3);
  const points = Array.from({ length: 90 }, (_, day) => ({ ts: DAY0 + day * MS_PER_DAY, dvMv: (day < 30 ? 10 : 10 + (35 * (day - 30)) / 60) + 0.5 * rng.gaussian(), source: 'charge_end' as const, completeness: 1 }));
  const peers = [{ assetId: 2, recentDvMv: 10 }, { assetId: 3, recentDvMv: 11 }, { assetId: 4, recentDvMv: 10.5 }];
  return fromDetector(essCellImbalance.detect({ assetId: 1, points, peers }, { now: DAY0 + 90 * MS_PER_DAY, rng: createRng(1), params: {} }), { siteName: SOLAR_SITE, assetName: '배터리 랙 1', assetCode: 'RACK01' });
}

function pvPeerCase(): PlainCase {
  const days = Array.from({ length: 12 }, (_, day) =>
    Array.from({ length: 4 }, (_, i) => {
      const base = 4 * (1 + 0.002 * Math.sin(day + i));
      return pvDay(i + 1, day, i === 3 ? base * 0.94 : base, day === 3 ? { curtailed: true } : {});
    }),
  ).flat();
  return fromDetector(pvInverterPeer.detect({ siteId: 1, days }, { now: DAY0 + 12 * MS_PER_DAY, rng: createRng(1), params: {} }), { siteName: SOLAR_SITE, assetName: '인버터 4', assetCode: 'INV04' });
}

function dqCase(): PlainCase {
  const window = { start: DAY0, end: DAY0 + 7 * MS_PER_DAY };
  const point = (overrides: Partial<DqPointSummary>): DqPointSummary => ({
    pointId: 1,
    assetId: 10,
    metricKey: 'batt.soc',
    sourceKey: 'ESS1/RACK01/SOC',
    expectedSamples: 10_080,
    receivedSamples: 10_080,
    gaps: [],
    flatlines: [],
    ...overrides,
  });
  const points = [
    point({ receivedSamples: 9_720, gaps: [{ start: DAY0 + MS_PER_DAY, end: DAY0 + MS_PER_DAY + 6 * MS_PER_HOUR }] }),
    point({ pointId: 2, metricKey: 'cell.temp.avg', sourceKey: 'ESS1/RACK01/T_CELL_AVG', flatlines: [{ start: DAY0, end: DAY0 + 8 * MS_PER_HOUR, value: 24.5 }] }),
  ];
  return fromDetector(dqGapFlatline.detect({ siteId: 1, window, points }, { now: window.end, rng: createRng(1), params: {} }), { siteName: SOLAR_SITE, assetName: '배터리 랙 1', assetCode: 'RACK01' });
}

const STACK_OPTIONS = { count: 400, startHours: 1200, endHours: 2400, seed: 2 } as const;

const elVoltageCase = (): PlainCase =>
  fromDetector(elVoltageRise.detect({ assetId: 31, episodes: elRuns({ ...STACK_OPTIONS, rateUvPerH: 25 }) }, { now: DAY0 + 400 * MS_PER_DAY, rng: createRng(1), params: {} }), { siteName: H2_SITE, assetName: '전해 스택 1', assetCode: 'STACK1' });

const fcVoltageCase = (): PlainCase =>
  fromDetector(fcVoltageDecay.detect({ assetId: 41, episodes: fcRuns({ ...STACK_OPTIONS, rateUvPerH: -25 }) }, { now: DAY0 + 400 * MS_PER_DAY, rng: createRng(1), params: {} }), { siteName: H2_SITE, assetName: '연료전지 스택 1', assetCode: 'STACK1' });

/** 탐지기 14종 각각 하나씩 (P2 6종 → P3 8종) */
export const plainCases = (): readonly PlainCase[] => [
  capacityCase(),
  cellImbalanceCase(),
  pvPeerCase(),
  dqCase(),
  elVoltageCase(),
  fcVoltageCase(),
  fromSnapshot(
    'el.sec_rise',
    'el.system_efficiency_loss',
    3,
    '전해조 시스템 비에너지 5.5% 상승',
    { metric: 'sec_kwh_per_kg', value: 5.526, ciLow: 5.114, ciHigh: 5.987, baseline: 58.168, current: 61.383, levelUnit: 'kWh/kg' },
    EL_SEC_RISE_SNAPSHOT,
    { siteName: H2_SITE, assetName: '전해 스택 1', assetCode: 'STACK1' },
  ),
  fromSnapshot(
    'comp.sec_rise',
    'comp.efficiency_loss',
    2,
    '압축기 비에너지 8.0% 상승',
    { metric: 'comp_sec_kwh_per_kg', value: 7.966, ciLow: 6.408, ciHigh: 9.471, baseline: 1.9734, current: 2.1306, levelUnit: 'kWh/kg' },
    COMP_SEC_RISE_SNAPSHOT,
    { siteName: H2_SITE, assetName: '수소 압축기', assetCode: 'COMP1' },
  ),
  fromSnapshot(
    'fc.blower_wear',
    'fc.blower_wear',
    2,
    '공기 블로워 비전력 12.1% 증가',
    { metric: 'blower_specific_power', value: 12.128, ciLow: 7.224, ciHigh: 20.992, baseline: 9.7743, current: 10.9598, levelUnit: 'W/(kg/h)' },
    BLOWER_SNAPSHOT,
    { siteName: H2_SITE, assetName: '공기 블로워', assetCode: 'BLOWER1' },
  ),
  fromSnapshot(
    'ess.resistance_growth',
    'ess.resistance_growth',
    2,
    '랙 직류 내부저항(R_60s) 37.8% 증가',
    { metric: 'R_60s', value: 37.752, ciLow: 11.15, ciHigh: 73.104, baseline: 34.1, current: 46.98, levelUnit: 'mΩ' },
    RESISTANCE_SNAPSHOT,
    { siteName: SOLAR_SITE, assetName: '배터리 랙 2', assetCode: 'RACK02' },
  ),
  fromSnapshot(
    'tank.static_leak',
    'h2.storage_leak',
    4,
    '저장용기 누설 의심 1.03 kg/일 — 즉시 현장 확인',
    { metric: 'tank_leak_kg_per_day', value: 1.0328, unit: 'kg/일', ciLow: 0.9481, ciHigh: 1.1175, baseline: -0.0046, current: 1.0328, levelUnit: 'kg/일' },
    TANK_LEAK_SNAPSHOT,
    { siteName: H2_SITE, assetName: '저장용기 3', assetCode: 'TANK3' },
  ),
  fromSnapshot(
    'h2chain.mass_balance_gap',
    'h2chain.mass_balance_gap',
    3,
    '수소 물질수지 잔차 +2.3%',
    { metric: 'h2_residual_pct', value: 2.284, ciLow: 2.265, ciHigh: 2.345, baseline: 0.022, current: 2.284, levelUnit: '%' },
    MASS_BALANCE_SNAPSHOT_V1,
    { siteName: H2_SITE, assetName: null, assetCode: null },
  ),
  fromSnapshot(
    'pv.soiling_rate',
    'pv.soiling',
    2,
    '태양광 오염 손실 약 3.7% (오염 속도 0.05%/일)',
    { metric: 'soiling_loss_pct', value: 3.725, ciLow: 0.809, ciHigh: 5.559, baseline: 0.9351, current: 0.9003, levelUnit: 'PI' },
    SOILING_SNAPSHOT_V1,
    { siteName: SOLAR_SITE, assetName: null, assetCode: null },
    70,
  ),
  fromSnapshot(
    'inv.thermal_derating',
    'pv.inverter_thermal_derating',
    2,
    '인버터 열 출력저감 손실 0.5% (최근 30일 저감 6.8시간)',
    { metric: 'thermal_derate_loss_pct', value: 0.524, ciLow: 0.192, ciHigh: 0.865, baseline: 1, current: 0.524, levelUnit: '%' },
    THERMAL_SNAPSHOT,
    { siteName: SOLAR_SITE, assetName: '인버터 2', assetCode: 'INV02' },
  ),
];
