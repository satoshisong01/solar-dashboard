import { describe, expect, it } from 'vitest';
import { dispatch, EMS_SETTINGS, INITIAL_EMS_MEMORY, type EmsInput, type EmsMemory, type EssView, type HydrogenView } from './ems';

const ESS: EssView = { socFraction: 0.5, chargeLimitKw: 1_000, dischargeLimitKw: 1_000, ratedKw: 1_000, usableEnergyKwh: 2_000 };
const H2: HydrogenView = { elzMode: 'off', elzRatedKw: 500, elzMinKw: 100, storagePressureBar: 250, compressorKw: 0.3 };

const pvEss = (extra: Partial<EmsInput>): EmsInput => ({ layout: 'pv_ess', localHour: 12, dtS: 60, pvAcKw: 600, auxKw: 8, ess: ESS, hydrogen: null, safetyLockout: false, ...extra });
const integrated = (extra: Partial<EmsInput>, h2: Partial<HydrogenView> = {}): EmsInput => ({
  layout: 'integrated',
  localHour: 12,
  dtS: 60,
  pvAcKw: 1_200,
  auxKw: 20,
  ess: { ...ESS, ratedKw: 500, chargeLimitKw: 500, dischargeLimitKw: 500, usableEnergyKwh: 1_000 },
  hydrogen: { ...H2, ...h2 },
  safetyLockout: false,
  ...extra,
});

describe('SIM-A (pv_ess)', () => {
  it('낮에는 보조부하를 뺀 여유분으로 ESS를 충전한다', () => {
    const decision = dispatch(pvEss({}), INITIAL_EMS_MEMORY);

    expect(decision.essAcKw).toBeCloseTo(-(600 - 8), 9);
    expect(decision.elz.run).toBe(false);
    expect(decision.fc.run).toBe(false);
  });

  it('SOC 90% 상한에서는 충전하지 않고, 상한 직전에는 넘지 않을 만큼만 충전한다', () => {
    expect(dispatch(pvEss({ ess: { ...ESS, socFraction: 0.9 } }), INITIAL_EMS_MEMORY).essAcKw).toBe(0);

    const nearCap = dispatch(pvEss({ ess: { ...ESS, socFraction: 0.899 } }), INITIAL_EMS_MEMORY);
    expect(-nearCap.essAcKw * (60 / 3_600)).toBeLessThanOrEqual(0.001 * ESS.usableEnergyKwh + 1e-9);
  });

  it('18~22시에는 SOC 하한 위 에너지를 남은 시간에 고르게 방전한다', () => {
    const evening = dispatch(pvEss({ localHour: 19, pvAcKw: 0, ess: { ...ESS, socFraction: 0.6 } }), INITIAL_EMS_MEMORY);
    const floor = dispatch(pvEss({ localHour: 20, pvAcKw: 0, ess: { ...ESS, socFraction: EMS_SETTINGS.pvEss.socMin } }), INITIAL_EMS_MEMORY);

    expect(evening.essAcKw).toBeCloseTo(((0.6 - 0.1) * 2_000) / 3, 6);
    expect(floor.essAcKw).toBe(0);
    expect(dispatch(pvEss({ localHour: 23, pvAcKw: 0 }), INITIAL_EMS_MEMORY).essAcKw).toBe(0);
  });
});

describe('SIM-B/C (integrated)', () => {
  it('여유전력이 최소부하×1.2 이상으로 10분 이어져야 전해조를 기동한다', () => {
    let memory: EmsMemory = INITIAL_EMS_MEMORY;
    const starts: boolean[] = [];
    for (let minute = 0; minute < 11; minute += 1) {
      const decision = dispatch(integrated({ pvAcKw: 200 }), memory);
      starts.push(decision.elz.run);
      memory = decision.memory;
    }

    expect(starts.slice(0, 9).every((run) => !run)).toBe(true);
    expect(starts[9]).toBe(true);
  });

  it('운전 중에는 여유전력만큼(정격 한도) 전해조를 돌리고 남는 전력으로 ESS를 충전한다', () => {
    const decision = dispatch(integrated({}, { elzMode: 'running' }), INITIAL_EMS_MEMORY);

    expect(decision.elz).toEqual({ run: true, acKw: 500 });
    expect(decision.essAcKw).toBeCloseTo(-500, 6);
  });

  it('여유가 최소부하보다 부족하면 ESS가 보조하고, 보조 시간이 끝나면 정지한다', () => {
    const supported = dispatch(integrated({ pvAcKw: 80 }, { elzMode: 'running' }), INITIAL_EMS_MEMORY);
    expect(supported.elz).toEqual({ run: true, acKw: 100 });
    expect(supported.essAcKw).toBeCloseTo(100 - (80 - 20 - 0.3), 6);

    const exhausted = dispatch(integrated({ pvAcKw: 80 }, { elzMode: 'running' }), { ...INITIAL_EMS_MEMORY, elzSupportS: EMS_SETTINGS.integrated.maxSupportS });
    expect(exhausted.elz.run).toBe(false);

    const lowSoc = integrated({ pvAcKw: 80, ess: { ...ESS, socFraction: 0.25 } }, { elzMode: 'running' });
    expect(dispatch(lowSoc, INITIAL_EMS_MEMORY).elz.run).toBe(false);
  });

  it('저장 압력 상한(440 bar)에서 전해조를 세우고 400 bar 아래로 내려가야 다시 허용한다', () => {
    const full = dispatch(integrated({}, { elzMode: 'running', storagePressureBar: 441 }), INITIAL_EMS_MEMORY);
    expect(full.elz.run).toBe(false);
    expect(full.memory.storageFull).toBe(true);

    const stillFull = dispatch(integrated({}, { elzMode: 'running', storagePressureBar: 420 }), full.memory);
    expect(stillFull.elz.run).toBe(false);

    const resumed = dispatch(integrated({}, { elzMode: 'running', storagePressureBar: 399 }), stillFull.memory);
    expect(resumed.memory.storageFull).toBe(false);
    expect(resumed.elz.run).toBe(true);
  });

  it('17~22시에 저장 하한 이상이면 연료전지 150 kW, 하한 미만이거나 안전 인터록이면 정지', () => {
    expect(dispatch(integrated({ localHour: 18 }), INITIAL_EMS_MEMORY).fc).toEqual({ run: true, acKw: 150 });
    expect(dispatch(integrated({ localHour: 16.9 }), INITIAL_EMS_MEMORY).fc.run).toBe(false);
    expect(dispatch(integrated({ localHour: 18 }, { storagePressureBar: 45 }), INITIAL_EMS_MEMORY).fc.run).toBe(false);
    expect(dispatch(integrated({ localHour: 18, safetyLockout: true }), INITIAL_EMS_MEMORY).fc.run).toBe(false);

    const blocked = dispatch(integrated({ localHour: 18 }, { storagePressureBar: 45 }), INITIAL_EMS_MEMORY).memory;
    expect(dispatch(integrated({ localHour: 18 }, { storagePressureBar: 70 }), blocked).fc.run).toBe(false);
    expect(dispatch(integrated({ localHour: 18 }, { storagePressureBar: 85 }), blocked).fc.run).toBe(true);
  });

  it('밤(19~23시)에는 ESS를 방전하고, 안전 인터록이면 전해조를 기동하지 않는다', () => {
    const night = dispatch(integrated({ localHour: 20, pvAcKw: 0 }), INITIAL_EMS_MEMORY);
    expect(night.essAcKw).toBeGreaterThan(0);

    const locked = dispatch(integrated({ safetyLockout: true }, { elzMode: 'running' }), INITIAL_EMS_MEMORY);
    expect(locked.elz.run).toBe(false);
  });

  it('수소 설비 상태 없이 연계형 EMS를 부르면 오류', () => {
    expect(() => dispatch(integrated({ hydrogen: null }), INITIAL_EMS_MEMORY)).toThrow('수소 설비');
  });
});
