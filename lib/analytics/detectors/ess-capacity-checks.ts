// ess.capacity_fade 원인 판별 체크 5종 (설계 §3.1 판별 단계). 각 체크는 지지/반박/불명/데이터없음 + 측정값.
import type { EssChargeEpisode } from '../episodes/ess';
import { median } from '../stats/robust';
import { r } from './common';
import type { AssetEventInput, CheckStatus, DiagnosticCheck } from './types';

export interface CapacityCheckParams {
  /** 최근 셀 온도 중앙값이 기준보다 이만큼 낮으면 저온 영향 지지 [°C] */
  readonly coldShiftC: number;
  /** 종료 SOC 중앙값이 이만큼 낮아지면 SOC 상한 변경 지지 [%p] */
  readonly socSetpointShiftPct: number;
  /** CC 구간 Ah가 이 비율 이상 줄고 [%] */
  readonly ccAhDropPct: number;
  /** CV 시간이 이 비율 이상 늘면 내부저항 증가 지지 [%] */
  readonly cvTimeRisePct: number;
  /** 종료 셀 전압 편차가 이만큼 커지면 셀 불균형 동반 지지 [mV] */
  readonly cellDvRiseMv: number;
  /** |soc_start − soc_ocv_start|가 이 값 이상이면 재보정 점프 [%p] */
  readonly socJumpPct: number;
  /** 재보정 점프 세션 비율이 이만큼 늘면 BMS 재보정 영향 지지 */
  readonly socJumpShareRise: number;
}

type Feature = keyof EssChargeEpisode['features'];

function medianOf(sessions: readonly EssChargeEpisode[], feature: Feature): number | null {
  const values = sessions.flatMap((s) => {
    const value = s.features[feature];
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : median(values);
}

const check = (id: string, label: string, status: CheckStatus, measured: DiagnosticCheck['measured'], note: string): DiagnosticCheck => ({ id, label, status, measured, note });

function coldCheck(ref: readonly EssChargeEpisode[], cur: readonly EssChargeEpisode[], p: CapacityCheckParams): DiagnosticCheck {
  const label = '저온 영향';
  const tRef = medianOf(ref, 't_cell_mean');
  const tCur = medianOf(cur, 't_cell_mean');
  if (tRef === null || tCur === null) return check('cold', label, 'no_data', {}, '셀 온도 데이터가 없습니다.');
  const shift = tCur - tRef;
  const measured = { t_ref_c: r(tRef, 2), t_recent_c: r(tCur, 2), shift_c: r(shift, 2) };
  if (shift <= -p.coldShiftC) return check('cold', label, 'supports', measured, `최근 셀 온도가 ${Math.abs(shift).toFixed(1)}°C 낮습니다. 같은 온도 구간끼리 비교했지만 구간 안 저온 영향이 남았을 수 있습니다.`);
  if (shift > -1) return check('cold', label, 'refutes', measured, '최근 셀 온도가 기준 기간보다 낮지 않습니다.');
  return check('cold', label, 'unknown', measured, '셀 온도가 조금 낮아졌지만 판단하기에는 작습니다.');
}

function setpointCheck(ref: readonly EssChargeEpisode[], cur: readonly EssChargeEpisode[], events: readonly AssetEventInput[], since: number, p: CapacityCheckParams): DiagnosticCheck {
  const label = 'SOC 상한 설정 변경';
  const changes = events.filter((e) => e.kind === 'setpoint_change' && e.ts >= since);
  const socRef = medianOf(ref, 'soc_end');
  const socCur = medianOf(cur, 'soc_end');
  const drop = socRef === null || socCur === null ? null : socRef - socCur;
  const measured = { setpoint_changes: changes.length, soc_end_ref: r(socRef, 2), soc_end_recent: r(socCur, 2) };
  if (changes.length > 0) return check('soc_setpoint', label, 'supports', measured, `기준 기간 이후 설정값 변경 기록이 ${changes.length}건 있습니다. 변경이 맞다면 기각 사유 "운영 조건 변경"으로 기준선을 나누세요.`);
  if (drop !== null && drop >= p.socSetpointShiftPct) return check('soc_setpoint', label, 'supports', measured, `충전 종료 SOC 중앙값이 ${drop.toFixed(1)}%p 낮아졌습니다. 설정 변경 기록이 없는지 확인하세요.`);
  return check('soc_setpoint', label, 'refutes', measured, '설정값 변경 기록이 없고 충전 종료 SOC도 그대로입니다.');
}

function resistanceCheck(ref: readonly EssChargeEpisode[], cur: readonly EssChargeEpisode[], p: CapacityCheckParams): DiagnosticCheck {
  const label = 'CC 구간 Ah 감소 + CV 시간 증가 (내부저항 증가 가능성)';
  const ccRef = medianOf(ref, 'cc_ah');
  const ccCur = medianOf(cur, 'cc_ah');
  const cvRef = medianOf(ref, 'cv_s');
  const cvCur = medianOf(cur, 'cv_s');
  if (ccRef === null || ccCur === null || cvRef === null || cvCur === null || ccRef <= 0) return check('resistance', label, 'no_data', {}, 'CC·CV 구간을 나눌 데이터가 없습니다.');
  const ccChangePct = (ccCur / ccRef - 1) * 100;
  const cvChangePct = cvRef > 0 ? (cvCur / cvRef - 1) * 100 : cvCur > 0 ? 100 : 0;
  const measured = { cc_ah_ref: r(ccRef, 2), cc_ah_recent: r(ccCur, 2), cc_ah_change_pct: r(ccChangePct, 2), cv_s_ref: r(cvRef, 0), cv_s_recent: r(cvCur, 0), cv_s_change_pct: r(cvChangePct, 1) };
  if (ccChangePct <= -p.ccAhDropPct && cvChangePct >= p.cvTimeRisePct) return check('resistance', label, 'supports', measured, 'CC 구간이 짧아지고 CV 시간이 늘었습니다. 용량 감소보다 내부저항 증가로 상한에 일찍 닿는 경우일 수 있습니다.');
  if (cvChangePct <= 0) return check('resistance', label, 'refutes', measured, 'CV 시간이 늘지 않아 내부저항 증가 신호는 약합니다.');
  return check('resistance', label, 'unknown', measured, 'CV 시간은 늘었지만 CC 구간 변화가 작아 구분하기 어렵습니다.');
}

function imbalanceCheck(ref: readonly EssChargeEpisode[], cur: readonly EssChargeEpisode[], p: CapacityCheckParams): DiagnosticCheck {
  const label = '셀 전압 편차 증가 (셀 불균형 동반)';
  const dvRef = medianOf(ref, 'cell_dv_end');
  const dvCur = medianOf(cur, 'cell_dv_end');
  if (dvRef === null || dvCur === null) return check('cell_imbalance', label, 'no_data', {}, '셀 최고·최저 전압 데이터가 없습니다.');
  const rise = dvCur - dvRef;
  const measured = { cell_dv_end_ref_mv: r(dvRef, 1), cell_dv_end_recent_mv: r(dvCur, 1), rise_mv: r(rise, 1) };
  if (rise >= p.cellDvRiseMv) return check('cell_imbalance', label, 'supports', measured, `충전 종료 셀 전압 편차가 ${rise.toFixed(1)} mV 커졌습니다. 밸런싱 후 다시 비교하면 용량 일부가 회복될 수 있습니다.`);
  if (rise <= 3) return check('cell_imbalance', label, 'refutes', measured, '셀 전압 편차는 그대로입니다.');
  return check('cell_imbalance', label, 'unknown', measured, '셀 전압 편차가 조금 커졌습니다.');
}

function jumpShare(sessions: readonly EssChargeEpisode[], p: CapacityCheckParams): { share: number; n: number } | null {
  const pairs = sessions.filter((s) => s.features.soc_start !== null && s.features.soc_ocv_start !== null);
  if (pairs.length === 0) return null;
  const jumps = pairs.filter((s) => Math.abs((s.features.soc_start ?? 0) - (s.features.soc_ocv_start ?? 0)) >= p.socJumpPct).length;
  return { share: jumps / pairs.length, n: pairs.length };
}

function bmsCheck(ref: readonly EssChargeEpisode[], cur: readonly EssChargeEpisode[], events: readonly AssetEventInput[], since: number, p: CapacityCheckParams): DiagnosticCheck {
  const label = 'BMS SOC 재보정';
  const firmware = events.filter((e) => (e.kind === 'firmware' || e.kind === 'calibration') && e.ts >= since).length;
  const shareRef = jumpShare(ref, p);
  const shareCur = jumpShare(cur, p);
  const measured = { firmware_or_calibration_events: firmware, jump_share_ref: r(shareRef?.share ?? null, 3), jump_share_recent: r(shareCur?.share ?? null, 3) };
  if (firmware > 0) return check('bms_recalibration', label, 'supports', measured, 'BMS 펌웨어·교정 기록이 있습니다. SOC 산식이 바뀌면 앵커 용량 추정이 달라질 수 있습니다.');
  if (shareRef === null || shareCur === null) return check('bms_recalibration', label, 'no_data', measured, '휴지 후 SOC 비교 데이터가 없습니다.');
  if (shareCur.share - shareRef.share >= p.socJumpShareRise) return check('bms_recalibration', label, 'supports', measured, '충전 시작 시 SOC가 튀는 세션이 늘었습니다. BMS 재보정 영향일 수 있습니다.');
  return check('bms_recalibration', label, 'refutes', measured, 'SOC 재보정 점프는 늘지 않았습니다.');
}

/** 기준·최근 세션과 설비 이벤트로 원인 후보 5개를 판별한다. since = 기준 기간 끝 */
export function capacityChecks(
  reference: readonly EssChargeEpisode[],
  recent: readonly EssChargeEpisode[],
  events: readonly AssetEventInput[],
  since: number,
  params: CapacityCheckParams,
): DiagnosticCheck[] {
  return [
    coldCheck(reference, recent, params),
    setpointCheck(reference, recent, events, since, params),
    resistanceCheck(reference, recent, params),
    imbalanceCheck(reference, recent, params),
    bmsCheck(reference, recent, events, since, params),
  ];
}
