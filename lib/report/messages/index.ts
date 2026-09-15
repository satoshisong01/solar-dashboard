// 탐지기 id → 한국어 메시지 템플릿. 판정 보류는 탐지기와 상관없이 관찰 중 문장만 쓴다.
import type { PackFinding } from '../pack-types';
import { genericMessage, holdMessage } from './common';
import { dqGapFlatlineMessage } from './dq-gap-flatline';
import { elVoltageRiseMessage } from './el-voltage-rise';
import { essCapacityFadeMessage } from './ess-capacity-fade';
import { essCellImbalanceMessage } from './ess-cell-imbalance';
import { fcVoltageDecayMessage } from './fc-voltage-decay';
import { massBalanceMessage } from './mass-balance';
import { pvInverterPeerMessage } from './pv-inverter-peer';
import { riseMessage } from './rise';
import type { Piece, Scope } from './scope';
import { soilingMessage } from './soiling';
import { tankLeakMessage } from './tank-leak';
import { thermalMessage } from './thermal';

type MessageTemplate = (s: Scope, f: PackFinding) => Piece;

const TEMPLATES: Readonly<Record<string, MessageTemplate>> = {
  'ess.capacity_fade': essCapacityFadeMessage,
  'ess.cell_imbalance': essCellImbalanceMessage,
  'pv.inverter_peer': pvInverterPeerMessage,
  'el.voltage_rise': elVoltageRiseMessage,
  'fc.voltage_decay': fcVoltageDecayMessage,
  'dq.gap_flatline': dqGapFlatlineMessage,
  'el.sec_rise': riseMessage,
  'comp.sec_rise': riseMessage,
  'fc.blower_wear': riseMessage,
  'ess.resistance_growth': riseMessage,
  'tank.static_leak': tankLeakMessage,
  'h2chain.mass_balance_gap': massBalanceMessage,
  'pv.soiling_rate': soilingMessage,
  'inv.thermal_derating': thermalMessage,
};

/** s는 findings[i] 범위 */
export function findingMessage(s: Scope, f: PackFinding): Piece {
  if (f.judgement === 'hold') return holdMessage(s, f);
  return (TEMPLATES[f.detectorId] ?? genericMessage)(s, f);
}

export { adviceMessage } from './common';
export { scopeOf, type Scope } from './scope';
export { MESSAGE_TEMPLATE_VERSION } from './version';
