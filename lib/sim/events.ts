// 시뮬레이터가 내보내는 이산 이벤트와 운전 상태 코드.

export type EventSeverity = 'info' | 'warning' | 'major' | 'critical';

export interface SimEvent {
  /** `${설비 코드}/EVENT`(운전) 또는 `${설비 코드}/ALARM`(안전). 설비 코드 = 마지막 '/' 앞부분 */
  readonly src: string;
  readonly ts: number;
  readonly code: string;
  readonly severity: EventSeverity;
  readonly text?: string;
}

export const EVENT_CODE = Object.freeze({
  START: 'START',
  STOP: 'STOP',
  INVERTER_TRIP: 'INV_TRIP',
  INVERTER_RESTART: 'INV_RESTART',
  /** h2.detector 안전 이벤트 코드 (catalog safetyEventCodes) */
  H2_LEAK_L1: 'H2_LEAK_L1',
});

/** op.state 포인트 값 */
export const OP_STATE = Object.freeze({
  OFF: 0,
  STANDBY: 1,
  STARTING: 2,
  RUNNING: 3,
  STOPPING: 4,
  FAULT: 5,
});

const MODE_TO_STATE: Readonly<Record<string, number>> = {
  off: OP_STATE.OFF,
  standby: OP_STATE.STANDBY,
  starting: OP_STATE.STARTING,
  running: OP_STATE.RUNNING,
  stopping: OP_STATE.STOPPING,
  fault: OP_STATE.FAULT,
};

export function opStateCode(mode: string): number {
  const code = MODE_TO_STATE[mode];
  if (code === undefined) throw new Error(`운전 상태 코드가 없는 모드: ${mode}`);
  return code;
}

export const operationEvent = (assetCode: string, ts: number, code: string, severity: EventSeverity, text?: string): SimEvent =>
  text === undefined ? { src: `${assetCode}/EVENT`, ts, code, severity } : { src: `${assetCode}/EVENT`, ts, code, severity, text };

export const safetyAlarm = (assetCode: string, ts: number, code: string, text: string): SimEvent => ({
  src: `${assetCode}/ALARM`,
  ts,
  code,
  severity: 'critical',
  text,
});
