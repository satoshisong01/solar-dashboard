// 원인 판별 체크 측정값 키 → 표시 이름. 순수 모듈. 키는 lib/analytics/detectors의 checks.measured를 따른다.

const LABELS: Readonly<Record<string, string>> = {
  // ess.capacity_fade
  t_ref_c: '기준 셀온도 (°C)',
  t_recent_c: '최근 셀온도 (°C)',
  shift_c: '온도 변화 (°C)',
  setpoint_changes: '설정 변경 기록 (건)',
  soc_end_ref: '기준 충전 종료 SOC (%)',
  soc_end_recent: '최근 충전 종료 SOC (%)',
  cc_ah_ref: '기준 CC 구간 (Ah)',
  cc_ah_recent: '최근 CC 구간 (Ah)',
  cc_ah_change_pct: 'CC 구간 변화 (%)',
  cv_s_ref: '기준 CV 시간 (s)',
  cv_s_recent: '최근 CV 시간 (s)',
  cv_s_change_pct: 'CV 시간 변화 (%)',
  cell_dv_end_ref_mv: '기준 종료 셀 편차 (mV)',
  cell_dv_end_recent_mv: '최근 종료 셀 편차 (mV)',
  rise_mv: '편차 증가 (mV)',
  firmware_or_calibration_events: '펌웨어·교정 기록 (건)',
  jump_share_ref: '기준 SOC 점프 비율',
  jump_share_recent: '최근 SOC 점프 비율',
  // el.voltage_rise · fc.voltage_decay
  early_c: '초기 운전 온도 (°C)',
  late_c: '최근 운전 온도 (°C)',
  early_kw: '초기 블로워 전력 (kW)',
  late_kw: '최근 블로워 전력 (kW)',
  rise_pct: '블로워 전력 증가 (%)',
};

export function measuredLabel(key: string): string {
  return LABELS[key] ?? key;
}
