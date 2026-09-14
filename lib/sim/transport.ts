// 게이트웨이 전송 계층: 전송 지연, 통신 단절(보류 후 역순 백필), 중복 재전송.
import type { SimEvent } from './events';
import type { PlantSample } from './plant';
import type { Rng } from './rng';
import type { TimeWindow } from './scenarios';

const MIN_LATENCY_MS = 150;
const MAX_LATENCY_MS = 1_500;
const BACKFILL_SPACING_MS = 1_000;
const RESEND_DELAY_MS = 2_000;

export interface PendingBatch {
  readonly seq: number;
  readonly windowEndMs: number;
  readonly samples: readonly PlantSample[];
  readonly events: readonly SimEvent[];
}

export interface Transmission {
  readonly batch: PendingBatch;
  /** 실제 전송 시각 (게이트웨이 시계 오차 제외) */
  readonly sentAtMs: number;
  /** 같은 배치를 본문 그대로 다시 보냄 */
  readonly resend: boolean;
  /** 통신 단절 뒤 보류분을 보냄 */
  readonly backfill: boolean;
}

export interface TransportPlan {
  readonly outages: readonly TimeWindow[];
  readonly duplicateRatio: number;
}

export interface GatewayTransport {
  /** 배치가 만들어졌을 때 호출한다. 지금 전송되는 것을 전송 순서대로 돌려준다. */
  push(batch: PendingBatch): readonly Transmission[];
  /** 실행이 끝났을 때 보류 중인 배치를 모두 보낸다. */
  finish(): readonly Transmission[];
}

interface HeldBatch {
  readonly batch: PendingBatch;
  readonly outage: TimeWindow;
}

export function createGatewayTransport(plan: TransportPlan, rng: Rng): GatewayTransport {
  let held: readonly HeldBatch[] = [];
  let lastSentMs = -Infinity;

  /** 게이트웨이 안에서 전송 시각이 줄지 않게 한다. */
  const stamp = (candidateMs: number): number => {
    lastSentMs = Math.max(candidateMs, lastSentMs + 1);
    return lastSentMs;
  };

  const send = (batch: PendingBatch, candidateMs: number, backfill: boolean): Transmission[] => {
    const original: Transmission = { batch, sentAtMs: stamp(candidateMs), resend: false, backfill };
    if (!rng.chance(plan.duplicateRatio)) return [original];
    return [original, { ...original, sentAtMs: stamp(original.sentAtMs + RESEND_DELAY_MS), resend: true }];
  };

  /** 끝난 단절의 보류분을 최신 배치부터(역순) 보낸다. */
  const release = (untilMs: number): Transmission[] => {
    const ready = held.filter((h) => h.outage.endMs <= untilMs);
    held = held.filter((h) => h.outage.endMs > untilMs);
    return [...ready].reverse().flatMap((h) => send(h.batch, Math.max(h.outage.endMs, lastSentMs) + BACKFILL_SPACING_MS, true));
  };

  return {
    push(batch) {
      const candidateMs = batch.windowEndMs + Math.floor(rng.uniform(MIN_LATENCY_MS, MAX_LATENCY_MS));
      const outage = plan.outages.find((o) => candidateMs >= o.startMs && candidateMs < o.endMs);
      if (outage) {
        held = [...held, { batch, outage }];
        return [];
      }
      return [...release(candidateMs), ...send(batch, candidateMs, false)];
    },
    finish() {
      return release(Infinity);
    },
  };
}
