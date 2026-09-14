// el.voltage_rise 메시지: 전해조 스택 셀 평균 전압 상승 (µV/h).
import type { PackFinding } from '../pack-types';
import type { Piece, Scope } from './scope';
import { stackVoltageMessage } from './stack';

export function elVoltageRiseMessage(s: Scope, f: PackFinding): Piece {
  return stackVoltageMessage(s, f, { subject: '셀 평균 전압' });
}
