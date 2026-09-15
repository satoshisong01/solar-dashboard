// 폐루프 E2E 계획: globalSetup이 적재하는 SIM-A 고장 주입 픽스처와 p2-closed-loop.spec.ts가 함께 쓰는 날짜·설비.
// 날짜는 고정이다 (합성 기상이 날짜 시드라 결과가 매 실행 같다). 무거운 모듈을 import하지 않는다 (테스트 워커도 읽는다).
//
// 0일 = 2026-05-01 00:00 KST, 80일 적재 (1분 해상도, SIM-A 매핑 포인트 전부)
//   RACK01  22일째부터 4일간 유효용량 −7%                  → 용량 감소 발견사항 (워크스페이스·리포트)
//   RACK03  15일째부터 셀 전압 편차가 월 60 mV씩 커지다가 45일째 밸런싱으로 해소 → 셀 불균형 발견사항 → 조치 → 효과 확인
//   INV01   30일째부터 효율 −2%p (계속)                    → 인버터 발견사항 → '운영 조건 변경' 기각 + 기준선 재설정
import type { Scenario } from '../../lib/sim/scenarios';
import type { MemoryFixturePlan } from './memory-fixture';

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const MV_PER_MONTH_DAYS = 365.25 / 12;

export const LOOP_SITE = 'SIM-A';
export const LOOP_SEED = 42;
export const LOOP_DAYS = 80;
const FROM_MS = Date.parse('2026-05-01T00:00:00+09:00');

export const LOOP_ASSETS = Object.freeze({ capacity: 'ESS1/RACK01', cellImbalance: 'ESS1/RACK03', inverter: 'PV1/INV01' });

const CAPACITY_FADE = { startDay: 22, totalPct: 7, days: 4 } as const;
const INVERTER_DROP = { startDay: 30, pctPoints: 2 } as const;
const CELL_SPREAD = { startDay: 15, mVPerMonth: 60, balancedDay: 45 } as const;
/** 1차 분석 끝 = 밸런싱 시각. 2차 분석 끝은 조치 뒤 안정화 3일·비교 창 30일(셀 불균형 조치 폼 기본값)이 지난 뒤 */
const FIRST_RUN_END_DAY = CELL_SPREAD.balancedDay;
const SECOND_RUN_END_DAY = CELL_SPREAD.balancedDay + 3 + 30;
/** 인버터 기준선 재설정 시각: 2차 분석 끝 3일 전 (재설정 뒤 3일은 5/7일 판정에 모자라 같은 발견사항이 다시 생기지 않는다) */
const INVERTER_BASELINE_DAY = SECOND_RUN_END_DAY - 3;

export const loopWindowMs = Object.freeze({ from: FROM_MS, to: FROM_MS + LOOP_DAYS * DAY_MS });

/** 0일 기준 day일째 시각의 datetime-local 입력값 (KST, 분 단위) */
export function kstInputAt(day: number): string {
  return new Date(FROM_MS + day * DAY_MS + KST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 화면에 넣을 값 */
export const LOOP_INPUTS = Object.freeze({
  firstRun: { from: kstInputAt(0), to: kstInputAt(FIRST_RUN_END_DAY) },
  secondRun: { from: kstInputAt(0), to: kstInputAt(SECOND_RUN_END_DAY) },
  balancingAt: kstInputAt(CELL_SPREAD.balancedDay),
  inverterBaselineAt: kstInputAt(INVERTER_BASELINE_DAY),
  /** 용량 감소 탐지 창·셀 밸런싱 효과 검증 후 창이 모두 걸리는 달 */
  reportMonth: kstInputAt(SECOND_RUN_END_DAY).slice(0, 7),
});

/** 셀 전압 편차 추가분 [mV]: startDay부터 선형 증가, balancedDay에 밸런싱으로 기본값 복귀 (고장 hook 인터페이스를 직접 쓴다) */
function cellSpreadHook(tMs: number, baseline: number): number {
  const start = FROM_MS + CELL_SPREAD.startDay * DAY_MS;
  const balanced = FROM_MS + CELL_SPREAD.balancedDay * DAY_MS;
  if (tMs < start || tMs >= balanced) return baseline;
  return baseline + ((tMs - start) / DAY_MS) * (CELL_SPREAD.mVPerMonth / MV_PER_MONTH_DAYS);
}

export function loopScenarios(): readonly Scenario[] {
  return [
    { kind: 'fault.battery_capacity_fade', site: LOOP_SITE, asset: LOOP_ASSETS.capacity, ...CAPACITY_FADE },
    { kind: 'fault.inverter_efficiency_drop', site: LOOP_SITE, asset: LOOP_ASSETS.inverter, ...INVERTER_DROP },
    { kind: 'fault', site: LOOP_SITE, asset: LOOP_ASSETS.cellImbalance, param: 'battery.cellSpreadMv', value: cellSpreadHook },
  ];
}

/** globalSetup 적재 계획 (memory-fixture.ts) */
export const LOOP_FIXTURE: MemoryFixturePlan = Object.freeze({ label: '폐루프 픽스처', site: LOOP_SITE, seed: LOOP_SEED, days: LOOP_DAYS, windowMs: loopWindowMs, scenarios: loopScenarios });
