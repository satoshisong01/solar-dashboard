// 가평 구성 탐지기 3종 고장모드 플레이북 (원인 후보·점검 항목·권고 조치·오탐 함정, 한국어).
// 출처 키 (docs/renewal/research/pid/):
//   research-pressure.{json,md}  감압밸브 락업 크리프·공급압 효과(EN 334 AC/SG)·PSV 시머링
//   research-heat.{json,md}      폐열회수 열교환기 UA·접근온도·교차누설·적산열량계 오차
//   research-oxygen.{json,md}    애노드 원가스 HTO·법정 압축금지선 2 vol%·1일 1회 품질검사
import type { FailureMode } from '../detectors/types';
import type { Playbook } from './index';

const PRESSURE = 'research-pressure.json';
const HEAT = 'research-heat.json';
const OXYGEN = 'research-oxygen.json';

/** 안전 관련 권고 문장에 붙이는 고정 원칙 */
const NOT_A_SAFETY_SYSTEM = '이 콘솔은 법정 안전설비·가스 검지기·현장 PLC 인터록 판단을 대체하지 않습니다.';

export type GapyeongFailureMode = Extract<FailureMode, 'prv.seat_leak' | 'hx.heat_recovery_loss' | 'o2.purity_drift'>;

export const GAPYEONG_PLAYBOOKS: Readonly<Record<GapyeongFailureMode, Playbook>> = {
  'prv.seat_leak': {
    failureMode: 'prv.seat_leak',
    title: '수소 감압밸브 시트 누설 (락업 크리프)',
    category: 'degradation',
    causes: [
      { id: 'seat', label: '시트·디스크 이물 끼임·마모로 완전히 닫히지 않음', check: '무유동 구간 하류 압력 상승이 구간 내내 이어지는지(잦아들면 공급압 효과)' },
      { id: 'supply_pressure', label: '공급압 효과 — 상류가 떨어지는 동안 설정압이 오르는 정상 현상', check: '하류 압력과 상류(버퍼) 압력의 상관, EN 334 AC·SG 등급 명판' },
      { id: 'diaphragm', label: '다이어프램·스프링 피로로 설정압 이동', check: '유동 구간 조절 편차(설정 대비)와 락업 오프셋 동시 확인' },
      { id: 'psv', label: '안전밸브 시머링으로 하류 압력이 유지·상승', check: '방출관 온도(수소는 상온 교축에서 온도가 오른다)와 PSV 정정압' },
      { id: 'thermal', label: '밀폐 체적 열팽창 (겉보기 크리프)', check: '하류 압력과 외기 온도 상관, 일중 주기성' },
      { id: 'sensor', label: '하류 압력계 스팬 과대·드리프트', check: '0~40 bar 전송기로는 mbar급 크리프를 원리상 볼 수 없다 — 스팬과 분해능 확인' },
    ],
    inspections: [
      '무유동 구간(연료전지 정지) 하류 압력 기록과 상류 압력 동시 확인',
      '설정 압력 현장 재조정 이력',
      '하류 격리 구성이 구간마다 같은지 (하류 체적이 달라지면 같은 누설이라도 상승률이 달라진다)',
      '안전밸브 정정압·시머링 여부와 방출관 온도',
      '하류 압력계 스팬·분해능 (권고 0~4 bar)',
    ],
    actions: [
      '3회 연속 경고 구간이 나오면 시트·디스크 점검과 이물 제거',
      '설정압 재조정 이력이 있으면 기준선을 다시 잡고 재평가',
      '하류 압력계 스팬을 운전 압력대에 맞게 재지정',
      `하류 과압 위험 판단(운전 정지·PSV 점검)은 현장 안전책임자가 한다 (${NOT_A_SAFETY_SYSTEM})`,
    ],
    falsePositiveTraps: [
      '공급압 효과 — 버퍼가 30 → 5 bar로 빠지는 동안 등급에 따라 설정압이 +3~219% 오른다 (최대 오탐원)',
      '밀폐 체적 열팽창 (온도만으로도 압력이 움직인다)',
      '안전밸브 미세 시머링과 신호가 같다',
      '하류 격리 구성이 다른 구간끼리 비교',
      '출하·기동 직후 압력 평형 20~30분',
    ],
    sources: [PRESSURE],
  },
  'hx.heat_recovery_loss': {
    failureMode: 'hx.heat_recovery_loss',
    title: '폐열회수 열교환기 성능 저하',
    category: 'performance',
    causes: [
      { id: 'scaling', label: '스케일·슬러지 퇴적 (차압 동반 상승)', check: '같은 유량 bin에서 1차측 차압 정규화값 상승 여부' },
      { id: 'biofilm', label: '표면 막·유기물 오염 (차압은 그대로)', check: '차압 변화 없이 접근온도만 벌어지는지' },
      { id: 'flow', label: '2차측 유량 저하 (펌프·필터)', check: '2차측 유량 중앙값, 펌프 전력/유량 비' },
      { id: 'sensor', label: '온도센서 쌍 드리프트 (겉보기 저하)', check: '정지 중 네 온도가 같은 값으로 수렴하는지' },
      { id: 'condition', label: '1차측 입구 온도대 변화 (조건 편중)', check: '기준·최근 1차측 입구 온도 분포' },
    ],
    inspections: [
      '같은 유량·1차측 입구 온도 bin에서 접근온도와 차압 동시 비교',
      '2차측 유량계·펌프 전력',
      '정지 구간 온도센서 4점 영점 대조',
      '세정·수지 교체 이력 (세정 직후 72시간은 판정에서 뺀다)',
      '2차측 전도도 상승 여부 — 교차누설이면 수전해 스택이 먼저 망가진다',
    ],
    actions: [
      '차압이 함께 오르면 화학 세정, 차압이 그대로면 표면 막 세척·유량 점검',
      '2차측 입구 온도계(TT-304)와 유량계가 없으면 신설해 UA 판정으로 올린다',
      '세정 뒤 14일을 새 기준 구간으로 잡고 재평가',
      '2차측 전도도가 1.0 µS/cm를 넘으면 원인 불문 즉시 격리하고 교차누설을 확인한다 (수전해 스택 보호선)',
    ],
    falsePositiveTraps: [
      'DI 탱크 수온의 계절 변동 (LMTD 정규화 필요)',
      '펌프 VFD 감속으로 인한 유량 저하',
      '양측 온도차 10 K 미만 구간의 계측 오차 폭증 (적산열량계 감온부 오차 Et = ±(0.5 + 3·ΔΘmin/ΔΘ)%)',
      '온도센서 쌍 드리프트',
      '양측 열수지 절대값 비교 — 설계상 2차측 회수열이 1차측의 약 7%라 상시 불일치로 보인다',
    ],
    sources: [HEAT],
  },
  'o2.purity_drift': {
    failureMode: 'o2.purity_drift',
    title: '산소 중 수소(HTO) 상승 — 압축금지선 접근',
    category: 'safety',
    causes: [
      { id: 'membrane', label: '멤브레인 박막화·핀홀로 수소 크로스오버 증가', check: '같은 부하 구간에서 HTO 상승, 셀 전압·패러데이 효율 동반 변화' },
      { id: 'part_load', label: '부분부하 운전 비중 증가 (정상 현상)', check: '부하율 중앙값 추이 — 크로스오버는 부하가 낮을수록 커진다' },
      { id: 'pressure', label: '차압 운전 조건 변화 (캐소드 압력 상승)', check: '스택 차압 설정과 운전 압력 이력' },
      { id: 'analyzer', label: '분석기 교정·영점 이동 (겉보기 상승)', check: '교정 이벤트 전후 계단 변화, 기준가스 검증' },
      { id: 'recombiner', label: '탈수소(디옥소) 촉매 성능 저하', check: '촉매 입·출구 농도차, 교체 이력' },
    ],
    inspections: [
      '같은 부하 구간으로 나눈 HTO 추세',
      '분석기 교정 기록과 기준가스 검증',
      '스택 차압·운전 압력 설정 변경 이력',
      '법정 1일 1회 산소 품질검사 기록 (순도 99.5% 이상)',
      '산소 방출관·탱크실 대기 산소 농도 (23.5% 초과는 산소 농축 대기)',
    ],
    actions: [
      '압축금지 한계(2 vol%)에 가까우면 압축·출하 가능 여부를 현장 절차와 인터록으로 즉시 확인',
      '부분부하 비중이 원인이면 운전점을 올리거나 최소부하 설정을 재검토',
      '분석기 교정 뒤 기준선을 다시 잡고 재평가',
      '부하와 무관하게 오르면 멤브레인 진단과 스택 점검을 제조사와 협의',
      `운전 정지 판단은 현장 안전책임자가 한다 (${NOT_A_SAFETY_SYSTEM})`,
    ],
    falsePositiveTraps: [
      '부분부하 크로스오버 (최대 오탐원 — 기동·저부하에서는 정상적으로 높다)',
      '기동 직후 퍼지 구간 값',
      '분석기 교정·영점 이동',
      '샘플링 라인 응답 지연으로 값이 뭉개짐',
      '정지 중 잔류 가스 값 (운전 시간만 쓴다)',
    ],
    sources: [OXYGEN],
  },
};
