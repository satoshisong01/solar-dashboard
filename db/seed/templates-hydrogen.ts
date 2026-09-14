// PEM 수전해·수소 압축저장·PEM 연료전지 설비 템플릿. 순수 데이터 모듈 ('server-only' 금지).
// 정격은 설계 §0의 PEM 기준 추정값이다. 실제 사양이 오면 nameplate 값만 바꾼다.
import { FAST, KELVIN, MEGAPASCAL, sequence, type AssetSpec } from './asset-spec';

/** PEM 전해조 500 kW: 스택 1 + 정류기 + 순수설비 + 기액분리기 + 정제·건조기 */
export function electrolyzerPlant(): readonly AssetSpec[] {
  return [
    {
      code: 'ELZ1',
      classKey: 'h2.elz',
      name: 'PEM 수전해 설비',
      nameplate: { rated_kw: 500, technology: 'PEM', h2_rated_kg_h: 9, outlet_bar: 30 },
      criticality: 5,
      points: [
        ['ac.power', 'P_AC'],
        ['ac.energy.total', 'E_TOTAL'],
        ['h2.flow.mass', 'H2_FLOW'],
        ['h2.mass.total', 'H2_TOTAL'],
        ['h2.pressure', 'P_H2_OUT'],
        ['h2.in.o2', 'HTO'],
        ['o2.in.h2', 'OTH'],
        ['op.state', 'STATE'],
        ['start.count', 'STARTS'],
      ],
    },
    {
      code: 'ELZ1/STACK1',
      classKey: 'h2.elz.stack',
      name: '전해 스택 1',
      nameplate: { cell_count: 210, active_area_cm2: 550, rated_current_a: 1100, rated_dc_kw: 450 },
      criticality: 5,
      points: [
        ['stack.voltage', 'V', FAST],
        ['stack.current', 'I', FAST],
        ['stack.temp', 'T_OUT'],
        ['stack.temp.in', 'T_IN'],
        ['stack.pressure.diff', 'DP'],
        ['cell.voltage.max', 'V_CELL_MAX'],
        ['cell.voltage.min', 'V_CELL_MIN'],
        ['cell.voltage.avg', 'V_CELL_AVG'],
        ['run.hours', 'RUN_H'],
      ],
    },
    {
      code: 'ELZ1/RECT1',
      classKey: 'h2.elz.rectifier',
      name: '정류기',
      nameplate: { rated_dc_kw: 480, rated_ac_kva: 550 },
      criticality: 4,
      points: [
        ['ac.power', 'P_AC'],
        ['dc.power', 'P_DC'],
        ['ac.pf', 'PF'],
        ['rectifier.efficiency', 'EFF'],
        ['heatsink.temp', 'T_HS'],
      ],
    },
    {
      code: 'ELZ1/WTU1',
      classKey: 'h2.elz.water',
      name: '순수 제조설비',
      nameplate: { capacity_l_h: 150 },
      criticality: 3,
      points: [
        ['water.conductivity', 'COND_DI', { qualifier: 'product' }],
        ['water.conductivity', 'COND_LOOP', { qualifier: 'loop' }],
        ['water.flow', 'FLOW_LOOP'],
      ],
    },
    {
      code: 'ELZ1/GLS1',
      classKey: 'h2.elz.gls',
      name: '기액분리기',
      nameplate: { design_bar: 35 },
      criticality: 4,
      points: [
        ['separator.level', 'LVL_H2', { qualifier: 'h2' }],
        ['separator.level', 'LVL_O2', { qualifier: 'o2' }],
      ],
    },
    {
      code: 'ELZ1/DRYER',
      classKey: 'h2.elz.dryer',
      name: '수소 정제·건조기',
      nameplate: { type: 'TSA', dewpoint_target_c: -70 },
      criticality: 3,
      points: [['h2.purity', 'PURITY']], // DEWPOINT 태그는 일부러 매핑하지 않는다 (sites.ts)
    },
  ];
}

const TANK_COUNT = 4;
const DETECTOR_LOCATIONS = ['ELZ1', 'COMP1', 'H2BANK1', 'FC1'] as const;

/** 다이어프램 압축기 1 + 저장뱅크 1(용기 4) + 수소 누출 검지기 4 */
export function hydrogenStorage(): readonly AssetSpec[] {
  const tanks = sequence(TANK_COUNT).map(
    (i): AssetSpec => ({
      code: `H2BANK1/TANK${i}`,
      classKey: 'h2.storage.tank',
      name: `저장용기 ${i}`,
      nameplate: { water_volume_l: 1850, max_bar: 450, vessel_type: 'Type I' },
      criticality: 4,
      peer: true,
      points: [
        ['tank.pressure', 'P', MEGAPASCAL],
        ['tank.temp', 'T'],
      ],
    }),
  );
  const detectors = DETECTOR_LOCATIONS.map(
    (location, index): AssetSpec => ({
      code: `GD${index + 1}`,
      classKey: 'h2.detector',
      name: `수소 검지기 ${index + 1} (${location})`,
      nameplate: { range_ppm: 40_000, alarm_l1_ppm: 4_000, alarm_l2_ppm: 10_000, location },
      criticality: 5,
      peer: true,
      points: [['gas.detector.ppm', 'H2_PPM']],
    }),
  );

  return [
    {
      code: 'COMP1',
      classKey: 'h2.compressor',
      name: '수소 압축기',
      nameplate: { type: 'diaphragm', rated_kw: 45, suction_bar: 30, discharge_bar: 450, capacity_kg_h: 10 },
      criticality: 4,
      points: [
        ['compressor.power', 'P_MOTOR'],
        ['compressor.suction.pressure', 'P_SUC'],
        ['compressor.discharge.pressure', 'P_DIS'],
        ['compressor.discharge.temp', 'T_DIS'],
        ['compressor.leak.pressure', 'P_LEAK'],
        ['ac.energy.total', 'E_TOTAL'],
        ['run.hours', 'RUN_H'],
        ['op.state', 'STATE'],
      ], // VIB_RMS 태그는 일부러 매핑하지 않는다 (sites.ts)
    },
    {
      code: 'H2BANK1',
      classKey: 'h2.storage.bank',
      name: '고압 수소 저장뱅크',
      nameplate: { tank_count: TANK_COUNT, water_volume_l: 1850 * TANK_COUNT, max_bar: 450, usable_kg: 180 },
      criticality: 5,
      points: [
        ['h2.inventory', 'INV_KG'],
        ['valve.open', 'VLV_IN', { qualifier: 'inlet' }],
        ['valve.open', 'VLV_OUT', { qualifier: 'outlet' }],
      ],
    },
    ...tanks,
    ...detectors,
  ];
}

/** PEM 연료전지 200 kW: 스택 1 + 공기 블로워 + 냉각계통 */
export function fuelCellPlant(): readonly AssetSpec[] {
  return [
    {
      code: 'FC1',
      classKey: 'fc.plant',
      name: 'PEM 연료전지 발전설비',
      nameplate: { rated_kw: 200, technology: 'PEMFC' },
      criticality: 4,
      points: [
        ['fc.ac.power', 'P_AC'],
        ['fc.h2.consumption', 'H2_FLOW'],
        ['h2.pressure', 'P_H2_IN'],
        ['purge.count', 'PURGES'],
        ['start.count', 'STARTS'],
        ['op.state', 'STATE'],
      ],
    },
    {
      code: 'FC1/STACK1',
      classKey: 'fc.stack',
      name: '연료전지 스택 1',
      nameplate: { cell_count: 400, active_area_cm2: 800, rated_current_a: 820 },
      criticality: 4,
      points: [
        ['stack.voltage', 'V', FAST],
        ['stack.current', 'I', FAST],
        ['stack.temp', 'T'],
        ['cell.voltage.min', 'V_CELL_MIN'],
        ['cell.voltage.avg', 'V_CELL_AVG'],
        ['run.hours', 'RUN_H'],
      ],
    },
    {
      code: 'FC1/BLOWER1',
      classKey: 'fc.blower',
      name: '공기 블로워',
      nameplate: { rated_kw: 15 },
      criticality: 3,
      points: [
        ['blower.power', 'P'],
        ['blower.flow', 'AIR_FLOW'],
      ],
    },
    {
      code: 'FC1/COOL1',
      classKey: 'fc.cooling',
      name: '스택 냉각계통',
      nameplate: { rated_flow_l_min: 200 },
      criticality: 3,
      points: [
        ['fc.coolant.temp.in', 'T_IN', KELVIN],
        ['fc.coolant.temp.out', 'T_OUT', KELVIN],
        ['fc.coolant.flow', 'FLOW'],
        ['water.conductivity', 'COND'],
      ],
    },
  ];
}
