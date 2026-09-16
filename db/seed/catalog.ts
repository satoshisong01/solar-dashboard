// 설비 종류(asset_class)와 메트릭 정의(metric_def) 카탈로그. 순수 데이터 모듈 ('server-only' 금지).
// 근거: docs/renewal/data-contract-draft.md, docs/renewal/research/deep/research-*.json의 dataToCollect(must 중심).
// 범위 값은 업계 자료 기반 추정 기본값이다. 실사이트 사양이 오면 값만 바꾼다.
import type { AssetClassDef, AssetLevel, MetricDef, NameplateField, RollupKind, ValueKind } from './types';

type FieldSpec = readonly [type: NameplateField['type'], title: string, required?: 'required'];

function assetClass(
  key: string,
  level: AssetLevel,
  parentKey: string | null,
  nameKo: string,
  fields: Readonly<Record<string, FieldSpec>>,
  safetyEventCodes: readonly string[] = [],
): AssetClassDef {
  const entries = Object.entries(fields);
  return {
    key,
    level,
    parentKey,
    nameKo,
    nameplateSchema: {
      type: 'object',
      required: entries.filter(([, [, , required]]) => required).map(([name]) => name),
      properties: Object.fromEntries(entries.map(([name, [type, title]]) => [name, { type, title }])),
    },
    safetyEventCodes,
  };
}

const NUM = 'number';
const INT = 'integer';
const STR = 'string';
const REQ = 'required';

export const ASSET_CLASSES: readonly AssetClassDef[] = [
  // 태양광
  assetClass('pv.plant', 'system', null, '태양광 발전설비', {
    dc_kwp: [NUM, '설치 용량 (kWp)', REQ],
    ac_kw: [NUM, '인버터 정격 합계 (kW)', REQ],
    module_wp: [NUM, '모듈 정격 (Wp)'],
    tilt_deg: [NUM, '경사각 (°)'],
    azimuth_deg: [NUM, '방위각 (°)'],
  }),
  assetClass('pv.inverter', 'asset', 'pv.plant', '태양광 인버터', {
    ac_kw: [NUM, '정격 AC 출력 (kW)', REQ],
    dc_kwp: [NUM, '연결 DC 용량 (kWp)', REQ],
    mppt_count: [INT, 'MPPT 수', REQ],
  }, ['INSULATION_FAULT', 'ARC_FAULT', 'RCD_TRIP']),
  assetClass('pv.mppt', 'component', 'pv.inverter', 'MPPT 입력 채널', {
    dc_kwp: [NUM, '연결 DC 용량 (kWp)', REQ],
    strings: [INT, '스트링 수', REQ],
    modules_per_string: [INT, '스트링당 모듈 수'],
  }),
  // ESS
  assetClass('ess.plant', 'system', null, 'ESS 설비', {
    energy_kwh: [NUM, '정격 용량 (kWh)', REQ],
    power_kw: [NUM, 'PCS 정격 (kW)', REQ],
    chemistry: [STR, '셀 화학', REQ],
    rack_count: [INT, '랙 수'],
  }, ['FIRE_ALARM', 'FIRE_SUPPRESSION_RELEASE', 'OFFGAS_ALARM', 'ESD', 'INSULATION_FAULT']),
  assetClass('ess.pcs', 'asset', 'ess.plant', 'ESS PCS', {
    power_kw: [NUM, '정격 출력 (kW)', REQ],
  }, ['ESD']),
  assetClass('ess.rack', 'asset', 'ess.plant', '배터리 랙', {
    energy_kwh: [NUM, '정격 용량 (kWh)', REQ],
    capacity_ah: [NUM, '정격 용량 (Ah)', REQ],
    nominal_v: [NUM, '공칭 전압 (V)', REQ],
    cells_series: [INT, '직렬 셀 수', REQ],
    cells_parallel: [INT, '병렬 셀 수'],
    chemistry: [STR, '셀 화학', REQ],
  }, ['CELL_OVERVOLT', 'CELL_UNDERVOLT', 'CELL_OVERTEMP', 'BMS_PROTECTION_TRIP']),
  // 사이트 공용
  assetClass('wx.station', 'asset', null, '기상관측 설비', {
    poa_tilt_deg: [NUM, '경사면 일사계 경사각 (°)', REQ],
  }),
  assetClass('grid.meter', 'asset', null, '계통 연계 계량기', {
    voltage_v: [NUM, '연계 전압 (V)', REQ],
    export_limit_kw: [NUM, '송전 한도 (kW)'],
  }, ['RELAY_TRIP']),
  // PEM 수전해
  assetClass('h2.elz', 'system', null, 'PEM 수전해 설비', {
    rated_kw: [NUM, '정격 전력 (kW)', REQ],
    technology: [STR, '방식', REQ],
    h2_rated_kg_h: [NUM, '정격 수소 생산량 (kg/h)', REQ],
    outlet_bar: [NUM, '수소 출구 압력 (bar)'],
    nm3_reference_c: [NUM, 'Nm³ 기준 온도 (°C)'], // 0/15/20 — 모든 질량 환산이 약 7% 달라진다
  }, ['ESD', 'H2_IN_O2_HIGH', 'O2_IN_H2_HIGH', 'ENCLOSURE_H2_HIGH', 'VENTILATION_FAULT']),
  assetClass('h2.elz.stack', 'asset', 'h2.elz', '전해 스택', {
    cell_count: [INT, '셀 수', REQ],
    active_area_cm2: [NUM, '셀 활성면적 (cm²)', REQ],
    rated_current_a: [NUM, '정격 전류 (A)', REQ],
    rated_dc_kw: [NUM, '정격 DC 전력 (kW)'],
  }, ['CELL_VOLTAGE_TRIP', 'STACK_OVERTEMP']),
  assetClass('h2.elz.rectifier', 'asset', 'h2.elz', '정류기', {
    rated_dc_kw: [NUM, '정격 DC 출력 (kW)', REQ],
    rated_ac_kva: [NUM, '정격 AC 입력 (kVA)'],
  }),
  assetClass('h2.elz.water', 'asset', 'h2.elz', '순수 제조설비', {
    capacity_l_h: [NUM, '순수 제조량 (L/h)', REQ],
    feed_m3_h: [NUM, '설계 급수 유량 (m³/h)'],
    recycle_m3_h: [NUM, '설계 회수수 재순환 유량 (m³/h)'],
    recycle_source: [STR, '회수수 출처'],
  }),
  assetClass('h2.elz.gls', 'asset', 'h2.elz', '기액분리기', {
    design_bar: [NUM, '설계 압력 (bar)', REQ],
  }, ['SEPARATOR_LEVEL_TRIP']),
  assetClass('h2.elz.dryer', 'asset', 'h2.elz', '수소 정제·건조기', {
    type: [STR, '방식', REQ],
    dewpoint_target_c: [NUM, '목표 이슬점 (°C)'],
  }),
  // 수소 압축·저장
  assetClass('h2.compressor', 'asset', null, '수소 압축기', {
    type: [STR, '형식', REQ],
    rated_kw: [NUM, '정격 모터 출력 (kW)', REQ],
    suction_bar: [NUM, '설계 흡입 압력 (bar)'],
    discharge_bar: [NUM, '최종 토출 압력 (bar)', REQ],
    capacity_kg_h: [NUM, '압축 용량 (kg/h)'],
  }, ['DIAPHRAGM_LEAK', 'DISCHARGE_OVERTEMP', 'SUCTION_O2_HIGH', 'ESD']),
  assetClass('h2.storage.bank', 'asset', null, '고압 수소 저장뱅크', {
    tank_count: [INT, '용기 수', REQ],
    water_volume_l: [NUM, '총 내용적 (L)', REQ],
    max_bar: [NUM, '최고 충전 압력 (bar)', REQ],
    usable_kg: [NUM, '가용 저장량 (kg)'],
    pressure_basis: [STR, '압력 기준 (gauge/abs)'], // 재고 환산이 달라진다
    min_outlet_bar: [NUM, '인출 하한 압력 (bar)'], // 감압밸브 최소 입구 차압으로 정해진다
  }, ['OVERPRESSURE', 'PSV_RELEASE', 'TANK_OVERTEMP', 'FIRE_FLAME_DETECTED', 'ESD']),
  assetClass('h2.storage.tank', 'component', 'h2.storage.bank', '수소 저장용기', {
    water_volume_l: [NUM, '내용적 (L)', REQ],
    max_bar: [NUM, '최고 충전 압력 (bar)', REQ],
    vessel_type: [STR, '용기 형식'],
  }),
  assetClass('h2.detector', 'asset', null, '수소 누출 검지기', {
    range_ppm: [NUM, '측정 범위 (ppm)', REQ],
    alarm_l1_ppm: [NUM, '1차 경보 (ppm)', REQ],
    alarm_l2_ppm: [NUM, '2차 경보 (ppm)', REQ],
    location: [STR, '설치 위치(설비 코드)', REQ],
  }, ['H2_LEAK_L1', 'H2_LEAK_L2', 'DETECTOR_FAULT']),
  // PEM 연료전지
  assetClass('fc.plant', 'system', null, 'PEM 연료전지 발전설비', {
    rated_kw: [NUM, '정격 AC 출력 (kW)', REQ],
    technology: [STR, '방식', REQ],
  }, ['ESD', 'ENCLOSURE_H2_HIGH', 'EXHAUST_H2_HIGH', 'VENTILATION_FAULT', 'INSULATION_FAULT', 'FIRE_FLAME_DETECTED']),
  assetClass('fc.stack', 'asset', 'fc.plant', '연료전지 스택', {
    cell_count: [INT, '셀 수', REQ],
    active_area_cm2: [NUM, '셀 활성면적 (cm²)', REQ],
    rated_current_a: [NUM, '정격 전류 (A)', REQ],
  }, ['CELL_UNDERVOLT', 'STACK_OVERTEMP']),
  assetClass('fc.blower', 'asset', 'fc.plant', '공기 블로워', {
    rated_kw: [NUM, '정격 전력 (kW)', REQ],
  }),
  assetClass('fc.cooling', 'asset', 'fc.plant', '스택 냉각계통', {
    rated_flow_l_min: [NUM, '정격 유량 (L/min)', REQ],
  }, ['COOLANT_FLOW_LOSS']),
  assetClass('fc.pcs', 'asset', 'fc.plant', '연료전지 PCS', {
    power_kw: [NUM, '정격 출력 (kW)', REQ],
    ac_voltage_v: [NUM, '계통측 전압 (V)'],
    dc_voltage_v: [NUM, '직류측 전압 (V)'],
  }, ['ESD']),
  assetClass('hx.recovery', 'asset', 'fc.plant', '폐열회수 열교환기', {
    duty_kw: [NUM, '설계 회수 열출력 (kWth)', REQ],
    type: [STR, '형식 (plate/shell)'],
    wall_type: [STR, '벽 구조 (single/double)'], // 단일벽이면 교차누설이 수전해 급수로 바로 간다
    plate_material: [STR, '판·개스킷 재질'],
    design_approach_k: [NUM, '설계 접근온도 (K)'],
    design_ua_kw_k: [NUM, '설계 UA (kW/K)'],
  }, ['HX_CROSS_LEAK']),
  // 수처리 상세 (순수 제조설비의 부품)
  assetClass('h2.elz.water.tank', 'component', 'h2.elz.water', 'DI 물탱크', {
    volume_m3: [NUM, '내용적 (m³)', REQ],
    material: [STR, '재질'],
    vent_filter: [STR, '통기 필터'],
  }, ['TANK_LEVEL_LOW', 'TANK_OVERFLOW']),
  // 수소 감압·외부 반입
  assetClass('h2.prv', 'asset', null, '수소 감압밸브 스키드', {
    inlet_bar_max: [NUM, '최대 입구 압력 (bar)', REQ],
    outlet_bar_set: [NUM, '출구 설정 압력 (bar)', REQ],
    stages: [INT, '감압 단수'],
    class_ac: [STR, '조절 등급 (EN 334 AC)'],
    class_sg: [STR, '락업 등급 (EN 334 SG)'],
    min_dp_bar: [NUM, '안정 동작 최소 차압 (bar)'],
    downstream_volume_m3: [NUM, '하류 밀폐 체적 (m³)'], // 크리프율을 NL/min으로 바꾸는 분모
  }, ['OVERPRESSURE', 'PSV_RELEASE']),
  assetClass('h2.delivery', 'asset', null, '외부 수소 반입 설비', {
    design_bar: [NUM, '설계 압력 (bar)', REQ],
    meter_type: [STR, '계량기 형식'],
    meter_accuracy_pct: [NUM, '계량 정확도 (%)'],
    bank_present: [STR, '수용 뱅크 (installed/none)'],
    vent_stack: [STR, '방출관 (installed/none)'],
  }, ['H2_LEAK_L1', 'H2_LEAK_L2', 'GROUNDING_FAULT', 'ESD']),
  // 부산물 산소
  assetClass('o2.plant', 'system', null, '부산물 산소 계통', {
    o2_rated_nm3_h: [NUM, '정격 산소 생산량 (Nm³/h)', REQ],
    purity_grade: [STR, '순도 등급 (공업/의료)'],
  }, ['O2_ENRICHED_ATMOSPHERE', 'O2_PURITY_LOW', 'ESD']),
  assetClass('o2.storage.tank', 'asset', 'o2.plant', '산소 저장탱크', {
    water_volume_m3: [NUM, '내용적 (m³)', REQ],
    max_bar: [NUM, '최고 사용 압력 (bar)', REQ],
    pressure_basis: [STR, '압력 기준 (gauge/abs)', REQ], // 법정 저장능력 구분까지 달라진다
    design_temp_c: [NUM, '설계 온도 (°C)'],
    storage_capacity_m3: [NUM, '법정 저장능력 (m³)'],
  }, ['OVERPRESSURE', 'PSV_RELEASE', 'TANK_OVERTEMP']),
  assetClass('o2.loading', 'asset', 'o2.plant', '산소 출하 설비', {
    compressor_present: [STR, '승압 압축기 (installed/none)', REQ], // 없으면 트레일러 충전이 불가능하다
    loading_bar: [NUM, '출하 압력 (bar)'],
    meter_type: [STR, '계량기 형식'],
    meter_accuracy_pct: [NUM, '계량 정확도 (%)'],
  }, ['O2_ENRICHED_ATMOSPHERE', 'LOADING_INTERLOCK_TRIP']),
];

type Range = readonly [min: number, max: number];

interface MetricOptions {
  readonly hard?: Range;
  readonly expected?: Range;
  readonly flatlineS?: number;
  readonly aliases?: readonly string[];
}

function metric(
  key: string,
  nameKo: string,
  quantity: string,
  unit: string,
  valueKind: ValueKind,
  rollup: RollupKind,
  { hard, expected, flatlineS, aliases = [] }: MetricOptions = {},
): MetricDef {
  return {
    key,
    nameKo,
    quantity,
    unit,
    valueKind,
    rollup,
    hardMin: hard?.[0] ?? null,
    hardMax: hard?.[1] ?? null,
    expectedMin: expected?.[0] ?? null,
    expectedMax: expected?.[1] ?? null,
    flatlineMaxS: flatlineS ?? null,
    aliases,
  };
}

const SIX_HOURS_S = 6 * 3600; // 온도처럼 늘 조금씩 변하는 값의 고착 판정 기본값
const TWO_HOURS_S = 2 * 3600;
const G = 'gauge';
const C = 'counter';

/** 정규 단위: kW, kWh, V, A, °C, %, bar, kg/h, ppm, μS/cm 등. 무차원(상태 코드·횟수·역률)은 빈 문자열. */
export const METRIC_DEFS: readonly MetricDef[] = [
  // 기상
  // 일사량은 주간에 늘 변하므로 같은 값 2시간이면 고착 의심. 야간 0 근처 값은 고착 판정에서 뺀다 (lib/analytics/dq/summary.ts)
  metric('poa.irradiance', '경사면 일사량(POA)', 'irradiance', 'W/m²', G, 'avg', { hard: [-10, 1800], expected: [0, 1400], flatlineS: TWO_HOURS_S, aliases: ['POA', 'SunSpec 302 POA'] }),
  metric('ghi.irradiance', '수평면 전일사량(GHI)', 'irradiance', 'W/m²', G, 'avg', { hard: [-10, 1600], expected: [0, 1200], flatlineS: TWO_HOURS_S, aliases: ['GHI'] }),
  metric('module.temp', '모듈 후면 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 110], expected: [-20, 85], flatlineS: SIX_HOURS_S, aliases: ['SunSpec 303 TmpBOM'] }),
  metric('ambient.temp', '외기 온도', 'temperature', '°C', G, 'avg', { hard: [-50, 60], expected: [-25, 40], flatlineS: SIX_HOURS_S, aliases: ['TmpAmb'] }),
  metric('ambient.humidity', '외기 상대습도', 'humidity', '%', G, 'avg', { hard: [0, 100], expected: [10, 100], aliases: ['RH'] }),
  metric('wind.speed', '풍속', 'speed', 'm/s', G, 'avg', { hard: [0, 75], expected: [0, 30], aliases: ['WndSpd'] }),

  // 전력 공통 (인버터·PCS·정류기·계량기)
  metric('dc.voltage', '직류 전압', 'voltage', 'V', G, 'avg', { hard: [-10, 2000], aliases: ['DCV', 'V_DC'] }),
  metric('dc.current', '직류 전류', 'current', 'A', G, 'avg', { hard: [-5000, 5000], aliases: ['DCA', 'I_DC'] }),
  metric('dc.power', '직류 전력', 'power', 'kW', G, 'avg', { hard: [-10000, 10000], aliases: ['DCW', 'P_DC'] }),
  metric('string.current', '스트링 전류', 'current', 'A', G, 'avg', { hard: [-5, 30], expected: [0, 18], aliases: ['SunSpec 403 InDCA'] }),
  metric('ac.power', '교류 유효전력', 'power', 'kW', G, 'avg', { hard: [-10000, 10000], aliases: ['W', 'P_AC'] }),
  metric('ac.reactive.power', '교류 무효전력', 'reactive_power', 'kvar', G, 'avg', { hard: [-10000, 10000], aliases: ['VAr', 'Q_AC'] }),
  metric('ac.voltage', '교류 선간전압', 'voltage', 'V', G, 'avg', { hard: [0, 40000], aliases: ['PPVphAB', 'V_AC'] }),
  metric('ac.current', '교류 상전류', 'current', 'A', G, 'avg', { hard: [0, 10000], aliases: ['AphA', 'I_AC'] }),
  metric('ac.frequency', '계통 주파수', 'frequency', 'Hz', G, 'avg', { hard: [45, 65], expected: [59.8, 60.2], aliases: ['Hz', 'FREQ'] }),
  metric('ac.pf', '역률', 'power_factor', '', G, 'avg', { hard: [-1, 1], expected: [0.9, 1], aliases: ['PF'] }),
  metric('ac.power.limit', '출력 제한 설정값', 'ratio', '%', G, 'last', { hard: [0, 100], expected: [0, 100], aliases: ['WMaxLimPct'] }),
  metric('ac.energy.total', '누적 전력량', 'energy', 'kWh', C, 'delta', { hard: [0, 1e10], aliases: ['WH', 'E_TOTAL'] }),
  metric('ac.energy.export.total', '누적 송전 전력량', 'energy', 'kWh', C, 'delta', { hard: [0, 1e10], aliases: ['TotWhExp'] }),
  metric('ac.energy.import.total', '누적 수전 전력량', 'energy', 'kWh', C, 'delta', { hard: [0, 1e10], aliases: ['TotWhImp'] }),
  metric('ac.energy.charge.total', '누적 충전 전력량(AC)', 'energy', 'kWh', C, 'delta', { hard: [0, 1e10] }),
  metric('ac.energy.discharge.total', '누적 방전 전력량(AC)', 'energy', 'kWh', C, 'delta', { hard: [0, 1e10] }),
  metric('heatsink.temp', '방열판 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 150], expected: [-10, 85], flatlineS: SIX_HOURS_S, aliases: ['TmpSnk'] }),
  metric('insulation.resistance', '절연저항', 'resistance', 'kΩ', G, 'min', { hard: [0, 1e7], aliases: ['Riso', 'Ris'] }),

  // 운전 공통
  metric('op.state', '운전 상태 코드', 'state', '', 'state', 'last', { aliases: ['St', 'STATE'] }),
  metric('run.hours', '누적 운전시간', 'duration', 'h', C, 'last', { hard: [0, 1e6] }),
  metric('start.count', '누적 기동 횟수', 'count', '', C, 'last', { hard: [0, 1e7] }),

  // ESS
  metric('batt.soc', '충전상태(SOC)', 'state_of_charge', '%', G, 'avg', { hard: [0, 100], expected: [5, 95], aliases: ['SoC', 'SOC'] }),
  metric('batt.soh', '건강상태(SOH, BMS 보고)', 'state_of_health', '%', G, 'last', { hard: [0, 110], expected: [70, 100], aliases: ['SoH'] }),
  metric('batt.voltage', '배터리 전압', 'voltage', 'V', G, 'avg', { hard: [-10, 2000], aliases: ['SunSpec 802 V'] }),
  metric('batt.current', '배터리 전류(충전 +)', 'current', 'A', G, 'avg', { hard: [-3000, 3000], aliases: ['SunSpec 802 A'] }),
  metric('batt.current.limit.charge', '충전 전류 한계(CCL)', 'current', 'A', G, 'avg', { hard: [0, 5000], aliases: ['AChaMax', 'CCL'] }),
  metric('batt.current.limit.discharge', '방전 전류 한계(DCL)', 'current', 'A', G, 'avg', { hard: [0, 5000], aliases: ['ADisChaMax', 'DCL'] }),
  metric('cell.voltage.max', '최고 셀 전압', 'voltage', 'V', G, 'max', { hard: [-2, 5], aliases: ['CellVMax'] }),
  metric('cell.voltage.min', '최저 셀 전압', 'voltage', 'V', G, 'min', { hard: [-2, 5], aliases: ['CellVMin'] }),
  metric('cell.voltage.avg', '평균 셀 전압', 'voltage', 'V', G, 'avg', { hard: [-2, 5], aliases: ['CellVAvg'] }),
  metric('cell.temp.max', '최고 셀 온도', 'temperature', '°C', G, 'max', { hard: [-40, 120], expected: [10, 45], aliases: ['ModTmpMax'] }),
  metric('cell.temp.min', '최저 셀 온도', 'temperature', '°C', G, 'min', { hard: [-40, 120], expected: [10, 45], aliases: ['ModTmpMin'] }),
  metric('cell.temp.avg', '평균 셀 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 120], expected: [10, 40], flatlineS: SIX_HOURS_S, aliases: ['ModTmpAvg'] }),
  metric('room.temp', '배터리실 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 80], expected: [18, 30], flatlineS: SIX_HOURS_S }),
  metric('room.humidity', '배터리실 습도', 'humidity', '%', G, 'avg', { hard: [0, 100], expected: [30, 70] }),

  // 스택 공통 (전해조·연료전지)
  metric('stack.voltage', '스택 전압', 'voltage', 'V', G, 'avg', { hard: [-10, 3000] }),
  metric('stack.current', '스택 전류', 'current', 'A', G, 'avg', { hard: [-100, 20000] }),
  metric('stack.temp', '스택 온도(출구)', 'temperature', '°C', G, 'avg', { hard: [-40, 150], expected: [5, 85], flatlineS: SIX_HOURS_S }),
  metric('stack.temp.in', '스택 입구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 150], expected: [5, 85], flatlineS: SIX_HOURS_S }),
  metric('stack.pressure.diff', '스택 양극 차압', 'pressure', 'bar', G, 'avg', { hard: [-50, 50] }),

  // PEM 수전해
  metric('h2.flow.mass', '수소 질량유량', 'mass_flow', 'kg/h', G, 'avg', { hard: [-1, 5000] }),
  metric('h2.mass.total', '누적 수소 생산량', 'mass', 'kg', C, 'delta', { hard: [0, 1e9] }),
  metric('h2.pressure', '수소 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 1100] }),
  metric('h2.purity', '제품 수소 순도', 'purity', '%', G, 'avg', { hard: [0, 100], expected: [99.97, 100] }),
  metric('h2.in.o2', '산소 중 수소 농도(HTO)', 'concentration', '%', G, 'avg', { hard: [0, 100], expected: [0, 1], aliases: ['HTO'] }),
  metric('o2.in.h2', '수소 중 산소 농도(OTH)', 'concentration', 'ppm', G, 'avg', { hard: [0, 1e6], expected: [0, 5000], aliases: ['OTH'] }),
  metric('h2.dewpoint', '제품 수소 이슬점', 'dewpoint', '°C', G, 'avg', { hard: [-110, 60], expected: [-80, -60] }),
  metric('water.conductivity', '순수·냉각수 전도도', 'conductivity', 'μS/cm', G, 'avg', { hard: [0, 20000], expected: [0, 5] }),
  metric('water.flow', '순환수 유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 10000] }),
  metric('separator.level', '기액분리기 수위', 'level', '%', G, 'avg', { hard: [0, 100], expected: [20, 80] }),
  metric('rectifier.efficiency', '정류기 효율', 'efficiency', '%', G, 'avg', { hard: [0, 100], expected: [90, 99] }),

  // 수소 압축·저장·검지
  metric('compressor.power', '압축기 소비전력', 'power', 'kW', G, 'avg', { hard: [-1, 5000] }),
  metric('compressor.suction.pressure', '압축기 흡입 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 200], expected: [10, 40] }),
  metric('compressor.discharge.pressure', '압축기 최종 토출 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 1100], expected: [0, 500] }),
  metric('compressor.discharge.temp', '압축기 토출 가스 온도', 'temperature', '°C', G, 'max', { hard: [-40, 250], expected: [10, 135] }),
  metric('compressor.leak.pressure', '다이어프램 누설검지 압력', 'pressure', 'bar', G, 'max', { hard: [-1, 1100], expected: [0, 1] }),
  metric('vibration.rms', '진동 속도 RMS', 'velocity', 'mm/s', G, 'avg', { hard: [0, 200], expected: [0, 7.1] }),
  metric('tank.pressure', '저장용기 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 1100], expected: [0, 500] }),
  metric('tank.temp', '저장용기 온도', 'temperature', '°C', G, 'avg', { hard: [-60, 120], expected: [-40, 85], flatlineS: SIX_HOURS_S }),
  metric('h2.inventory', '수소 저장 재고(Z 보정)', 'mass', 'kg', G, 'last', { hard: [0, 1e6] }),
  metric('valve.open', '차단밸브 열림', 'state', '', 'bool', 'last'),
  metric('gas.detector.ppm', '수소 누출 검지 농도', 'concentration', 'ppm', G, 'max', { hard: [0, 1e6], expected: [0, 1000] }),

  // PEM 연료전지
  metric('fc.ac.power', '연료전지 순 AC 출력', 'power', 'kW', G, 'avg', { hard: [-100, 10000] }),
  metric('fc.h2.consumption', '연료전지 수소 소비 유량', 'mass_flow', 'kg/h', G, 'avg', { hard: [-1, 1000] }),
  metric('fc.coolant.temp.in', '스택 냉각수 입구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 120], expected: [5, 75], flatlineS: SIX_HOURS_S }),
  metric('fc.coolant.temp.out', '스택 냉각수 출구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 120], expected: [5, 85], flatlineS: SIX_HOURS_S }),
  metric('fc.coolant.flow', '스택 냉각수 유량', 'volume_flow', 'L/min', G, 'avg', { hard: [-1, 10000] }),
  metric('blower.power', '공기 블로워 소비전력', 'power', 'kW', G, 'avg', { hard: [-1, 1000] }),
  metric('blower.flow', '공기 질량유량', 'mass_flow', 'kg/h', G, 'avg', { hard: [-1, 100000] }),
  metric('purge.count', '애노드 퍼지 횟수(누적)', 'count', '', C, 'delta', { hard: [0, 1e9] }),

  // 부산물 산소 (가평 P&ID). 탱크 압력·온도는 tank.pressure·tank.temp에 qualifier 'o2'로 붙이고,
  // 산소 중 수소(HTO)는 기존 h2.in.o2를 쓴다 — 같은 물리량에 새 키를 만들지 않는다.
  metric('o2.purity', '제품 산소 순도', 'purity', '%', G, 'avg', { hard: [0, 100], expected: [99, 100], flatlineS: SIX_HOURS_S }),
  metric('o2.dewpoint', '제품 산소 이슬점', 'dewpoint', '°C', G, 'avg', { hard: [-110, 60], expected: [-60, -20], flatlineS: SIX_HOURS_S }),
  metric('o2.flow.mass', '산소 질량유량', 'mass_flow', 'kg/h', G, 'avg', { hard: [-1, 5000], expected: [0, 400] }),
  metric('o2.shipped.mass.total', '누적 산소 출하량', 'mass', 'kg', C, 'delta', { hard: [0, 1e9] }),
  metric('o2.loading.pressure', '산소 출하 헤더 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 300], expected: [0, 200] }),
  // 23.5% 초과는 산소 농축 대기(화재), 18% 미만은 질식
  metric('o2.detector.pct', '대기 산소 농도', 'concentration', '%', G, 'max', { hard: [0, 100], expected: [19.5, 23.5] }),

  // 폐열회수 열교환기
  metric('hx.temp.hot.in', '열교환기 1차측 입구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 200], expected: [30, 95], flatlineS: SIX_HOURS_S }),
  metric('hx.temp.hot.out', '열교환기 1차측 출구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 200], expected: [20, 90], flatlineS: SIX_HOURS_S }),
  metric('hx.temp.cold.in', '열교환기 2차측 입구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 150], expected: [0, 45], flatlineS: SIX_HOURS_S }),
  metric('hx.temp.cold.out', '열교환기 2차측 출구 온도', 'temperature', '°C', G, 'avg', { hard: [-40, 150], expected: [5, 80], flatlineS: SIX_HOURS_S }),
  metric('hx.flow.hot', '열교환기 1차측 유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 1000], expected: [0, 40] }),
  metric('hx.pressure.diff.hot', '열교환기 1차측 차압', 'pressure', 'kPa', G, 'avg', { hard: [-500, 2000], expected: [0, 150] }),
  metric('hx.pressure.diff.cold', '열교환기 2차측 차압', 'pressure', 'kPa', G, 'avg', { hard: [-500, 2000], expected: [0, 150] }),
  metric('hx.heat.recovered', '회수 열출력', 'power', 'kW', G, 'avg', { hard: [-100, 20000], expected: [0, 400] }),
  metric('hx.heat.total', '누적 회수 열량', 'energy', 'kWh', C, 'delta', { hard: [0, 1e9] }),

  // 수처리 (순수 제조·RO·물탱크). 지점별 전도도는 기존 water.conductivity에 qualifier로 붙인다.
  metric('water.flow.feed', '정제수 급수 유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 100], expected: [0, 2] }),
  metric('water.flow.recycle', '회수수 재순환 유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 100], expected: [0, 1] }),
  metric('water.volume.total', '누적 급수량', 'volume', 'm³', C, 'delta', { hard: [0, 1e7] }),
  metric('water.tank.level', '물탱크 수위', 'level', '%', G, 'avg', { hard: [0, 100], expected: [10, 95], flatlineS: SIX_HOURS_S }),
  // 아날로그 수위와 독립 채널이어야 계기 고착과 실제 수위 이상을 가른다
  metric('water.level.alarm', '물탱크 수위 스위치', 'state', '', 'bool', 'last'),
  metric('water.hardness', '경도 (as CaCO₃)', 'concentration', 'mg/L', G, 'avg', { hard: [0, 1000], expected: [0, 5] }),
  metric('ro.flow.permeate', 'RO 투과유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 100], expected: [0, 3] }),
  metric('ro.flow.reject', 'RO 농축수 유량', 'volume_flow', 'm³/h', G, 'avg', { hard: [-1, 100], expected: [0, 2] }),
  metric('ro.pressure.feed', 'RO 공급 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 100], expected: [5, 25] }),
  metric('ro.pressure.diff', 'RO 공급-농축 차압', 'pressure', 'bar', G, 'avg', { hard: [-1, 20], expected: [0, 3] }),
  metric('filter.pressure.diff', '필터 차압', 'pressure', 'bar', G, 'avg', { hard: [-1, 20], expected: [0, 1.5] }),
  metric('pump.power', '펌프 소비전력', 'power', 'kW', G, 'avg', { hard: [-1, 5000], expected: [0, 200] }),

  // 수소 감압·버퍼
  metric('h2.pressure.setpoint', '수소 압력 설정값', 'pressure', 'bar', G, 'last', { hard: [-1, 1100], expected: [0, 40] }),
  // PLC가 1초 표본으로 산출해야 한다 — 60초 샘플링으로는 헌팅을 원리상 볼 수 없다
  metric('h2.pressure.ripple', '수소 압력 리플(1분 P-P)', 'pressure', 'bar', G, 'max', { hard: [0, 100], expected: [0, 0.1] }),
  metric('vent.temp', '방출관 온도', 'temperature', '°C', G, 'avg', { hard: [-60, 200], expected: [-30, 60], flatlineS: SIX_HOURS_S }),

  // 외부 수소 반입 (하역)
  metric('h2.delivery.flow.mass', '수소 하역 질량유량', 'mass_flow', 'kg/h', G, 'avg', { hard: [-1, 5000], expected: [0, 600] }),
  metric('h2.delivery.mass.total', '누적 수소 반입량', 'mass', 'kg', C, 'delta', { hard: [0, 1e9] }),
  metric('h2.delivery.pressure', '하역 헤더 압력', 'pressure', 'bar', G, 'avg', { hard: [-1, 1100], expected: [0, 500] }),
  metric('h2.delivery.temp', '하역 가스 온도', 'temperature', '°C', G, 'avg', { hard: [-60, 150], expected: [-40, 60] }),
  metric('h2.delivery.state', '하역 상태 코드', 'state', '', 'state', 'last'),
  metric('h2.delivery.ground', '접지 연속성 양호', 'state', '', 'bool', 'last'),
  metric('h2.trailer.pressure', '트레일러 잔압', 'pressure', 'bar', G, 'avg', { hard: [-1, 1100], expected: [0, 500] }),
  metric('h2.vent.mass.total', '누적 수소 방출량', 'mass', 'kg', C, 'delta', { hard: [0, 1e9] }),
];

export const ASSET_CLASS_BY_KEY: ReadonlyMap<string, AssetClassDef> = new Map(ASSET_CLASSES.map((c) => [c.key, c]));
export const METRIC_DEF_BY_KEY: ReadonlyMap<string, MetricDef> = new Map(METRIC_DEFS.map((m) => [m.key, m]));

