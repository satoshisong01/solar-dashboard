// 태양광·ESS·사이트 공용 설비 템플릿. 순수 데이터 모듈 ('server-only' 금지).
import { FAST, MEGAOHM, MILLIVOLT, pad2, sequence, type AssetSpec, type PointSpec } from './asset-spec';

const INVERTER_POINTS: readonly PointSpec[] = [
  ['ac.power', 'P_AC', FAST],
  ['dc.power', 'P_DC', FAST],
  ['ac.energy.total', 'E_TOTAL'],
  ['ac.voltage', 'V_AC'],
  ['ac.current', 'I_AC'],
  ['ac.frequency', 'FREQ'],
  ['heatsink.temp', 'T_HS'],
  ['insulation.resistance', 'R_ISO', MEGAOHM],
  ['ac.power.limit', 'P_LIMIT'],
  ['op.state', 'STATE'],
];

const DC_INPUT_POINTS: readonly PointSpec[] = [
  ['dc.voltage', 'V_DC'],
  ['dc.current', 'I_DC'],
];

const MPPT_PER_INVERTER = 2;

/** withMppt가 false면 MPPT를 설비로 두지 않고 DC 전압·전류를 인버터에 매핑한다. */
export function pvPlant(dcKwp: number, inverterCount: number, withMppt: boolean): readonly AssetSpec[] {
  const inverterKwp = dcKwp / inverterCount;
  const plant: AssetSpec = {
    code: 'PV1',
    classKey: 'pv.plant',
    name: '태양광 발전설비',
    nameplate: { dc_kwp: dcKwp, ac_kw: dcKwp, module_wp: 550, tilt_deg: 30, azimuth_deg: 180 },
    criticality: 4,
  };

  const inverters = sequence(inverterCount).flatMap((i): AssetSpec[] => {
    const code = `PV1/INV${pad2(i)}`;
    const inverter: AssetSpec = {
      code,
      classKey: 'pv.inverter',
      name: `인버터 ${i}`,
      nameplate: { ac_kw: inverterKwp, dc_kwp: inverterKwp, mppt_count: MPPT_PER_INVERTER },
      criticality: 3,
      peer: true,
      points: withMppt ? INVERTER_POINTS : [...INVERTER_POINTS, ...DC_INPUT_POINTS],
    };
    const mppts = sequence(withMppt ? MPPT_PER_INVERTER : 0).map(
      (m): AssetSpec => ({
        code: `${code}/MPPT${m}`,
        classKey: 'pv.mppt',
        name: `인버터 ${i} MPPT ${m}`,
        nameplate: { dc_kwp: inverterKwp / MPPT_PER_INVERTER, strings: 12, modules_per_string: 19 },
        criticality: 2,
        peer: true,
        points: DC_INPUT_POINTS,
      }),
    );
    return [inverter, ...mppts];
  });

  return [plant, ...inverters];
}

const RACK_POINTS: readonly PointSpec[] = [
  ['batt.current', 'I_DC', FAST],
  ['batt.voltage', 'V_DC', FAST],
  ['batt.soc', 'SOC', FAST],
  ['batt.soh', 'SOH'],
  ['cell.voltage.max', 'V_CELL_MAX', { ...FAST, ...MILLIVOLT }],
  ['cell.voltage.min', 'V_CELL_MIN', { ...FAST, ...MILLIVOLT }],
  ['cell.voltage.avg', 'V_CELL_AVG', { ...FAST, ...MILLIVOLT }],
  ['cell.temp.max', 'T_CELL_MAX', FAST],
  ['cell.temp.min', 'T_CELL_MIN', FAST],
  ['cell.temp.avg', 'T_CELL_AVG', FAST],
];

/** 랙 1개 = LFP 260S2P(300 Ah 셀), 832 V · 600 Ah ≈ 500 kWh */
export function essPlant(energyKwh: number, powerKw: number, rackCount: number): readonly AssetSpec[] {
  const racks = sequence(rackCount).map(
    (i): AssetSpec => ({
      code: `ESS1/RACK${pad2(i)}`,
      classKey: 'ess.rack',
      name: `배터리 랙 ${i}`,
      nameplate: {
        energy_kwh: energyKwh / rackCount,
        capacity_ah: 600,
        nominal_v: 832,
        cells_series: 260,
        cells_parallel: 2,
        chemistry: 'LFP',
      },
      criticality: 4,
      peer: true,
      points: RACK_POINTS,
    }),
  );

  return [
    {
      code: 'ESS1',
      classKey: 'ess.plant',
      name: 'ESS 설비',
      nameplate: { energy_kwh: energyKwh, power_kw: powerKw, chemistry: 'LFP', rack_count: rackCount },
      criticality: 4,
      points: [
        ['room.temp', 'T_ROOM'],
        ['room.humidity', 'RH_ROOM'],
        ['batt.current.limit.charge', 'CCL'],
        ['batt.current.limit.discharge', 'DCL'],
        ['insulation.resistance', 'R_ISO'],
      ],
    },
    {
      code: 'ESS1/PCS1',
      classKey: 'ess.pcs',
      name: 'ESS PCS',
      nameplate: { power_kw: powerKw },
      criticality: 4,
      points: [
        ['ac.power', 'P_AC'],
        ['dc.power', 'P_DC'],
        ['ac.energy.charge.total', 'E_CHG'],
        ['ac.energy.discharge.total', 'E_DCHG'],
        ['heatsink.temp', 'T_HS'],
        ['op.state', 'STATE'],
      ],
    },
    ...racks,
  ];
}

/** 기상관측 1 + 계통 연계 계량기 1 */
export function siteCommon(exportLimitKw: number): readonly AssetSpec[] {
  return [
    {
      code: 'WX1',
      classKey: 'wx.station',
      name: '기상관측 설비',
      nameplate: { poa_tilt_deg: 30 },
      criticality: 2,
      points: [
        ['poa.irradiance', 'POA'],
        ['ghi.irradiance', 'GHI'],
        ['module.temp', 'T_MOD'],
        ['ambient.temp', 'T_AMB'],
        ['ambient.humidity', 'RH'],
        ['wind.speed', 'WS'],
      ],
    },
    {
      code: 'MTR1',
      classKey: 'grid.meter',
      name: '계통 연계 계량기',
      nameplate: { voltage_v: 22_900, export_limit_kw: exportLimitKw },
      criticality: 3,
      points: [
        ['ac.power', 'P_NET'],
        ['ac.energy.export.total', 'E_EXP'],
        ['ac.energy.import.total', 'E_IMP'],
        ['ac.voltage', 'V_AC'],
        ['ac.frequency', 'FREQ'],
      ],
    },
  ];
}
