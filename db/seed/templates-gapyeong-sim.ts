// SIM-D (가평 복제) 설비 템플릿. 순수 데이터 모듈 ('server-only' 금지).
//
// 왜 실사이트 GP-1이 아니라 가상 사이트인가
//   GP-1은 도면에 있는 값만 시드하고 미확인 명판은 null로 둔다 (db/seed/templates-gapyeong.ts). 전해 스택·연료전지 스택의
//   셀 수·활성면적·정격전류가 미확인이라 물리 모델을 돌릴 수 없고, 실사이트에 추정값을 넣으면 시드가 도면과 어긋난다.
//   그래서 같은 규모·같은 계통 구성을 가진 가상 사이트를 따로 두고, 시뮬레이터는 여기에만 데이터를 넣는다.
//
// 명판 출처 표시
//   [도면] FCND-GP-PID-002 REV.2에 있는 값 그대로.
//   [가정] 도면에 없어 시뮬레이터가 물리 모델을 돌리기 위해 정한 값. 실사이트 시드에는 넣지 않는다.
import type { AssetSpec } from './asset-spec';
import { electrolyzerPlant, fuelCellPlant, hydrogenStorage, type ElectrolyzerSpecOptions, type FuelCellSpecOptions, type StorageSpecOptions } from './templates-hydrogen';
import { essPlant, pvPlant, siteCommon } from './templates-solar';

/**
 * 전해조 2.5 MW / 500 Nm³/h (= 44.9 kg/h) / 30 bar [도면].
 * 스택 값은 [가정]이다: DC 750 V [도면]를 셀 전압 1.99 V로 나눠 377셀, 정격 전류는 패러데이 원단위로 44.9 kg/h가 나오게 잡았다
 * (377 × 3,167 A × 3.7608e-5 kg/(A·h) = 44.9 kg/h). 전류밀도는 약 2 A/cm²로 PEM 상용 범위 안이다.
 */
const GAPYEONG_ELZ: ElectrolyzerSpecOptions = {
  ratedKw: 2_500,
  h2RatedKgH: 44.9,
  outletBar: 30,
  cellCount: 377,
  activeAreaCm2: 1_600,
  ratedCurrentA: 3_167,
  stackDcKw: 2_375,
  rectifierDcKw: 2_500,
  rectifierKva: 2_800,
  waterCapacityLH: 500,
  feedM3H: 0.5,
  recycleM3H: 0.3,
  nm3ReferenceC: 0,
  // PEM 턴다운 10% [가정] — 1.5 MWp 태양광으로 2.5 MW 전해조를 돌리려면 최소부하가 낮아야 한다 (상용 PEM 10~20%)
  minLoadFraction: 0.1,
};

/**
 * 수소 버퍼 50 m³ · 30 bar [도면] — 저장이 아니라 55분 완충이다.
 * 인출 하한 2 bar와 압축기는 [가정]이다: 도면에 승압 압축기가 없지만(전해조 출구가 이미 30 bar) 저장부 모델이 압축기 설비를
 * 요구하므로 압력비 1에 가까운 이송기로 둔다 — 소비 전력이 사실상 0이라 에너지 원장에 영향이 없다.
 */
const GAPYEONG_BUFFER: StorageSpecOptions = {
  tankCount: 1,
  tankWaterVolumeL: 50_000,
  maxBar: 30,
  minOutletBar: 2,
  usableKg: 103,
  vesselType: 'Type I',
  compressorKw: 15,
  compressorCapacityKgH: 60,
  compressorSuctionBar: 30,
  compressorDischargeBar: 30,
};

/**
 * 연료전지 2.0 MW [도면] (도면은 스택 2기지만 모델은 스택 1기로 합쳐 본다 [가정]).
 * 스택 값 [가정]: DC 650 V [도면]을 셀 전압 0.65 V로 나눠 1,000셀, 정격 전류는 수소 소비 1,340 Nm³/h (= 120.4 kg/h) [도면]에 맞췄다
 * (1,000 × 3,240 A × 3.7608e-5 = 121.8 kg/h).
 */
const GAPYEONG_FC: FuelCellSpecOptions = {
  ratedKw: 2_000,
  cellCount: 1_000,
  activeAreaCm2: 5_000,
  ratedCurrentA: 3_240,
  blowerKw: 150,
  coolantLpm: 2_000,
};

/** 부산물 산소 · 폐열회수 · DI 물탱크 · 감압밸브 · 외부 반입 (가평 구성에만 있는 계통) */
function gapyeongSubsystems(): readonly AssetSpec[] {
  return [
    {
      code: 'ELZ1/WTU1/TANK1',
      classKey: 'h2.elz.water.tank',
      name: 'DI 물탱크',
      nameplate: { volume_m3: 20, material: 'PE', vent_filter: 'installed' }, // 내용적 20 m³ [도면]
      criticality: 3,
      points: [
        ['water.tank.level', 'LVL'],
        ['water.level.alarm', 'LS_LOW', { qualifier: 'low' }],
        ['water.level.alarm', 'LS_HIGH', { qualifier: 'high' }],
      ],
    },
    {
      code: 'PRV1',
      classKey: 'h2.prv',
      name: '수소 감압밸브 스키드',
      // 30 → 0.8 bar [도면]. 단수·등급·하류 체적은 [가정] (EN 334 AC 10 / SG 10, 하류 0.5 m³)
      nameplate: { inlet_bar_max: 30, outlet_bar_set: 0.8, stages: 1, class_ac: 'AC10', class_sg: 'SG10', min_dp_bar: 0.5, downstream_volume_m3: 0.5 },
      criticality: 5,
      points: [
        ['h2.pressure', 'P_OUT', { qualifier: 'fc.inlet' }],
        ['h2.pressure.setpoint', 'P_SET'],
        ['h2.pressure.ripple', 'P_RIPPLE'],
        ['filter.pressure.diff', 'DP_FILTER', { qualifier: 'prv' }],
        ['vent.temp', 'T_VENT'],
      ],
    },
    {
      code: 'FC1/HX1',
      classKey: 'hx.recovery',
      name: '폐열회수 열교환기 HX-301',
      // 설계 회수 350 kWth [도면]. UA·접근온도는 [가정] — 급수 0.5 m³/h를 15 → 55 °C로 올리는 데 필요한 23.3 kW에서 역산했다
      nameplate: { duty_kw: 350, type: 'plate', wall_type: 'double', plate_material: '316L', design_approach_k: 20, design_ua_kw_k: 0.76 },
      criticality: 4,
      points: [
        ['hx.temp.hot.in', 'T_HOT_IN'],
        ['hx.temp.hot.out', 'T_HOT_OUT'],
        ['hx.temp.cold.in', 'T_COLD_IN'],
        ['hx.temp.cold.out', 'T_COLD_OUT'],
        ['hx.flow.hot', 'F_HOT'],
        ['hx.flow.cold', 'F_COLD'],
        ['hx.heat.recovered', 'Q'],
        ['hx.heat.total', 'Q_TOTAL'],
        ['hx.pressure.diff.hot', 'DP_HOT'],
        ['hx.pressure.diff.cold', 'DP_COLD'],
        ['water.conductivity', 'COND_FEED', { qualifier: 'feed' }],
        ['water.conductivity', 'COND_FEED_IN', { qualifier: 'feed.in' }],
      ],
    },
    {
      code: 'O2P1',
      classKey: 'o2.plant',
      name: '부산물 산소 계통',
      nameplate: { o2_rated_nm3_h: 250, purity_grade: '공업' }, // 250 Nm³/h [도면] = 약 357 kg/h
      criticality: 3,
      points: [
        ['o2.flow.mass', 'F_O2', { qualifier: 'production' }],
        ['o2.purity', 'PURITY'],
        ['o2.dewpoint', 'DEWPOINT'],
        ['o2.detector.pct', 'O2_VENT', { qualifier: 'vent' }],
        ['h2.in.o2', 'HTO', { qualifier: 'o2.product' }],
      ],
    },
    {
      code: 'O2P1/TANK1',
      classKey: 'o2.storage.tank',
      // 30 m³ · 15 bar [도면] → 만재 약 590 kg, 정격 생산 357 kg/h에 체류 1.8시간
      nameplate: { water_volume_m3: 30, max_bar: 15, pressure_basis: 'gauge', design_temp_c: 50, storage_capacity_m3: 480 },
      name: '산소 저장탱크',
      criticality: 3,
      points: [
        ['tank.pressure', 'P_O2', { qualifier: 'o2' }],
        ['tank.temp', 'T_O2', { qualifier: 'o2' }],
        ['valve.open', 'XV_VENT', { qualifier: 'o2.vent' }],
        ['o2.detector.pct', 'O2_ROOM', { qualifier: 'tankroom' }],
      ],
    },
    {
      code: 'O2P1/LOAD1',
      classKey: 'o2.loading',
      name: '산소 출하 설비',
      // 도면에 승압 압축기가 없다 [도면] — 트레일러(150~200 bar) 충전이 불가능해 만재 뒤 생산분은 방출된다
      nameplate: { compressor_present: 'none', loading_bar: 15, meter_type: 'coriolis', meter_accuracy_pct: 0.5 },
      criticality: 3,
      points: [
        ['o2.shipped.mass.total', 'M_SHIP'],
        ['o2.loading.pressure', 'P_LOAD'],
        ['o2.flow.mass', 'F_LOAD', { qualifier: 'loading' }],
        ['valve.open', 'XV_LOAD', { qualifier: 'o2.loading' }],
        ['o2.detector.pct', 'O2_LOAD', { qualifier: 'loading' }],
      ],
    },
    {
      code: 'H2DLV1',
      classKey: 'h2.delivery',
      name: '외부 수소 반입 설비',
      // 도면에 반입 설비가 없다 — 자급률 37%라 반입이 전제인데 하역 패널·계량기·벤트스택이 그려져 있지 않다 [research-supply §0]
      nameplate: { design_bar: 250, meter_type: 'coriolis', meter_accuracy_pct: 0.5, bank_present: 'none', vent_stack: 'installed' },
      criticality: 5,
      points: [
        ['h2.delivery.mass.total', 'M_TOTAL'],
        ['h2.delivery.flow.mass', 'F_DLV'],
        ['h2.delivery.pressure', 'P_HDR'],
        ['h2.delivery.temp', 'T_DLV'],
        ['h2.delivery.state', 'STATE'],
        ['h2.delivery.ground', 'GROUND'],
        ['h2.trailer.pressure', 'P_TRL'],
        ['h2.vent.mass.total', 'M_VENT'],
      ],
    },
  ];
}

/** 가평 구성 가상 사이트: PV 1.5 MWp + ESS 2 MWh + 전해조 2.5 MW + 버퍼 50 m³ + 연료전지 2 MW + 부속 계통 */
export function gapyeongSimAssets(): readonly AssetSpec[] {
  return [
    ...pvPlant(1_500, 3, false),
    ...essPlant(2_000, 1_000, 4),
    ...electrolyzerPlant(GAPYEONG_ELZ),
    ...hydrogenStorage(GAPYEONG_BUFFER),
    ...fuelCellPlant(GAPYEONG_FC),
    ...gapyeongSubsystems(),
    ...siteCommon(2_000),
  ];
}
