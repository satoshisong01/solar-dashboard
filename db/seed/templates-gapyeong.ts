// 가평 2MW 청정수소발전 실사이트(GP-1) 설비·포인트 정의. 순수 데이터 모듈 ('server-only' 금지).
// 근거: 도면 FCND-GP-PID-002 REV.2 (2026-07-17)와 docs/renewal/research/pid/ 조사 결과.
// 규칙 세 가지:
//   1. 도면·조사에 있는 값만 넣는다. 미확인 명판은 추정값 대신 null이다 (벤더·설계사 회신 대기 표시).
//   2. 필수 명판이 미확인이라 분석이 돌 수 없는 설비(전해 스택·연료전지 스택·배터리 랙)는 만들지 않는다.
//      만들면 분석이 실행마다 NameplateError로 부분 실패한다. 벤더 명판이 오면 그때 추가한다.
//   3. 도면에 없는 계기는 포인트가 아니라 GAPYEONG_PLANNED_POINTS(미설치)로 둔다.
import type { AssetSpec, PointOptions } from './asset-spec';
import type { PlannedPointDef } from './types';

/** 도면 계장 태그가 붙은 포인트. 주기는 데이터 계약 값 그대로 쓴다 (가상 사이트의 60·300 규약과 다르다). */
const at = (tag: string, periodS: number, qualifier = ''): PointOptions => ({ tag, periodS, qualifier });

/**
 * 도면의 설비 트리. 명판 값은 도면 표기 그대로다.
 * 제외한 설비와 이유: 전해 스택·연료전지 스택(셀 수·활성면적·정격전류 미확인), ESS PCS·배터리 랙(정격·화학 미확인),
 * 기액분리기·건조기(설계압·형식 미확인), 스택 냉각계통(정격 유량 미확인 — TT-301은 열교환기 1차측 입구로 매핑),
 * 전처리·RO 유닛(구성 미확인 — 수처리 신설 요청 포인트는 순수 제조설비에 붙였다), 수소 검지기·기상관측(도면에 없음).
 */
export function gapyeongAssets(): readonly AssetSpec[] {
  return [
    {
      code: 'PV1',
      classKey: 'pv.plant',
      name: '태양광 발전설비',
      // 인버터 대수·정격이 도면에 없어 인버터 설비는 만들지 않는다
      nameplate: { dc_kwp: 1_500, ac_kw: null },
      criticality: 4,
    },
    {
      code: 'ESS1',
      classKey: 'ess.plant',
      name: 'ESS 설비',
      nameplate: { energy_kwh: 2_000, power_kw: null, chemistry: null },
      criticality: 4,
    },
    {
      code: 'ELZ1',
      classKey: 'h2.elz',
      name: 'PEM 수전해 설비',
      // 500 Nm³/h × 0.08988 kg/Nm³ = 44.9 kg/h. Nm³ 기준조건(0/15/20 °C)이 미확인이라 환산에 약 7% 불확실성이 있다.
      nameplate: { rated_kw: 2_500, technology: 'PEM', h2_rated_kg_h: 44.9, outlet_bar: 30, nm3_reference_c: null },
      criticality: 5,
      points: [['h2.flow.mass', 'F_H2', at('FT-201', 60, 'elz.out')]],
    },
    {
      code: 'ELZ1/RECT1',
      classKey: 'h2.elz.rectifier',
      name: '정류기',
      nameplate: { rated_dc_kw: 2_500, rated_ac_kva: null }, // 도면 DC 750 V
      criticality: 4,
    },
    {
      code: 'ELZ1/WTU1',
      classKey: 'h2.elz.water',
      name: '순수 제조설비',
      nameplate: { capacity_l_h: 500, feed_m3_h: 0.5, recycle_m3_h: 0.3, recycle_source: null },
      criticality: 4,
      points: [['water.flow.feed', 'F_FEED', at('FT-101', 60)]],
    },
    {
      code: 'ELZ1/WTU1/TANK1',
      classKey: 'h2.elz.water.tank',
      name: 'DI 물탱크',
      nameplate: { volume_m3: 20, material: null, vent_filter: null },
      criticality: 3,
      points: [['water.tank.level', 'LVL', at('LT-101', 60)]],
    },
    {
      code: 'H2BUF1',
      classKey: 'h2.storage.bank',
      name: '수소 버퍼탱크',
      // 30 bar·50 m³ ≈ 121.9 kg(30 °C, Z 보정). 저장이 아니라 55분 완충이다.
      nameplate: { tank_count: 1, water_volume_l: 50_000, max_bar: 30, usable_kg: null, pressure_basis: null, min_outlet_bar: null },
      criticality: 5,
      points: [['h2.pressure', 'P_BUF', at('PT-201', 60, 'buffer')]],
    },
    {
      code: 'H2BUF1/TANK1',
      classKey: 'h2.storage.tank',
      name: '버퍼 용기',
      nameplate: { water_volume_l: 50_000, max_bar: 30, vessel_type: null },
      criticality: 5,
    },
    {
      code: 'PRV1',
      classKey: 'h2.prv',
      name: '수소 감압밸브 스키드',
      nameplate: { inlet_bar_max: 30, outlet_bar_set: 0.8, stages: null, class_ac: null, class_sg: null, min_dp_bar: null, downstream_volume_m3: null },
      criticality: 5,
    },
    {
      code: 'FC1',
      classKey: 'fc.plant',
      name: 'PEM 연료전지 발전설비',
      nameplate: { rated_kw: 2_000, technology: 'PEMFC' }, // 스택 2기, DC 650 V
      criticality: 5,
      points: [
        ['h2.pressure', 'P_FC_IN', at('PT-202', 60, 'fc.inlet')],
        ['fc.h2.consumption', 'F_H2_FC', at('FT-301', 60)],
      ],
    },
    {
      code: 'FC1/HX1',
      classKey: 'hx.recovery',
      name: '폐열회수 열교환기 HX-301',
      nameplate: { duty_kw: 350, type: null, wall_type: null, plate_material: null, design_approach_k: null, design_ua_kw_k: null },
      criticality: 4,
      points: [
        // TT-301은 FC 냉각수 출구이자 1차측 입구다. 같은 계기를 두 포인트로 매핑하지 않으므로 여기를 정본으로 둔다.
        ['hx.temp.hot.in', 'T_HOT_IN', at('TT-301', 10)],
        ['hx.temp.hot.out', 'T_HOT_OUT', at('TT-302', 10)],
        // TT-303이 예열 전인지 후인지 미확정이다. 확정 전에는 수온(water.temp)으로 쓰지 않는다.
        ['hx.temp.cold.out', 'T_COLD_OUT', at('TT-303', 10)],
      ],
    },
    {
      code: 'FC1/PCS1',
      classKey: 'fc.pcs',
      name: '연료전지 PCS',
      nameplate: { power_kw: 2_500, ac_voltage_v: 380, dc_voltage_v: 650 },
      criticality: 4,
    },
    {
      code: 'MTR1',
      classKey: 'grid.meter',
      name: '계통 연계 계량기',
      nameplate: { voltage_v: 22_900, export_limit_kw: null },
      criticality: 4,
    },
    {
      code: 'O2P1',
      classKey: 'o2.plant',
      name: '부산물 산소 계통',
      nameplate: { o2_rated_nm3_h: 250, purity_grade: null },
      criticality: 3,
    },
    {
      code: 'O2P1/TANK1',
      classKey: 'o2.storage.tank',
      // 정격 생산 357 kg/h에 만재 637 kg — 체류 1.8시간이다.
      name: '산소 저장탱크',
      nameplate: { water_volume_m3: 30, max_bar: 15, pressure_basis: null, design_temp_c: null, storage_capacity_m3: null },
      criticality: 3,
      points: [['tank.pressure', 'P_O2', at('PT-401', 10, 'o2')]],
    },
    {
      code: 'O2P1/LOAD1',
      classKey: 'o2.loading',
      name: '산소 출하 설비',
      // 도면에 승압 압축기가 없다 — 현 설계로는 트레일러 충전이 불가능하고 생산 산소 대부분이 방출된다.
      nameplate: { compressor_present: 'none', loading_bar: null, meter_type: null, meter_accuracy_pct: null },
      criticality: 3,
    },
    {
      code: 'H2DLV1',
      classKey: 'h2.delivery',
      // 자급률 37%(생산 44.9 kg/h 대 소비 120.4 kg/h)라 반입이 필요한데 도면에는 설비가 없다. 신설 전제로 등록한다.
      name: '외부 수소 반입 설비',
      nameplate: { design_bar: null, meter_type: null, meter_accuracy_pct: null, bank_present: null, vent_stack: null },
      criticality: 5,
    },
  ];
}

const required = (instrumentTag: string | null, assetCode: string, metricKey: string, periodS: number, qualifier = ''): PlannedPointDef => ({
  instrumentTag,
  assetCode,
  metricKey,
  qualifier,
  periodS,
  necessity: 'required',
});

const recommended = (instrumentTag: string | null, assetCode: string, metricKey: string, periodS: number, qualifier = ''): PlannedPointDef => ({
  instrumentTag,
  assetCode,
  metricKey,
  qualifier,
  periodS,
  necessity: 'recommended',
});

/**
 * 계기 신설 요청 목록 (docs/renewal/data-contract-draft.md 부록 B). DB에 넣지 않는다 — 화면에 '미설치'로 보인다.
 * 태그는 문서가 제안한 값 그대로다. 한 계기가 두 신호를 내면(적산열량계·질량유량계) 같은 태그가 두 번 나온다.
 * 부록 B의 PT-202 스팬 재지정(0~40 → 0~4 bar)은 이미 있는 계기의 사양 변경이라 여기 넣지 않았다.
 */
export const GAPYEONG_PLANNED_POINTS: readonly PlannedPointDef[] = [
  // B.1 부산물 산소 — 산소 재고·회수율·법정 품질검사 확인에 필요하다
  required('AT-401', 'O2P1', 'h2.in.o2', 60, 'o2.product'), // 법정 압축금지선 2 vol% 감시 (애노드 원가스 = 산소 계통 쪽에 붙는다)
  required('AT-402', 'O2P1', 'o2.purity', 300), // 법정 1일 1회 99.5% 이상 확인
  required('AT-403', 'O2P1', 'o2.detector.pct', 5, 'vent'),
  recommended('FT-401', 'O2P1', 'o2.flow.mass', 10, 'production'),
  recommended('MT-401', 'O2P1', 'o2.dewpoint', 300),
  required('TT-401', 'O2P1/TANK1', 'tank.temp', 60, 'o2'), // 온도 없이는 압력→질량 환산이 불가능하다
  required('AT-403', 'O2P1/TANK1', 'o2.detector.pct', 5, 'tankroom'),
  required('XV-401', 'O2P1/TANK1', 'valve.open', 5, 'o2.vent'),
  required('FT-402', 'O2P1/LOAD1', 'o2.flow.mass', 10, 'loading'),
  required('FT-402', 'O2P1/LOAD1', 'o2.shipped.mass.total', 60),
  required('PT-402', 'O2P1/LOAD1', 'o2.loading.pressure', 10),
  required('AT-403', 'O2P1/LOAD1', 'o2.detector.pct', 5, 'loading'),
  required('XV-402', 'O2P1/LOAD1', 'valve.open', 5, 'o2.loading'),

  // B.2 폐열회수 HX-301 — 교차누설로부터 수전해 스택을 지키는 것이 먼저다
  required('CT-301', 'FC1/HX1', 'water.conductivity', 10, 'feed'),
  required('CT-302', 'FC1/HX1', 'water.conductivity', 10, 'feed.in'),
  required(null, 'FC1/HX1', 'water.volume.total', 300, 'hx.makeup'), // 보충수 카운터가 없으면 누설·용출 판별 자체가 불가능
  required('TT-304', 'FC1/HX1', 'hx.temp.cold.in', 10), // 도면에 없다. 회수 열량·UA 계산 전체가 이 값에 걸린다
  required('FT-302', 'FC1/HX1', 'hx.flow.hot', 10),
  required(null, 'FC1/HX1', 'hx.flow.cold', 10), // UA 판정의 2차측 유량 (FT-101과 같은 지점일 수 있다 — 확인 필요)
  recommended('FQ-301', 'FC1/HX1', 'hx.heat.recovered', 10),
  recommended('FQ-301', 'FC1/HX1', 'hx.heat.total', 60),
  recommended('PDT-301', 'FC1/HX1', 'hx.pressure.diff.hot', 10),
  recommended('PDT-302', 'FC1/HX1', 'hx.pressure.diff.cold', 10),

  // B.3 수처리 — 물수지 폐합과 소모품 상태 기반 관리
  required('CT-102', 'ELZ1/WTU1', 'water.conductivity', 10, 'product'),
  required('CT-101', 'ELZ1/WTU1', 'water.conductivity', 60, 'ro'),
  required('FT-102', 'ELZ1/WTU1', 'water.flow.recycle', 60),
  required('FQ-101', 'ELZ1/WTU1', 'water.volume.total', 300), // 원단위 KPI의 분자
  required('PT-101', 'ELZ1/WTU1', 'ro.pressure.feed', 60),
  required('PDT-101', 'ELZ1/WTU1', 'ro.pressure.diff', 60),
  required('FT-103', 'ELZ1/WTU1', 'ro.flow.permeate', 60),
  required('FT-104', 'ELZ1/WTU1', 'ro.flow.reject', 60),
  recommended('PDT-102', 'ELZ1/WTU1', 'filter.pressure.diff', 60, 'prefilter'),
  recommended('AT-101', 'ELZ1/WTU1', 'water.hardness', 86_400),
  recommended(null, 'ELZ1/WTU1', 'pump.power', 60, 'feed'),
  recommended(null, 'ELZ1/WTU1', 'pump.power', 60, 'loop'),
  recommended(null, 'ELZ1/WTU1', 'pump.power', 60, 'ro'),
  required('LS-101', 'ELZ1/WTU1/TANK1', 'water.level.alarm', 10, 'low'),
  required('LS-102', 'ELZ1/WTU1/TANK1', 'water.level.alarm', 10, 'high'),

  // B.4 감압·버퍼 — 수소 재고 환산과 조정기 시트 누설 판정
  required('TT-201', 'H2BUF1', 'tank.temp', 60, 'buffer.gas'), // 30 bar에서 1 °C = 102 mbar = 겉보기 0.41 kg
  recommended('TT-202', 'H2BUF1', 'tank.temp', 300, 'buffer.skin'),
  required(null, 'PRV1', 'h2.pressure.setpoint', 300),
  required(null, 'PRV1', 'h2.pressure.ripple', 60), // PLC가 1초 표본으로 산출해야 한다
  recommended('PDT-201', 'PRV1', 'filter.pressure.diff', 300, 'prv'),
  recommended('TT-501', 'PRV1', 'vent.temp', 300),

  // B.5 외부 수소 반입 — 이것이 없으면 물질수지 식 자체가 성립하지 않는다
  required('FT-501', 'H2DLV1', 'h2.delivery.flow.mass', 1), // 코리올리 ±0.5%
  required('FQ-501', 'H2DLV1', 'h2.delivery.mass.total', 60), // 원장 delivered 항의 1순위 소스
  required('PT-501', 'H2DLV1', 'h2.trailer.pressure', 60),
  required('PT-502', 'H2DLV1', 'h2.delivery.pressure', 5),
  required('TT-502', 'H2DLV1', 'h2.delivery.temp', 5),
  required(null, 'H2DLV1', 'h2.delivery.state', 5),
  required(null, 'H2DLV1', 'h2.delivery.ground', 5), // EIGA TB 51: 매 납품 접지 확인
  recommended('FT-502', 'H2DLV1', 'h2.vent.mass.total', 60),

  // B.9 전해조 퍼지 카운터 — 비에너지 상승(el.sec_rise)의 원인이 퍼지 손실인지 가르는 유일한 신호다.
  // 도면에 계기가 없고 계기를 새로 달 필요도 없다 — 전해조 PLC의 누적 카운터를 받으면 된다.
  recommended(null, 'ELZ1', 'purge.count', 300),
];
