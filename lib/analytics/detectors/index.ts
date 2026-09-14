// P2 탐지기 6종 (설계 §5.3 로드맵). 입력 로드는 다음 단계(load 계층)가 구현한다.
import { dqGapFlatline } from './dq-gap-flatline';
import { essCapacityFade } from './ess-capacity-fade';
import { essCellImbalance } from './ess-cell-imbalance';
import { pvInverterPeer } from './pv-inverter-peer';
import { elVoltageRise, fcVoltageDecay } from './stack-detectors';

export const P2_DETECTORS = Object.freeze([dqGapFlatline, essCapacityFade, essCellImbalance, pvInverterPeer, elVoltageRise, fcVoltageDecay] as const);

export type P2DetectorId = (typeof P2_DETECTORS)[number]['id'];

export { dqGapFlatline, DQ_GAP_FLATLINE_DEFAULTS, type DqGapFlatlineInput, type DqGapFlatlineParams, type DqPointSummary } from './dq-gap-flatline';
export { capacityChecks, type CapacityCheckParams } from './ess-capacity-checks';
export { essCapacityFade, ESS_CAPACITY_DEFAULTS, type EssCapacityInput, type EssCapacityParams } from './ess-capacity-fade';
export { cellDvPoints, essCellImbalance, ESS_CELL_IMBALANCE_DEFAULTS, type CellDvPoint, type EssCellImbalanceInput, type EssCellImbalanceParams } from './ess-cell-imbalance';
export { pvInverterPeer, PV_INVERTER_PEER_DEFAULTS, type PvInverterPeerInput, type PvInverterPeerParams } from './pv-inverter-peer';
export { elVoltageRise, EL_VOLTAGE_RISE_DEFAULTS, fcVoltageDecay, FC_VOLTAGE_DECAY_DEFAULTS, type StackDetectorParams, type StackVoltageInput } from './stack-detectors';
export type * from './types';
