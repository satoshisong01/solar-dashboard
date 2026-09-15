// P3 고장 주입이 물리 모델 출력에 반영되는지, 같은 시드의 고장 없는 실행이나 동종 설비와 비교해 확인한다 (플랜트 참값).
import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from './math';
import { h2MassKg } from './models/h2-eos';
import { between, runSite, sumOf, type Keep, type View } from './plant-test-fixtures';
import type { Scenario } from './scenarios';

const TANKS = ['H2BANK1/TANK1', 'H2BANK1/TANK2', 'H2BANK1/TANK3', 'H2BANK1/TANK4'];
const TANK_M3 = 1.85;

/** 용기 참 압력·온도(교정 오프셋 포함, 잡음 없음)로 구한 참값 상태식 질량 합 */
const bankMassKg = (view: View) => TANKS.reduce((sum, tank) => sum + h2MassKg(view.value(tank, 'tank.pressure'), TANK_M3, view.value(tank, 'tank.temp')), 0);

describe('수소 저장 질량 보존 — SIM-B 6일 (플랜트)', () => {
  const from = Date.parse('2026-05-01T00:00:00+09:00');
  const keep: Keep = [['ELZ1', 'h2.mass.total'], ['FC1', 'fc.h2.consumption'], ...TANKS.flatMap((t) => [[t, 'tank.pressure'], [t, 'tank.temp']] as const)];

  function balance(views: readonly View[]) {
    const first = views[0];
    const last = views.at(-1);
    if (!first || !last) throw new Error('스텝 없음');
    const metered = last.value('ELZ1', 'h2.mass.total') - first.value('ELZ1', 'h2.mass.total');
    const consumed = sumOf(views.slice(1), 'FC1', 'fc.h2.consumption') / 60;
    return { metered, consumed, stored: bankMassKg(last) - bankMassKg(first) };
  }

  it('누설 0이면 계량 유입 − 연료전지 소비 − 저장량 변화 ≈ 0 (0.3 kg 이내), 주입한 누설(용기 2 · 하루 2 kg)만큼 잔차가 생긴다', () => {
    const healthy = balance(runSite('SIM-B', from, 6, [], keep));
    const leaking = balance(runSite('SIM-B', from, 6, [{ kind: 'fault.tank_leak', site: 'SIM-B', tank: 'H2BANK1/TANK2', kgPerDay: 2, startDay: 1 }], keep));

    expect(healthy.metered).toBeGreaterThan(50);
    expect(Math.abs(healthy.metered - healthy.consumed - healthy.stored)).toBeLessThan(0.3);
    expect(leaking.metered - leaking.consumed - leaking.stored).toBeGreaterThan(10 - 0.5);
    expect(leaking.metered - leaking.consumed - leaking.stored).toBeLessThan(10 + 0.5);
  }, 60_000);

  it('밤에는 압축기·연료전지가 모두 멈춘 정지 보유 구간이 6시간 이상 이어진다', () => {
    const views = runSite('SIM-B', from, 2, [], [['COMP1', 'op.state'], ['FC1/STACK1', 'stack.current'], ['H2BANK1', 'valve.open#inlet'], ['H2BANK1', 'valve.open#outlet']]);
    let longest = 0;
    let run = 0;
    for (const v of views) {
      const idle = v.value('H2BANK1', 'valve.open#inlet') === 0 && v.value('H2BANK1', 'valve.open#outlet') === 0 && v.value('FC1/STACK1', 'stack.current') === 0;
      run = idle ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest / 60).toBeGreaterThan(6);
  }, 60_000);
});

describe('태양광 — SIM-A 오염 강우 복원·냉각팬 고장', () => {
  it('fault.pv_soiling: 끈적한 오염이 쌓여 동종 대비 발전량이 줄고, 강우일(10일째 03~09시) 강한 비에 씻긴다 (무작위 약한 비로는 안 씻긴다)', () => {
    const from = Date.parse('2026-04-01T00:00:00+09:00');
    const views = runSite('SIM-A', from, 13, [{ kind: 'fault.pv_soiling', site: 'SIM-A', asset: 'PV1/INV01', pctPerDay: 1, startDay: 0, rainDays: [10] }], [['PV1/INV01', 'ac.power'], ['PV1/INV02', 'ac.power']]);
    const ratio = (day: number) => {
      const window = between(views, from + day * MS_PER_DAY, from + (day + 1) * MS_PER_DAY);
      return sumOf(window, 'PV1/INV01', 'ac.power') / sumOf(window, 'PV1/INV02', 'ac.power');
    };

    expect(ratio(2)).toBeGreaterThan(0.96);
    expect(ratio(9)).toBeLessThan(0.93);
    expect(ratio(9)).toBeGreaterThan(0.88);
    expect(ratio(10)).toBeGreaterThan(0.985);
    expect(ratio(10) - ratio(9)).toBeGreaterThan(0.05);
  }, 60_000);

  it('fault.inverter_fan_failure: 여름 낮에는 방열판이 저감 시작 온도(70 °C)를 넘어 출력이 줄고, 겨울에는 출력이 고장 없는 실행과 같다', () => {
    const keep: Keep = [['PV1/INV02', 'ac.power'], ['PV1/INV02', 'heatsink.temp']];
    const fault: Scenario[] = [{ kind: 'fault.inverter_fan_failure', site: 'SIM-A', inverter: 'PV1/INV02', startDay: 0 }];
    // 맑고 더운 날 (시드 31 기준 부하율 0.8 이상): 방열판 온도 상승폭이 2배면 저감 곡선에 걸린다
    const summer = Date.parse('2026-08-10T00:00:00+09:00');
    const winter = Date.parse('2026-01-15T00:00:00+09:00');
    const energy = (views: readonly View[]) => sumOf(views, 'PV1/INV02', 'ac.power');
    const maxHeatsink = (views: readonly View[]) => Math.max(...views.map((v) => v.value('PV1/INV02', 'heatsink.temp')));

    const summerBase = runSite('SIM-A', summer, 2, [], keep);
    const summerFault = runSite('SIM-A', summer, 2, fault, keep);
    const winterBase = runSite('SIM-A', winter, 3, [], keep);
    const winterFault = runSite('SIM-A', winter, 3, fault, keep);

    expect(maxHeatsink(summerBase)).toBeLessThan(70);
    expect(maxHeatsink(summerFault)).toBeGreaterThan(70);
    expect(energy(summerFault) / energy(summerBase)).toBeLessThan(0.97);
    expect(maxHeatsink(winterFault)).toBeLessThan(70);
    expect(maxHeatsink(winterFault)).toBeGreaterThan(maxHeatsink(winterBase));
    expect(energy(winterFault)).toBe(energy(winterBase));
  }, 60_000);
});
