// P3 수소 체인 E2E 계획: globalSetup이 적재하는 SIM-B 고정 과거 기간과 p3-chain.spec.ts가 함께 쓰는 날짜·설비.
// 날짜는 고정이다 (합성 기상이 날짜 시드라 결과가 매 실행 같다). 무거운 모듈을 import하지 않는다 (테스트 워커도 읽는다).
//
// 0일 = 2026-03-01 00:00 KST, 21일 적재 (SIM-B 매핑 포인트 전부)
//   H2BANK1/TANK2  10일째부터 누설 2 kg/일             → tank.static_leak 안전 발견사항(심각도 4) · h2chain.mass_balance_gap 사이트 발견사항
//   COMP1          밸브 마모로 비에너지 +15% → 11일째 10시 밸브 교체로 회복 → 조치 등록·검증만 실행으로 개선 확인
import type { Scenario } from '../../lib/sim/scenarios';
import type { MemoryFixturePlan } from './memory-fixture';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const KST_OFFSET_MS = 9 * HOUR_MS;

export const P3_SITE = 'SIM-B';
export const P3_SEED = 42;
export const P3_DAYS = 21;
const FROM_MS = Date.parse('2026-03-01T00:00:00+09:00');

export const P3_ASSETS = Object.freeze({ leakTank: 'H2BANK1/TANK2', compressor: 'COMP1' });

const TANK_LEAK = { kgPerDay: 2, startDay: 14 } as const;
/** 밸브 마모 비일 상승분(비율)과 교체 시각 */
const VALVE = { wear: 0.15, replacedDay: 11, replacedHour: 10 } as const;
const VALVE_REPLACED_MS = FROM_MS + VALVE.replacedDay * DAY_MS + VALVE.replacedHour * HOUR_MS;

export const p3WindowMs = Object.freeze({ from: FROM_MS, to: FROM_MS + P3_DAYS * DAY_MS });

/** 0일 기준 시각의 datetime-local 입력값 (KST, 분 단위) */
const kstInputAtMs = (ms: number): string => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16);
/** 0일 기준 day일째 KST 날짜 (YYYY-MM-DD) */
const kstDayOf = (day: number): string => new Date(FROM_MS + day * DAY_MS + KST_OFFSET_MS).toISOString().slice(0, 10);

/** 화면에 넣을 값 */
export const P3_INPUTS = Object.freeze({
  run: { from: kstInputAtMs(FROM_MS), to: kstInputAtMs(p3WindowMs.to) },
  /** 설정 변경 뒤 재실행: 누설 용기만, 같은 기간 */
  chain: { from: kstDayOf(0), to: kstDayOf(P3_DAYS - 1) },
  reportMonth: kstDayOf(0).slice(0, 7),
  valveReplacedAt: kstInputAtMs(VALVE_REPLACED_MS),
});

/** 밸브 마모 비일 상승분: 교체 전 VALVE.wear, 교체 뒤 기본값 (고장 hook 인터페이스를 직접 쓴다) */
const valveWearHook = (tMs: number, baseline: number): number => (tMs < VALVE_REPLACED_MS ? baseline + VALVE.wear : baseline);

export function p3Scenarios(): readonly Scenario[] {
  return [
    { kind: 'fault.tank_leak', site: P3_SITE, tank: P3_ASSETS.leakTank, ...TANK_LEAK },
    { kind: 'fault', site: P3_SITE, asset: P3_ASSETS.compressor, param: 'compressor.valveWear', value: valveWearHook },
  ];
}

/** globalSetup 적재 계획 (memory-fixture.ts) */
export const P3_FIXTURE: MemoryFixturePlan = Object.freeze({ label: '수소 체인 픽스처', site: P3_SITE, seed: P3_SEED, days: P3_DAYS, windowMs: p3WindowMs, scenarios: p3Scenarios });
