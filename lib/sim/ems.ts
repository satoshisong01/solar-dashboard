// 사이트 EMS 운전 로직 (분 단위, 순수 함수). 이전 스텝 상태를 보고 이번 스텝 지령을 낸다.
// SIM-A(pv_ess): PV → 보조부하 → 여유분 ESS 충전(SOC 90% 상한) → 계통 수출, 18~22시 ESS 방전.
// SIM-B/C(integrated): PV → 보조부하 → 전해조(최소부하 이상일 때, 여유 부족 시 ESS 보조 후 정지)
//   → ESS 충전 → 수출. 저장 압력 상한이면 전해조 정지, 17~22시 연료전지 150 kW(저장 하한 이상), 야간 ESS 방전.
import type { ElectrolyzerMode } from './models/electrolyzer';

export type SiteLayout = 'pv_ess' | 'integrated';

export const EMS_SETTINGS = Object.freeze({
  socMax: 0.9,
  pvEss: { dischargeStartH: 18, dischargeEndH: 22, socMin: 0.1 },
  integrated: {
    dischargeStartH: 19,
    dischargeEndH: 23,
    socMin: 0.2,
    /** 전해조 보조 방전을 허용하는 최소 SOC */
    supportSocMin: 0.3,
    maxSupportS: 1_800,
    /** 여유전력이 최소부하 × 이 배수 이상으로 startHoldS 동안 이어져야 기동 */
    startSurplusFactor: 1.2,
    startHoldS: 600,
    storageStopBar: 440,
    storageResumeBar: 400,
    fcStartH: 17,
    fcEndH: 22,
    fcAcKw: 150,
    fcStartBar: 80,
    fcStopBar: 50,
  },
});

export interface EssView {
  readonly socFraction: number;
  readonly chargeLimitKw: number;
  readonly dischargeLimitKw: number;
  readonly ratedKw: number;
  readonly usableEnergyKwh: number;
}

export interface HydrogenView {
  readonly elzMode: ElectrolyzerMode;
  readonly elzRatedKw: number;
  readonly elzMinKw: number;
  readonly storagePressureBar: number;
  readonly compressorKw: number;
}

export interface EmsInput {
  readonly layout: SiteLayout;
  /** KST 시각 (0~24) */
  readonly localHour: number;
  readonly dtS: number;
  readonly pvAcKw: number;
  readonly auxKw: number;
  readonly ess: EssView | null;
  readonly hydrogen: HydrogenView | null;
  readonly safetyLockout: boolean;
}

export interface EmsMemory {
  readonly elzStartTimerS: number;
  readonly elzSupportS: number;
  readonly storageFull: boolean;
  readonly fcBlocked: boolean;
}

export interface UnitCommand {
  readonly run: boolean;
  readonly acKw: number;
}

export interface EmsDecision {
  /** ESS PCS AC 지령 [kW]: 방전 +, 충전 − */
  readonly essAcKw: number;
  readonly elz: UnitCommand;
  readonly fc: UnitCommand;
  readonly memory: EmsMemory;
}

export const INITIAL_EMS_MEMORY: EmsMemory = Object.freeze({
  elzStartTimerS: 0,
  elzSupportS: 0,
  storageFull: false,
  fcBlocked: false,
});

const STOPPED: UnitCommand = Object.freeze({ run: false, acKw: 0 });
const inWindow = (hour: number, startH: number, endH: number): boolean => hour >= startH && hour < endH;

/** 창이 끝날 때까지 SOC 하한 위 에너지를 고르게 방전한다. */
function eveningDischargeKw(ess: EssView, hour: number, endH: number, socMin: number, dtS: number): number {
  const energyKwh = Math.max(0, ess.socFraction - socMin) * ess.usableEnergyKwh;
  const hoursLeft = Math.max(endH - hour, dtS / 3_600);
  return Math.max(0, Math.min(ess.ratedKw, ess.dischargeLimitKw, energyKwh / hoursLeft));
}

/** 남는 전력으로 SOC 상한까지 충전하는 PCS 지령(음수). 이번 스텝에 상한을 넘지 않게 제한한다. */
function chargeCommandKw(ess: EssView, availableKw: number, dtS: number): number {
  if (availableKw <= 0) return 0;
  const headroomKw = (Math.max(0, EMS_SETTINGS.socMax - ess.socFraction) * ess.usableEnergyKwh * 3_600) / dtS;
  const kw = Math.min(availableKw, ess.ratedKw, ess.chargeLimitKw, headroomKw);
  return kw > 0 ? -kw : 0;
}

function dispatchPvEss(input: EmsInput, memory: EmsMemory): EmsDecision {
  const { dischargeStartH, dischargeEndH, socMin } = EMS_SETTINGS.pvEss;
  const surplus = input.pvAcKw - input.auxKw;
  const ess = input.ess;
  let essAcKw = 0;
  if (ess && inWindow(input.localHour, dischargeStartH, dischargeEndH)) {
    essAcKw = eveningDischargeKw(ess, input.localHour, dischargeEndH, socMin, input.dtS);
  } else if (ess) {
    essAcKw = chargeCommandKw(ess, surplus, input.dtS);
  }
  return { essAcKw, elz: STOPPED, fc: STOPPED, memory };
}

interface ElectrolyzerPlan {
  readonly command: UnitCommand;
  readonly supportKw: number;
  readonly startTimerS: number;
  readonly supportS: number;
}

function planElectrolyzer(input: EmsInput, h2: HydrogenView, memory: EmsMemory, surplus: number, allowed: boolean): ElectrolyzerPlan {
  const s = EMS_SETTINGS.integrated;
  const active = h2.elzMode === 'starting' || h2.elzMode === 'running';
  if (!active) {
    const timer = surplus >= h2.elzMinKw * s.startSurplusFactor ? memory.elzStartTimerS + input.dtS : 0;
    const start = allowed && timer >= s.startHoldS;
    return start
      ? { command: { run: true, acKw: Math.min(h2.elzRatedKw, surplus) }, supportKw: 0, startTimerS: 0, supportS: 0 }
      : { command: STOPPED, supportKw: 0, startTimerS: timer, supportS: 0 };
  }
  if (!allowed) return { command: STOPPED, supportKw: 0, startTimerS: 0, supportS: 0 };
  if (surplus >= h2.elzMinKw) {
    return { command: { run: true, acKw: Math.min(h2.elzRatedKw, surplus) }, supportKw: 0, startTimerS: 0, supportS: 0 };
  }
  const needKw = h2.elzMinKw - Math.max(0, surplus);
  const supportS = memory.elzSupportS + input.dtS;
  const ess = input.ess;
  const canSupport = ess !== null && ess.socFraction > s.supportSocMin && needKw <= ess.dischargeLimitKw && supportS <= s.maxSupportS;
  return canSupport
    ? { command: { run: true, acKw: h2.elzMinKw }, supportKw: needKw, startTimerS: 0, supportS }
    : { command: STOPPED, supportKw: 0, startTimerS: 0, supportS: 0 };
}

function dispatchIntegrated(input: EmsInput, memory: EmsMemory, h2: HydrogenView): EmsDecision {
  const s = EMS_SETTINGS.integrated;
  const storageFull = memory.storageFull ? h2.storagePressureBar > s.storageResumeBar : h2.storagePressureBar >= s.storageStopBar;
  const fcBlocked = memory.fcBlocked ? h2.storagePressureBar < s.fcStartBar : h2.storagePressureBar < s.fcStopBar;
  const surplus = input.pvAcKw - input.auxKw - h2.compressorKw;
  const elzPlan = planElectrolyzer(input, h2, memory, surplus, !storageFull && !input.safetyLockout);

  const fcRun = inWindow(input.localHour, s.fcStartH, s.fcEndH) && !fcBlocked && !input.safetyLockout;
  const fc: UnitCommand = fcRun ? { run: true, acKw: s.fcAcKw } : STOPPED;

  const ess = input.ess;
  let essAcKw = 0;
  if (ess && elzPlan.supportKw > 0) {
    essAcKw = elzPlan.supportKw;
  } else if (ess && inWindow(input.localHour, s.dischargeStartH, s.dischargeEndH)) {
    essAcKw = eveningDischargeKw(ess, input.localHour, s.dischargeEndH, s.socMin, input.dtS);
  } else if (ess) {
    const elzKw = elzPlan.command.run ? elzPlan.command.acKw : 0;
    essAcKw = chargeCommandKw(ess, surplus - elzKw, input.dtS);
  }

  return {
    essAcKw,
    elz: elzPlan.command,
    fc,
    memory: { elzStartTimerS: elzPlan.startTimerS, elzSupportS: elzPlan.supportS, storageFull, fcBlocked },
  };
}

export function dispatch(input: EmsInput, memory: EmsMemory): EmsDecision {
  if (input.layout === 'integrated') {
    if (!input.hydrogen) throw new Error('연계형 사이트 EMS에는 수소 설비 상태가 필요합니다');
    return dispatchIntegrated(input, memory, input.hydrogen);
  }
  return dispatchPvEss(input, memory);
}
