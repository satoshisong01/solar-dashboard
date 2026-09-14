// fc.voltage_decay 메시지: 연료전지 스택 기준 전류밀도 셀 전압 감소 (µV/h).
import type { PackFinding } from '../pack-types';
import type { Piece, Scope } from './scope';
import { stackVoltageMessage } from './stack';

export function fcVoltageDecayMessage(s: Scope, f: PackFinding): Piece {
  return stackVoltageMessage(s, f, { subject: '기준 전류밀도 셀 전압' });
}
