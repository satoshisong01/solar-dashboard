// 가평 2MW 청정수소발전 공정도(P&ID) 배치. 순수 데이터 모듈 ('server-only' 금지).
//
// 근거: 도면 FCND-GP-PID-002 REV.2 (2026-07-17, 1498 × 656 pt) 벡터 추출 결과.
//   - 설비 상자·계장 버블·흐름선의 상대 위치와 꺾임 순서는 PDF 도형 좌표를 그대로 옮겼다.
//     (PDF 좌표 → 이 파일: 도면틀 왼쪽 위 (236, 12)를 원점으로 옮기고, 값이 들어갈 만큼 상자만 넓혔다)
//   - 흐름선 색 구분은 도면 LINE LEGEND 그대로다 (lib/diagram/flow-kinds.ts).
//   - 표시·강조 규칙은 docs/renewal/pid-gapyeong-plan.md §7을 따른다.
//
// 이 파일에는 **측정값도 명판 수치도 넣지 않는다**. 상자에 적히는 용량은 om.asset.nameplate에서 읽고
// 값은 om.measurement에서 읽는다. 여기 있는 것은 좌표와 "무엇을 어디서 읽을지"뿐이다.
import type { FlowKind } from './flow-kinds';

/** SVG 좌표계 */
export const DIAGRAM_VIEWBOX = Object.freeze({ width: 1320, height: 600 });

/** 도면 표제란 */
export const DRAWING = Object.freeze({
  number: 'FCND-GP-PID-002',
  revision: 'REV.2',
  date: '2026-07-17',
  title: '가평 2MW 청정수소발전 시스템 공정흐름 · 계장도',
});

export type ReadoutAgg = 'first' | 'sum' | 'avg';

/** 읽을 포인트 후보. `metricKey` 또는 `metricKey@qualifier` 형식이고 앞에 적은 것이 먼저다 */
export interface ReadoutDef {
  readonly label: string;
  readonly sources: readonly string[];
  readonly agg: ReadoutAgg;
}

/** 상자에 적을 명판 항목. unit은 설비 종류 스키마 제목에 적힌 단위와 같아야 한다 (gapyeong-layout.test.ts가 검사) */
export interface CapacityDef {
  readonly key: string;
  readonly unit: string;
}

export interface NodeDef {
  readonly id: string;
  /** 사이트에서 이 상자에 해당하는 설비를 찾는 열쇠 */
  readonly classKey: string;
  /** 도면 표기 이름 (DB에 설비가 있으면 DB 이름을 쓴다) */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly capacity: readonly CapacityDef[];
  readonly readouts: readonly ReadoutDef[];
  /** 도면에 없는 설비라는 등의 단서 */
  readonly note?: string;
}

export type Vertex = readonly [x: number, y: number];

export interface PipeDef {
  readonly id: string;
  readonly kind: FlowKind;
  /** 꺾은선 꼭짓점. 마지막 점에 화살표가 붙는다 */
  readonly points: readonly Vertex[];
  /** 도면에 적힌 문구 그대로 */
  readonly label?: string;
  readonly labelAt?: Vertex;
  readonly labelAnchor?: 'start' | 'middle' | 'end';
  /** 도면에 없는 신설 전제 배관 */
  readonly proposed?: boolean;
}

export interface TagDef {
  /** 도면 계장 태그 (예: PT-201) */
  readonly tag: string;
  /** 이 태그가 걸린 설비 상자 */
  readonly nodeId: string;
  readonly cx: number;
  readonly cy: number;
  /** 버블 → 배관 연결선 */
  readonly stub: readonly [x1: number, y1: number, x2: number, y2: number];
  /** 값 글자 위치 (버블 중심 기준 상대 좌표) */
  readonly valueDx: number;
  readonly valueDy: number;
  readonly valueAnchor: 'start' | 'middle' | 'end';
  /** 계장 태그가 om.point에 기록되지 않은 사이트에서 같은 자리를 읽을 후보 */
  readonly sources: readonly string[];
  /** 도면과 데이터 계약이 다를 때의 단서 */
  readonly note?: string;
}

export const TAG_RADIUS = 19;

/**
 * 설비 상자. 도면의 좌→우 공정 순서(물·전력 → 수전해 → 버퍼 → 감압 → 연료전지 → 계통)와
 * 위쪽 산소 계통 · 아래쪽 폐열·물 계통 배치를 그대로 지킨다.
 */
export const NODES: readonly NodeDef[] = [
  {
    id: 'wtu',
    classKey: 'h2.elz.water',
    label: '순수 제조설비',
    x: 14,
    y: 96,
    w: 150,
    h: 76,
    capacity: [{ key: 'capacity_l_h', unit: 'L/h' }],
    readouts: [
      { label: '급수 유량', sources: ['water.flow.feed', 'water.flow'], agg: 'first' },
      { label: '순수 전도도', sources: ['water.conductivity@product'], agg: 'first' },
    ],
  },
  {
    id: 'tank',
    classKey: 'h2.elz.water.tank',
    label: 'DI 물탱크',
    x: 24,
    y: 250,
    w: 116,
    h: 110,
    capacity: [{ key: 'volume_m3', unit: 'm³' }],
    readouts: [{ label: '수위', sources: ['water.tank.level'], agg: 'first' }],
  },
  {
    id: 'hx',
    classKey: 'hx.recovery',
    label: '폐열회수 열교환기 HX-301',
    x: 180,
    y: 140,
    w: 150,
    h: 96,
    capacity: [{ key: 'duty_kw', unit: 'kWth' }],
    readouts: [
      { label: '1차측 입구', sources: ['hx.temp.hot.in'], agg: 'first' },
      { label: '1차측 출구', sources: ['hx.temp.hot.out'], agg: 'first' },
      { label: '회수 열출력', sources: ['hx.heat.recovered'], agg: 'first' },
    ],
  },
  {
    id: 'elz',
    classKey: 'h2.elz',
    label: 'PEM 수전해 설비',
    x: 360,
    y: 250,
    w: 144,
    h: 110,
    capacity: [
      { key: 'rated_kw', unit: 'kW' },
      { key: 'h2_rated_kg_h', unit: 'kg/h' },
    ],
    readouts: [
      { label: '수소 생산', sources: ['h2.flow.mass@elz.out', 'h2.flow.mass'], agg: 'first' },
      { label: '소비 전력', sources: ['ac.power'], agg: 'first' },
      { label: '출구 압력', sources: ['h2.pressure'], agg: 'first' },
    ],
  },
  {
    id: 'o2p',
    classKey: 'o2.plant',
    label: '부산물 산소 계통',
    x: 360,
    y: 24,
    w: 140,
    h: 86,
    capacity: [{ key: 'o2_rated_nm3_h', unit: 'Nm³/h' }],
    readouts: [
      { label: '산소 생산', sources: ['o2.flow.mass@production'], agg: 'first' },
      { label: '순도', sources: ['o2.purity'], agg: 'first' },
      { label: '산소 중 수소', sources: ['h2.in.o2@o2.product'], agg: 'first' },
    ],
  },
  {
    id: 'o2tank',
    classKey: 'o2.storage.tank',
    label: '산소 저장탱크',
    x: 566,
    y: 24,
    w: 140,
    h: 86,
    capacity: [
      { key: 'water_volume_m3', unit: 'm³' },
      { key: 'max_bar', unit: 'bar' },
    ],
    readouts: [
      { label: '압력', sources: ['tank.pressure@o2'], agg: 'first' },
      { label: '온도', sources: ['tank.temp@o2'], agg: 'first' },
    ],
  },
  {
    id: 'o2load',
    classKey: 'o2.loading',
    label: '산소 출하 설비',
    x: 772,
    y: 24,
    w: 148,
    h: 86,
    capacity: [{ key: 'loading_bar', unit: 'bar' }],
    readouts: [
      { label: '출하 압력', sources: ['o2.loading.pressure'], agg: 'first' },
      { label: '출하 유량', sources: ['o2.flow.mass@loading'], agg: 'first' },
    ],
  },
  {
    id: 'buffer',
    classKey: 'h2.storage.bank',
    label: '수소 버퍼탱크',
    x: 588,
    y: 250,
    w: 114,
    h: 110,
    capacity: [
      { key: 'water_volume_l', unit: 'L' },
      { key: 'max_bar', unit: 'bar' },
    ],
    readouts: [
      { label: '압력', sources: ['h2.pressure@buffer', 'tank.pressure'], agg: 'first' },
      { label: '재고', sources: ['h2.inventory'], agg: 'first' },
    ],
  },
  {
    id: 'prv',
    classKey: 'h2.prv',
    label: '수소 감압밸브 스키드',
    x: 740,
    y: 262,
    w: 108,
    h: 86,
    capacity: [
      { key: 'inlet_bar_max', unit: 'bar' },
      { key: 'outlet_bar_set', unit: 'bar' },
    ],
    readouts: [
      { label: '출구 압력', sources: ['h2.pressure@fc.inlet'], agg: 'first' },
      { label: '설정 압력', sources: ['h2.pressure.setpoint'], agg: 'first' },
    ],
  },
  {
    id: 'fc',
    classKey: 'fc.plant',
    label: 'PEM 연료전지 발전설비',
    x: 880,
    y: 250,
    w: 144,
    h: 110,
    capacity: [{ key: 'rated_kw', unit: 'kW' }],
    readouts: [
      { label: 'AC 출력', sources: ['fc.ac.power'], agg: 'first' },
      { label: '수소 소비', sources: ['fc.h2.consumption'], agg: 'first' },
    ],
  },
  {
    id: 'pcs',
    classKey: 'fc.pcs',
    label: '연료전지 PCS',
    x: 1068,
    y: 254,
    w: 100,
    h: 102,
    capacity: [{ key: 'power_kw', unit: 'kW' }],
    readouts: [
      { label: 'AC 출력', sources: ['ac.power'], agg: 'first' },
      { label: 'DC 입력', sources: ['dc.power'], agg: 'first' },
    ],
  },
  {
    id: 'meter',
    classKey: 'grid.meter',
    label: '계통 연계 계량기',
    x: 1200,
    y: 254,
    w: 100,
    h: 102,
    capacity: [{ key: 'voltage_v', unit: 'V' }],
    readouts: [{ label: '계통 전력', sources: ['ac.power'], agg: 'first' }],
  },
  {
    id: 'pv',
    classKey: 'pv.plant',
    label: '태양광 발전설비',
    x: 48,
    y: 492,
    w: 128,
    h: 78,
    capacity: [{ key: 'dc_kwp', unit: 'kWp' }],
    readouts: [{ label: 'AC 출력 합', sources: ['ac.power'], agg: 'sum' }],
  },
  {
    id: 'ess',
    classKey: 'ess.plant',
    label: 'ESS 설비',
    x: 260,
    y: 492,
    w: 128,
    h: 78,
    capacity: [{ key: 'energy_kwh', unit: 'kWh' }],
    readouts: [
      { label: 'SOC 평균', sources: ['batt.soc'], agg: 'avg' },
      { label: '충·방전 전력', sources: ['ac.power'], agg: 'sum' },
    ],
  },
  {
    id: 'dlv',
    classKey: 'h2.delivery',
    label: '외부 수소 반입 설비',
    x: 1044,
    y: 448,
    w: 160,
    h: 92,
    capacity: [{ key: 'design_bar', unit: 'bar' }],
    readouts: [
      { label: '하역 유량', sources: ['h2.delivery.flow.mass'], agg: 'first' },
      { label: '하역 압력', sources: ['h2.delivery.pressure'], agg: 'first' },
    ],
    // 자급률 37%(생산 44.9 kg/h 대 소비 120.4 kg/h)라 반입이 전제인데 도면에 하역 설비가 그려져 있지 않다
    note: '도면 미기재 · 신설 전제',
  },
];

/** 흐름선. 도면의 꺾임 순서를 그대로 옮겼고, 라벨은 도면 표기 그대로다 */
export const PIPES: readonly PipeDef[] = [
  { id: 'wtu.tank', kind: 'water.feed', points: [[82, 172], [82, 250]] },
  { id: 'tank.hx', kind: 'water.feed', points: [[140, 305], [160, 305], [160, 188], [180, 188]], label: '정제수 0.5 m³/h', labelAt: [166, 274] },
  // 도면의 '예열 급수 55 °C' 문구는 넣지 않는다 — 같은 배관에 TT-303 버블이 붙어 실측 온도를 보여 주고, 두 글자가 겹친다
  { id: 'hx.elz', kind: 'water.feed', points: [[330, 204], [396, 204], [396, 250]] },
  { id: 'fc.hx', kind: 'heat.supply', points: [[952, 250], [952, 170], [330, 170]], label: '폐열 온수 75 °C · 350 kWth', labelAt: [740, 163] },
  { id: 'hx.fc', kind: 'heat.return', points: [[255, 236], [255, 418], [900, 418], [900, 360]], label: '환수 60 °C', labelAt: [520, 411] },
  { id: 'fc.tank', kind: 'water.recycle', points: [[960, 360], [960, 442], [82, 442], [82, 360]], label: '회수수 0.3 m³/h (재순환)', labelAt: [520, 435] },
  { id: 'elz.o2p', kind: 'o2', points: [[430, 250], [430, 110]] },
  { id: 'o2p.o2tank', kind: 'o2', points: [[500, 67], [566, 67]] },
  { id: 'o2tank.o2load', kind: 'o2', points: [[706, 67], [772, 67]], label: '출하', labelAt: [739, 57], labelAnchor: 'middle' },
  { id: 'elz.buffer', kind: 'h2', points: [[504, 305], [588, 305]], label: 'H₂ 500 Nm³/h', labelAt: [508, 330] },
  { id: 'buffer.prv', kind: 'h2', points: [[702, 305], [740, 305]] },
  { id: 'prv.fc', kind: 'h2', points: [[848, 305], [880, 305]] },
  {
    // 도면에 없다. 반입 수소는 연료전지 소비 부족분을 메우므로 연료전지 수소 헤더로 들어가는 것으로 그린다.
    id: 'dlv.fc',
    kind: 'h2',
    points: [[1124, 448], [1124, 420], [1004, 420], [1004, 360]],
    label: '외부 반입 (도면 미기재)',
    labelAt: [1064, 412],
    labelAnchor: 'middle',
    proposed: true,
  },
  { id: 'pv.ess', kind: 'dc', points: [[176, 531], [260, 531]], label: 'DC 1,500 kW', labelAt: [218, 520], labelAnchor: 'middle' },
  { id: 'ess.elz', kind: 'dc', points: [[388, 531], [468, 531], [468, 360]], label: '수전해 전력 평활', labelAt: [324, 484], labelAnchor: 'middle' },
  { id: 'pcs.elz', kind: 'dc', points: [[1118, 356], [1118, 396], [404, 396], [404, 360]], label: 'DC 2,500 kW · 750 V (수전해 충전)', labelAt: [560, 389] },
  { id: 'fc.pcs', kind: 'dc', points: [[1024, 305], [1068, 305]], label: 'DC 2,000 kW', labelAt: [1046, 244], labelAnchor: 'middle' },
  { id: 'pcs.meter', kind: 'ac', points: [[1168, 305], [1200, 305]], label: 'AC 2,000 kW', labelAt: [1184, 240], labelAnchor: 'middle' },
  { id: 'meter.grid', kind: 'ac', points: [[1300, 305], [1312, 305]] },
];

/** 계통 모선 (도면 오른쪽 끝의 세로 굵은 선) */
export const GRID_BUS = Object.freeze({ x: 1312, y1: 248, y2: 362, label: '전력계통 22.9 kV', labelX: 1312, labelY: 222 });

/**
 * 도면에 그려진 계장 10점. 태그 → 포인트는 시드가 om.point.instrument_tag에 넣은 값이 정본이고,
 * sources는 태그가 기록되지 않은 사이트에서 같은 자리를 읽기 위한 대체 경로다.
 */
export const TAGS: readonly TagDef[] = [
  { tag: 'LT-101', nodeId: 'tank', cx: 46, cy: 212, stub: [46, 231, 46, 250], valueDx: 0, valueDy: -26, valueAnchor: 'middle', sources: ['water.tank.level'] },
  { tag: 'FT-101', nodeId: 'wtu', cx: 116, cy: 212, stub: [135, 212, 160, 212], valueDx: 0, valueDy: -26, valueAnchor: 'middle', sources: ['water.flow.feed', 'water.flow'] },
  { tag: 'TT-303', nodeId: 'hx', cx: 356, cy: 226, stub: [375, 226, 396, 226], valueDx: 0, valueDy: -32, valueAnchor: 'middle', sources: ['hx.temp.cold.out'] },
  { tag: 'TT-302', nodeId: 'hx', cx: 700, cy: 142, stub: [700, 161, 700, 170], valueDx: 23, valueDy: 4, valueAnchor: 'start', sources: ['hx.temp.hot.out'] },
  { tag: 'TT-301', nodeId: 'hx', cx: 990, cy: 200, stub: [971, 200, 952, 200], valueDx: 23, valueDy: 4, valueAnchor: 'start', sources: ['hx.temp.hot.in'] },
  { tag: 'PT-401', nodeId: 'o2tank', cx: 478, cy: 148, stub: [459, 148, 430, 148], valueDx: 23, valueDy: 4, valueAnchor: 'start', sources: ['tank.pressure@o2'] },
  { tag: 'PT-201', nodeId: 'buffer', cx: 516, cy: 218, stub: [516, 237, 516, 305], valueDx: 0, valueDy: -26, valueAnchor: 'middle', sources: ['h2.pressure@buffer', 'tank.pressure'] },
  { tag: 'FT-201', nodeId: 'elz', cx: 572, cy: 218, stub: [572, 237, 572, 305], valueDx: 0, valueDy: -26, valueAnchor: 'middle', sources: ['h2.flow.mass@elz.out', 'h2.flow.mass'] },
  {
    tag: 'PT-202',
    nodeId: 'prv',
    cx: 860,
    cy: 218,
    stub: [860, 237, 860, 305],
    valueDx: 0,
    valueDy: -26,
    valueAnchor: 'middle',
    sources: ['h2.pressure@fc.inlet'],
    // 도면은 버블을 버퍼 위에 그렸지만 데이터 계약(data-contract-draft.md 부록 B4-2)은 감압 후
    // 연료전지 입구(스팬 0~4 bar)로 재지정했다. 읽는 자리를 따라 감압밸브 하류에 둔다.
    note: '도면은 버퍼 상단 · 데이터 계약은 감압 후 연료전지 입구(0~4 bar 재지정)',
  },
  { tag: 'FT-301', nodeId: 'fc', cx: 860, cy: 372, stub: [860, 353, 860, 305], valueDx: -23, valueDy: 0, valueAnchor: 'end', sources: ['fc.h2.consumption'] },
];

export const NODE_BY_ID: ReadonlyMap<string, NodeDef> = new Map(NODES.map((node) => [node.id, node]));

/** 공정도를 그릴 수 있는 사이트의 조건: 수전해 설비가 있어야 한다 (이 도면은 수소 계통 공정도다) */
export const REQUIRED_CLASS_KEY = 'h2.elz';

/** 공정도가 상자로 그리는 설비 종류 */
export const DIAGRAM_CLASS_KEYS: readonly string[] = [...new Set(NODES.map((node) => node.classKey))];

/** 공정도가 값을 읽는 메트릭 (조회에서 포인트를 좁히는 데 쓴다) */
export const DIAGRAM_METRIC_KEYS: readonly string[] = [
  ...new Set(
    [...NODES.flatMap((node) => node.readouts.flatMap((readout) => readout.sources)), ...TAGS.flatMap((tag) => tag.sources)].map(
      (source) => source.split('@')[0] as string,
    ),
  ),
].sort();

/** 도면에 그려진 계장 태그 이름 */
export const DIAGRAM_TAG_NAMES: readonly string[] = TAGS.map((tag) => tag.tag);
