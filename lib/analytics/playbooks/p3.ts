// P3 탐지기 8종 고장모드 플레이북 (원인 후보·점검 항목·권고 조치·오탐 함정, 한국어).
// 출처 키 (docs/renewal/research/):
//   research-solar_ess.json         failureModes[0] 모듈 오염 · [7] 인버터 냉각계통 열화 · [13] 일사계 오염·드리프트 · [17] 내부저항 증가 · [21] 병렬 랙 접촉저항
//   research-electrolyzer.json      failureModes[10] 정류기 효율 저하 · [11] 전류센서·유량계 드리프트 · [20] BoP 시스템 효율 저하
//   research-fuelcell_storage.json  failureModes[1] 흡입·토출 밸브 누설 · [2] 피스톤링·패킹 마모 · [3] 인터쿨러 냉각 저하 · [6] 쇼트 사이클링 · [7] 압축 효율 저하
//                                   · [8] 저장뱅크 미세누설 · [12] 압력·온도 전송기 드리프트 · [27] 공기 블로워 마모·흡입필터 막힘 · [40] 수소 물질수지 불일치
//   deep/research-storage.json      components[0] 다이어프램 압축기 · [5] 고압 저장용기 · [7] 밸브·피팅, aiAnalyses[0] 정지유지 미세누설 · [1] 압축기 예지보전
//   deep/research-system.json       components[3] 수소 질량유량·재고 계량, aiAnalyses[2] 수지 폐합·계량 신뢰성
//   deep/research-fuelcell.json     components[7] 공기 공급 계통, aiAnalyses[3] BoP 예지정비
//   deep/research-pv.json           components[5] 인버터 AC 측(디레이팅), aiAnalyses[2] 오염 손실·세척 시점
//   deep/research-ess.json          components[2] 랙·RBMS(접촉기·전류 분담)
//   deep/research-electrolyzer.json components[1] 정류기, aiAnalyses[2] 효율 운전점
//   research-periodic-analysis-lifespan.md  공기·연료 필터 2,000~4,000 h 교체 창, 오염 구간 14일 요건
import type { FailureMode } from '../detectors/types';
import type { Playbook } from './index';

const SOLAR_ESS = 'research-solar_ess.json';
const ELECTROLYZER = 'research-electrolyzer.json';
const FUEL_CELL = 'research-fuelcell_storage.json';
const DEEP_STORAGE = 'research-storage.json';
const DEEP_SYSTEM = 'research-system.json';
const DEEP_FUEL_CELL = 'research-fuelcell.json';
const DEEP_PV = 'research-pv.json';
const DEEP_ESS = 'research-ess.json';
const LIFESPAN = 'research-periodic-analysis-lifespan.md';

/** 안전 관련 권고 문장에 붙이는 고정 원칙 */
const NOT_A_SAFETY_SYSTEM = '이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.';

export type P3FailureMode = Extract<FailureMode, 'el.system_efficiency_loss' | 'h2chain.mass_balance_gap' | 'h2.storage_leak' | 'comp.efficiency_loss' | 'fc.blower_wear' | 'pv.soiling' | 'ess.resistance_growth' | 'pv.inverter_thermal_derating'>;

export const P3_PLAYBOOKS: Readonly<Record<P3FailureMode, Playbook>> = {
  'el.system_efficiency_loss': {
    failureMode: 'el.system_efficiency_loss',
    title: '전해조 시스템 비에너지(kWh/kg) 상승',
    category: 'performance',
    causes: [
      { id: 'stack', label: '스택 셀 전압 상승(열화)', check: '같은 전류밀도·온도 셀 전압 추세(el.voltage_rise)가 비에너지 상승을 설명하는지' },
      { id: 'rectifier', label: '정류기 효율 저하·냉각 불량·리플 증가', check: '같은 부하 bin에서 DC/AC 전력비, 방열판 온도, 리플·THD' },
      { id: 'faraday', label: '패러데이 효율 저하(크로스오버·퍼지 손실)', check: '측정 H₂ ÷ 전류 이론 생산량 추세와 HTO 추세 동행 여부' },
      { id: 'metering', label: 'DC 전류센서·유량계 드리프트(계측 오류)', check: 'HTO·셀 전압 변화 없이 패러데이 효율만 변하는지, 교정 이벤트 전후 계단' },
      { id: 'bop', label: 'BoP 보조부하 증가·부분부하 운전 비중 증가', check: '스택 비에너지는 그대로인데 시스템 비에너지만 상승, 대기 운전 전력' },
    ],
    inspections: ['정류기 AC/DC 전력·효율과 방열판 온도, DC 리플 측정', '유량계·전류센서 교정 이력과 영점', 'BoP 전력 분해(펌프·칠러·히터)와 대기 운전 시간', '퍼지 횟수와 HTO 추세', '부분부하 운전 비중과 운전 스케줄'],
    actions: ['정류소자·필터 커패시터·냉각팬 점검', '유량계·전류센서 교정(교정 전 지표는 신뢰도 낮음으로 표시)', '펌프·칠러·히터 제어 설정 점검과 불필요한 대기 운전 축소', '저부하 시간대 운전점·운전 대수 조정', '스택 열화가 동반되면 제조사 진단과 교체 시점 재산정'],
    falsePositiveTraps: ['저부하(15~20% 이하) 구간은 원래 효율이 낮음', '전력계 CT 교정 오차', '여름철 냉각 부하 증가', '건조기 재생 주기 겹침', '유량계 저유량 컷오프'],
    sources: [ELECTROLYZER, LIFESPAN],
  },
  'h2chain.mass_balance_gap': {
    failureMode: 'h2chain.mass_balance_gap',
    title: '수소 체인 물질수지 잔차',
    category: 'performance',
    causes: [
      { id: 'flowmeter', label: '유량계 영점 드리프트·저유량 부정확', check: '무유량 구간 적산값 증가, 패러데이 기대 생산량 대비 유량계 비율 변화' },
      { id: 'temperature', label: '재고 계산 온도 보정 오차(센서 위치·열 지연·게이지압 혼동)', check: '잔차와 탱크 온도 변화·일교차 상관, 절대압 변환 여부' },
      { id: 'vent', label: '미계량 퍼지·벤트 손실', check: '퍼지·벤트 밸브 개방 이벤트와 잔차 상관' },
      { id: 'leak', label: '저장부·배관 미세 누설', check: '정지 보유 구간 누설률(tank.static_leak)과 가스 검지기 저농도 기록' },
      { id: 'data_gap', label: '계량 데이터 결측·시각 불일치', check: '결측일·게이트웨이 시각 동기 상태' },
    ],
    inspections: ['유량계 교정 성적서와 영점 설정 이력', '저장용기 압력 절대압 변환·온도센서 위치', '퍼지·벤트 이벤트와 추정 손실 파라미터', '정지 보유 구간 누설률·가스 검지기 기록', '계량 결측일·시각 동기'],
    actions: ['잔차가 생긴 구간의 유량계 교정', '퍼지 1회당 배출량 등 추정 파라미터 갱신', `누설이 의심되면 발포액·휴대용 검지기로 정밀 점검(운전 판단은 현장 안전책임자, ${NOT_A_SAFETY_SYSTEM})`, '계량 결측을 해소한 뒤 원장을 다시 계산'],
    falsePositiveTraps: ['기간 경계 시점 온도 불안정으로 인한 재고 오차', '유량계 저유량 컷오프로 소량 유동 누락', '정비 벤트·시료채취 미기록', '청정수소 인증 공식 산정이 아님'],
    sources: [FUEL_CELL, DEEP_SYSTEM],
  },
  'h2.storage_leak': {
    failureMode: 'h2.storage_leak',
    title: '수소 저장용기 정지 보유 구간 누설',
    category: 'safety',
    causes: [
      { id: 'fitting', label: '피팅·플러그·밸브 스템 미세누설', check: '발포액·휴대용 검지기·초음파 점검, 인근 가스 검지기 저농도 에피소드' },
      { id: 'valve_passing', label: '차단밸브 시트 내부 통과 누설', check: '정지 구간 하류 압력 상승 동반 여부' },
      { id: 'prd', label: 'PRD·안전밸브 웨핑', check: '방출관 출구 검지, 안전밸브 시트 점검' },
      { id: 'sensor_drift', label: '압력·온도 전송기 드리프트(겉보기 누설)', check: '균압 상태에서 같은 뱅크 다른 용기·압축기 토출 압력과 비교' },
      { id: 'thermal', label: '충전 직후 가스 냉각·열 지연(겉보기 누설)', check: '손실률과 온도 변화율 상관, 충전 직후 구간 제외' },
    ],
    inspections: ['가스 검지기 경보·저농도 기록 확인', '비눗물(발포액)·휴대용 검지기로 피팅·밸브 스템·PRD 누설 점검', '밸브·피팅 체결 토크 점검', '출구 차단밸브 하류 압력 상승 확인', '압력·온도 전송기 교정 상태'],
    actions: ['가스 검지기 기록을 확인하고 누설 점검을 즉시 시행', '피팅 재체결·씰 교체', `운전 정지·운전압력 하향 여부는 현장 안전책임자가 판단 (${NOT_A_SAFETY_SYSTEM})`, '조치 후 첫 정지 보유 구간으로 누설률 재검증', '점검 결과를 조치 기록에 남겨 기준선을 갱신'],
    falsePositiveTraps: ['충전 직후 가스 냉각(정상 압력 하강)', '일사·야간 냉각에 따른 가스·센서 온도 열 지연', '게이지압을 절대압으로 변환하지 않음', '압력 전송기 분해능·드리프트', '밸브 닫힘 상태의 내부 통과 누설은 외부 누설이 아님'],
    sources: [FUEL_CELL, DEEP_STORAGE],
  },
  'comp.efficiency_loss': {
    failureMode: 'comp.efficiency_loss',
    title: '수소 압축기 비에너지(kWh/kg) 상승',
    category: 'performance',
    causes: [
      { id: 'valves', label: '흡입·토출 밸브 누설·파손(재압축)', check: '같은 압력비에서 해당 단 토출 온도 잔차 상승, 단간 압력비 이동' },
      { id: 'rings', label: '피스톤 링·로드 패킹 마모(블로바이)', check: '체적효율 저하, 패킹 벤트·디스턴스 피스 압력 상승' },
      { id: 'diaphragm', label: '다이어프램 피로·오일계통 이상', check: '누설검지 포트 압력 급변, 오일 최대압·여유 변동' },
      { id: 'cooling', label: '인터쿨러·애프터쿨러 냉각 성능 저하', check: '전 단 토출 온도 동시 상승, 냉각수 ΔT·접근온도' },
      { id: 'short_cycle', label: '쇼트 사이클링(과다 기동·정지)', check: '시간당 기동 횟수, 1회 런타임 단축' },
    ],
    inspections: ['단별 토출 온도·단간 압력비', '누설검지 포트 압력·오일 최대/최소압', '진동·베어링 소음', '냉각수 입출구 온도·유량·스트레이너', '기동 횟수·최소 런타임 설정'],
    actions: ['해당 단 밸브 분해점검·밸브 플레이트/스프링 교체', '패킹·링 교체 계획(필터의 금속 파편 확인)', `누설검지 압력 상승은 제조사 절차와 현장 인터록 상태를 먼저 확인 (${NOT_A_SAFETY_SYSTEM})`, '냉각계통 세정·유량 회복', '버퍼 압력 히스테리시스·최소 런타임으로 쇼트 사이클 억제', '교체 후 같은 조건 기준선 재학습'],
    falsePositiveTraps: ['여름철 냉각수·외기 온도 상승(전 단 동시 상승)', '흡입 가스 온도 계측 없음(외기 온도로 대신)', '짧은 런의 기동 과도 비중', '흡입압 저하일(수전해 저출력)', '재고 변화로 질량을 추정할 때 동시 소비 누락'],
    sources: [FUEL_CELL, DEEP_STORAGE],
  },
  'fc.blower_wear': {
    failureMode: 'fc.blower_wear',
    title: '연료전지 공기 블로워 마모·흡입필터 막힘',
    category: 'degradation',
    causes: [
      { id: 'filter', label: '흡입 에어필터 막힘·화학필터 소진', check: '필터 차압, 과거 필터 교체 뒤 비전력 회복 이력' },
      { id: 'bearing', label: '블로워 베어링·임펠러 마모', check: '필터 교체 뒤에도 비전력 회복 없음, 베어링 소음·진동' },
      { id: 'flow_sensor', label: '유량센서 오염(과소 측정)', check: '셀 편차·차압 변화와 교차 확인, 센서 세정 후 비교' },
      { id: 'density', label: '외기 고온·저기압(공기 밀도 저하)', check: '외기 온도 bin 편중, 대기압' },
    ],
    inspections: ['흡입필터 차압과 교체 경과(연료전지 CHP 일반 2,000~4,000 h 교체 창)', '블로워 베어링 소음·진동', '공기 유량센서 세정·교정', '캐소드 입구압·차압과 배압밸브 개도', '스택 셀 전압 균일 하락 여부'],
    actions: ['흡입필터를 먼저 교체하고 같은 조건으로 재비교', '회복이 없으면 베어링·임펠러 점검·교체', '유량센서 세정·교정', '교체 조치를 기록해 효과 검증'],
    falsePositiveTraps: ['대기압·외기 온도 변화(밀도 보정)', '유량센서 오염으로 인한 과소 측정', '배압밸브 개도 변화', '부하 스텝 과도 구간'],
    sources: [FUEL_CELL, DEEP_FUEL_CELL, LIFESPAN],
  },
  'pv.soiling': {
    failureMode: 'pv.soiling',
    title: '태양광 모듈 오염',
    category: 'performance',
    causes: [
      { id: 'dust', label: '황사·먼지·꽃가루 누적', check: '맑은 날 PI가 강우·세척 사이 톱니 모양으로 하락 후 계단식 회복' },
      { id: 'bird', label: '조류 배설물(국부 핫스팟)', check: '열화상 국부 발열, 특정 스트링 편중' },
      { id: 'sensor', label: '일사계 오염·드리프트(겉보기 변화)', check: 'GHI/POA 비율 변화, 일사계 청소 상태' },
      { id: 'shading', label: '부분 음영 편중', check: '일부 인버터·스트링만 저하, 태양 위치별 잔차' },
      { id: 'season', label: '계절 입사각·스펙트럼 변화', check: '전년 같은 기간 PI 추세' },
    ],
    inspections: ['강우·세척 전후 PI 회복 폭', '인버터·스트링 간 저하 균일성', '일사계 청소 상태·수평', '열화상으로 국부 오염·핫스팟', '세척 기록 누락 여부'],
    actions: ['누적 손실액(SMP 기준)이 세척비를 넘으면 세척(봄철 황사·송화가루 기간 우선)', '세척 전후 PI로 효과 검증', '조류 배설물은 핫스팟이 생기기 전에 조기 제거', '일사계 주기 세척·교정'],
    falsePositiveTraps: ['일사계 자체 오염(PI가 좋아지는 착시)', '적설', '출력제어·클리핑', '계절 입사각 변화', '연무로 산란광 비율 증가', '세척 기록 누락(회복을 강우로 오인)'],
    sources: [SOLAR_ESS, DEEP_PV, LIFESPAN],
  },
  'ess.resistance_growth': {
    failureMode: 'ess.resistance_growth',
    title: '배터리 랙 직류 내부저항 증가',
    category: 'degradation',
    causes: [
      { id: 'aging', label: '셀 열화(내부저항 증가)', check: '같은 SOC·온도 R_step 추세, 용량 감소 동반, 랙 내 모듈 R 편차' },
      { id: 'connection', label: '버스바·커넥터·케이블 러그 접촉저항', check: '셀 전압 편차는 그대로인데 랙 R만 증가, 열화상 발열' },
      { id: 'contactor', label: '접촉기 접점 마모·저항 증가', check: '랙 전류 분담 계단형 감소, 누적 개폐 횟수' },
      { id: 'cold', label: '저온 운전', check: '최근 셀 온도 분포(15 °C 미만 급증)' },
    ],
    inspections: ['버스바·단자 체결 토크와 열화상', '접촉기 개폐 횟수·전압 강하', '병렬 랙 간 전류 분담률', '셀 온도 분포와 공조 상태', '전류·전압 샘플 주기와 시각 동기'],
    actions: ['접속부가 의심되면 토크 점검·재체결', '접촉기 점검·교체', '운전 C-rate·온도 관리 강화', '셀 쪽 원인이면 모듈 교체·보증 청구 검토', '조치 후 같은 조건 R_step 재비교'],
    falsePositiveTraps: ['저온(15 °C 미만) 저항 급증', '샘플 주기 차이(분극 포함 정도가 달라짐)', 'SOC 극단 구간', '전류·전압 샘플 시각 비동기', '전류센서 오프셋'],
    sources: [SOLAR_ESS, DEEP_ESS],
  },
  'pv.inverter_thermal_derating': {
    failureMode: 'pv.inverter_thermal_derating',
    title: '인버터 열 출력저감',
    category: 'performance',
    causes: [
      { id: 'fan', label: '냉각팬 고장', check: '팬 알람·고장 코드, 팬 동작 확인' },
      { id: 'filter', label: '흡기 필터·방열핀 막힘', check: '같은 외기·부하에서 방열판−외기 온도차 증가, 저감 시간 증가' },
      { id: 'environment', label: '설치실 환기 불량·직사광선', check: '동종 인버터 전체가 함께 고온·저감' },
      { id: 'power_module', label: 'IGBT·전력모듈 열화(발열 증가)', check: '같은 부하 bin에서 방열판 온도 상승, 효율 저하' },
    ],
    inspections: ['팬 동작·알람 코드', '필터·방열핀 먼지', '방열판−외기 온도차 추세', '설치실 환기·차양', '펌웨어 버전·저감 곡선 설정'],
    actions: ['팬·필터 청소 또는 교체', '방열핀 청소', '설치실 환기 개선', '반복되면 팬 교체 예방정비 일정화', '조치 후 같은 외기 조건 저감 시간 재비교'],
    falsePositiveTraps: ['직사광선 노출 위치 변화', '외기센서 위치(인버터 배기 근처)', '여름 폭염에 따른 정상 저감', '펌웨어 저감 곡선 변경', '출력제한 설정 잔존'],
    sources: [SOLAR_ESS, DEEP_PV],
  },
};
