// 고장모드별 원인 후보·점검 항목·권고 조치 (한국어). P2 탐지기 6종의 failure_mode와 1:1.
// 근거: docs/renewal/research/research-{solar_ess,electrolyzer,fuelcell_storage}.json failureModes
//       (detectionMethod · recommendedAction_ko · falsePositiveTraps). 리포트 템플릿과 분석 데스크 권고 초안이 이 상수를 쓴다.
import type { FailureMode, FindingCategory } from '../detectors/types';

export interface PlaybookCause {
  readonly id: string;
  readonly label: string;
  /** 이 원인을 가려내는 확인 방법 */
  readonly check: string;
}

export interface Playbook {
  readonly failureMode: FailureMode;
  readonly title: string;
  readonly category: FindingCategory;
  readonly causes: readonly PlaybookCause[];
  readonly inspections: readonly string[];
  readonly actions: readonly string[];
  /** 오탐 함정 — 기각 전에 확인할 것 */
  readonly falsePositiveTraps: readonly string[];
  readonly sources: readonly string[];
}

const SOLAR_ESS = 'research-solar_ess.json';
const ELECTROLYZER = 'research-electrolyzer.json';
const FUEL_CELL = 'research-fuelcell_storage.json';

export const PLAYBOOKS: Readonly<Record<FailureMode, Playbook>> = Object.freeze({
  'ess.capacity_fade': {
    failureMode: 'ess.capacity_fade',
    title: '배터리 랙 유효용량 감소',
    category: 'degradation',
    causes: [
      { id: 'aging', label: '셀 열화에 따른 실제 용량 감소', check: '정기 용량시험(완충→완방, 기준 전류·온도)으로 확정' },
      { id: 'cell_imbalance', label: '셀 불균형으로 인한 조기 충전 종료(회복 가능)', check: '충전 종료 셀 전압 편차 추세, 밸런싱 후 재비교' },
      { id: 'resistance', label: '내부저항 증가로 상한 조기 도달', check: 'CC 구간 Ah 감소와 CV 시간 증가 동반 여부' },
      { id: 'soc_setpoint', label: '운영 SOC 상한 변경(보증·규제 설정)', check: 'EMS/BMS 설정 변경 이력, 충전 종료 SOC 분포' },
      { id: 'cold', label: '저온 운전에 따른 가용 용량 감소', check: '같은 온도 구간 비교, 최근 셀 온도 분포' },
      { id: 'bms', label: 'BMS SOC 산식 변경·재보정', check: '펌웨어 업데이트·교정 기록, 충전 시작 SOC 점프 빈도' },
    ],
    inspections: ['정기 용량시험 결과와 비교', '보증 조건(사이클·온도·SOC 체류) 위반 여부', '셀 전압 편차와 밸런싱 동작 확인', '전류센서 영점 확인'],
    actions: ['기준 조건 용량시험으로 감소 폭 확정', '셀 밸런싱 후 같은 조건으로 재평가', '운영 SOC 범위·C-rate 조정 검토', '보증 SOH 곡선 대비 추세 점검 및 보강 계획 반영'],
    falsePositiveTraps: ['운영 SOC 상한 변경', '셀 불균형으로 인한 조기 종료', '저온 영향', '태양광 연계로 전류 변동(시간이 아니라 Ah로 판정)', '전류센서 오프셋', 'BMS 펌웨어 업데이트로 SOC 산식 변경'],
    sources: [SOLAR_ESS],
  },
  'ess.cell_imbalance': {
    failureMode: 'ess.cell_imbalance',
    title: '셀 불균형·밸런싱 불량',
    category: 'degradation',
    causes: [
      { id: 'balancing', label: '패시브 밸런싱 시간 부족·파라미터 부적절', check: '완충 유지 시간, BMS 밸런싱 설정' },
      { id: 'weak_cell', label: '특정 셀·모듈 열화(반복 최저 셀)', check: '최저·최고 셀 위치 ID 반복 여부' },
      { id: 'sensor', label: '셀 전압 센서 오프셋', check: '해당 채널만 상시 일정 편차인지 확인' },
    ],
    inspections: ['충전 종료·휴지 시 셀 전압 편차 추세', '반복 최약 셀 위치 확인', '온도 편차 동반 여부'],
    actions: ['완충 유지로 밸런싱 시간 확보', 'BMS 밸런싱 파라미터 점검', '반복 셀이 포함된 모듈 교체 검토'],
    falsePositiveTraps: ['LFP 상단 급경사 구간에서 정상적으로 벌어짐', '온도 편차에 따른 전압 차', '전압센서 오프셋'],
    sources: [SOLAR_ESS],
  },
  'pv.inverter_underperformance': {
    failureMode: 'pv.inverter_underperformance',
    title: '인버터 동종 대비 발전량 저하',
    category: 'performance',
    causes: [
      { id: 'efficiency', label: '변환효율 저하(IGBT·DC링크 커패시터 열화)', check: '같은 부하율에서 효율 비교, 발열 증가 동반' },
      { id: 'mppt', label: 'MPPT 추종 불량·설정 오류', check: 'MPPT별 DC 전력·전압 비교, 펌웨어 설정' },
      { id: 'string', label: '스트링 개방(퓨즈·커넥터)', check: 'MPPT 전류 계단 감소(1/N) 여부' },
      { id: 'cooling', label: '냉각계통 열화에 따른 열 디레이팅', check: '방열판−외기 온도차, 오후 출력 평탄화' },
      { id: 'limit', label: '출력제한 설정 잔존', check: '출력제어 지령 없이 정격 미만 평탄 구간' },
    ],
    inspections: ['DC/AC 계측 교차검증(외부 전력량계)', '퓨즈·MC4 커넥터 열화상 점검', '팬·필터·방열핀 상태', '출력제한 설정값 확인'],
    actions: ['제조사 진단 요청 및 보증기간 내 교체 청구', '퓨즈·커넥터 교체', '팬·필터 청소 또는 교체', '출력제한 설정 원복'],
    falsePositiveTraps: ['부분 음영·오염 편중', 'DC 측정 센서 오차', '출력제한·무효전력 운전', '통신 두절을 정지로 오인'],
    sources: [SOLAR_ESS],
  },
  'el.stack_voltage_degradation': {
    failureMode: 'el.stack_voltage_degradation',
    title: '전해조 스택 셀 전압 상승(열화)',
    category: 'degradation',
    causes: [
      { id: 'catalyst', label: '애노드 촉매(IrOx) 활성 저하', check: '저전류 구간 전압 상승이 상대적으로 큰지' },
      { id: 'ohmic', label: 'PTL 부동태화·접촉저항 증가', check: '전압 상승폭이 전류밀도에 비례하는지, 체결 토크' },
      { id: 'contamination', label: '멤브레인 양이온 오염', check: '순수 전도도 이상 이후 24~72 h 내 전압 동시 상승' },
      { id: 'cycling', label: '잦은 기동·정지에 따른 손실 누적', check: '기동 횟수와 열화율 동행 여부' },
    ],
    inspections: ['순수·루프 전도도 이력', '스택 체결 토크·전기 접속부', '정류기 리플 사양', '제조사 분극곡선·EIS 진단'],
    actions: ['OCV 대기 최소화·램프율 제한', '루프 이온교환수지 교체(오염 시)', '제조사 진단 요청 및 스택 교체 시점 재산정', '짧은 PV 공백은 정지 대신 최소부하 대기'],
    falsePositiveTraps: ['break-in 초기 1,000 h의 가역 변화', '장기 정지 후 재기동 직후 일시 개선', '온도센서 위치 변경', '스택 온도 저하'],
    sources: [ELECTROLYZER],
  },
  'fc.stack_voltage_decay': {
    failureMode: 'fc.stack_voltage_decay',
    title: '연료전지 스택 전압 감소(열화)',
    category: 'degradation',
    causes: [
      { id: 'ecsa', label: '촉매 ECSA 손실·탄소 담지체 부식', check: '기준 전류밀도 전압 감소율 가속 여부' },
      { id: 'operation', label: '기동·정지·고전위 대기 과다', check: '월간 기동정지 횟수와 열화율 동행' },
      { id: 'poisoning', label: '연료·공기 불순물 피독', check: '전 셀 동시 하락, 수소 순도 이상·공기필터 교체 경과' },
      { id: 'air_supply', label: '공기 공급 저하(블로워 마모·필터 막힘)', check: '같은 유량에서 블로워 전력 증가' },
    ],
    inspections: ['운전패턴(기동정지·저부하 장시간) 점검', '공기필터·수소 순도 점검', '블로워 전력·유량 추세'],
    actions: ['운전계획 조정(연속운전·최소부하 대기)', '공기필터 교체·수소 품질 분석', '제조사 회복 운전 시행', '잔여수명 기반 스택 교체 예산 계획'],
    falsePositiveTraps: ['가역 손실(재기동 후 회복)', '계절 온도·가습 변화', '전류센서 드리프트', '스택 교체 후 기준선 미갱신', '초기 활성화 기간 포함'],
    sources: [FUEL_CELL],
  },
  'dq.data_gap_flatline': {
    failureMode: 'dq.data_gap_flatline',
    title: '데이터 수신 결측·센서 값 고착',
    category: 'data_quality',
    causes: [
      { id: 'communication', label: '통신 두절·게이트웨이 정체', check: '게이트웨이 last seen, 배치 공백, 로컬 버퍼 백필 여부' },
      { id: 'stuck_sensor', label: '센서 고착·배선 불량', check: '같은 값 반복 구간, 동종 센서와 비교' },
      { id: 'clock', label: '시각 오류(시계 오차·KST/UTC 혼동)', check: 'CLOCK_SUSPECT 비트, NTP 동기 상태' },
    ],
    inspections: ['통신 모뎀·RTU·게이트웨이 점검', '센서 배선·교정 상태', 'NTP 시각 동기'],
    actions: ['게이트웨이·통신 경로 점검 및 로컬 버퍼 백필', '고착 센서 교정 또는 교체', 'NTP 동기 설정'],
    falsePositiveTraps: ['야간 인버터 슬립으로 인한 정상 결손', '계획 정비'],
    sources: [SOLAR_ESS],
  },
});

export function playbookFor(failureMode: FailureMode): Playbook {
  return PLAYBOOKS[failureMode];
}
