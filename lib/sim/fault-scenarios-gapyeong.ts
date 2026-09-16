// 가평 구성 부속 계통 고장 시나리오: 감압밸브 시트 누설 · 열교환기 오염 · 수질 악화 · 산소 순도 저하(HTO) · 반입 기록 누락.
// startDay·rampDays는 실행 기준일(실행 시작 시각이 속한 KST 날짜 0시)부터 센 일수다. 결과는 P2·P3와 같은 열화 파라미터 hook이다.
import type { SiteDef } from '@/db/seed/types';
import { levelRampHook, type DegradationHook, type FaultScenario } from './degradation';
import { assetOfClass, hookFor, requireRange, startMsOf } from './fault-scenarios';
import { MS_PER_DAY } from './math';
import { singleAsset } from './plant-types';

export const GAPYEONG_FAULT_DEFAULTS = Object.freeze({
  /** 수준형 고장이 목표 크기에 도달하는 기본 일수 */
  rampDays: 30,
});

/** 감압밸브 시트 누설: 무유동 구간 하류 압력이 시간당 barPerH씩 오른다 (락업 크리프) */
export interface PrvSeatLeakFault {
  readonly kind: 'fault.prv_seat_leak';
  readonly site: string;
  readonly barPerH: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 열교환기 오염: 같은 조건에서 UA가 pct% 떨어진다 (접근온도 상승) */
export interface HxFoulingFault {
  readonly kind: 'fault.hx_fouling';
  readonly site: string;
  readonly pct: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 수질 악화: 순수 전도도가 uScmRise [µS/cm]만큼 오른다 (혼상수지 파과·교차누설) */
export interface WaterQualityFault {
  readonly kind: 'fault.water_quality';
  readonly site: string;
  readonly uScmRise: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 산소 순도 저하: 애노드 원가스 HTO가 pctPoints [vol%p]만큼 오른다 (법정 압축금지선 2 vol%) */
export interface O2PurityDriftFault {
  readonly kind: 'fault.o2_purity_drift';
  readonly site: string;
  readonly pctPoints: number;
  readonly startDay?: number;
  readonly rampDays?: number;
}
/** 반입 기록 누락: days일 동안 하역은 실제로 일어나는데 계량 적산이 늘지 않는다 (물질수지 잔차가 음으로 벌어진다) */
export interface DeliveryUnloggedFault {
  readonly kind: 'fault.delivery_unlogged';
  readonly site: string;
  readonly startDay: number;
  readonly days: number;
}

export type GapyeongFaultScenario = PrvSeatLeakFault | HxFoulingFault | WaterQualityFault | O2PurityDriftFault | DeliveryUnloggedFault;
export type GapyeongFaultKind = GapyeongFaultScenario['kind'];

export const GAPYEONG_FAULT_KINDS: readonly GapyeongFaultKind[] = ['fault.prv_seat_leak', 'fault.hx_fouling', 'fault.water_quality', 'fault.o2_purity_drift', 'fault.delivery_unlogged'];

export const isGapyeongFault = (scenario: { readonly kind: string }): scenario is GapyeongFaultScenario => (GAPYEONG_FAULT_KINDS as readonly string[]).includes(scenario.kind);

export interface ResolvedGapyeongFault {
  readonly hooks: readonly FaultScenario[];
  readonly assetCodes: readonly string[];
  readonly startMs: number;
  /** 크기가 목표에 다 도달하는 시각 */
  readonly fullEffectMs: number;
  /** 회복 시각 (반입 기록 누락 구간의 끝). null이면 실행 끝까지 */
  readonly recoveredMs: number | null;
  readonly params: Readonly<Record<string, number | string>>;
}

function rampMsOf(rampDays: number | undefined, label: string): number {
  const days = rampDays ?? GAPYEONG_FAULT_DEFAULTS.rampDays;
  if (!Number.isFinite(days) || days < 0 || days > 3_650) throw new Error(`${label} rampDays는 0~3650: ${days}`);
  return days * MS_PER_DAY;
}

/** 가평 부속 계통 고장을 설비·시각·hook으로 푼다. 설비가 없거나 크기가 범위 밖이면 오류. */
export function resolveGapyeongFault(site: SiteDef, fault: GapyeongFaultScenario, originMs: number): ResolvedGapyeongFault {
  const startMs = startMsOf(originMs, fault.startDay, fault.kind);
  switch (fault.kind) {
    case 'fault.prv_seat_leak': {
      const asset = singleAsset(site, 'h2.prv');
      const barPerH = requireRange(fault.barPerH, `${fault.kind} barPerH`, 0, 5);
      const rampMs = rampMsOf(fault.rampDays, fault.kind);
      return {
        hooks: [hookFor(site, 'prv.seatLeakBarPerH', asset.code, levelRampHook(startMs, rampMs, barPerH))],
        assetCodes: [asset.code],
        startMs,
        fullEffectMs: startMs + rampMs,
        recoveredMs: null,
        params: { barPerH, mbarPerH: barPerH * 1000 },
      };
    }
    case 'fault.hx_fouling': {
      const asset = singleAsset(site, 'hx.recovery');
      const pct = requireRange(fault.pct, `${fault.kind} pct`, 0, 90);
      const rampMs = rampMsOf(fault.rampDays, fault.kind);
      return {
        hooks: [hookFor(site, 'hx.fouling', asset.code, levelRampHook(startMs, rampMs, pct / 100))],
        assetCodes: [asset.code],
        startMs,
        fullEffectMs: startMs + rampMs,
        recoveredMs: null,
        params: { pct },
      };
    }
    case 'fault.water_quality': {
      const asset = singleAsset(site, 'h2.elz.water');
      const rise = requireRange(fault.uScmRise, `${fault.kind} uScmRise`, 0, 100);
      const rampMs = rampMsOf(fault.rampDays, fault.kind);
      return {
        hooks: [hookFor(site, 'water.conductivityRise', asset.code, levelRampHook(startMs, rampMs, rise))],
        assetCodes: [asset.code],
        startMs,
        fullEffectMs: startMs + rampMs,
        recoveredMs: null,
        params: { uScmRise: rise },
      };
    }
    case 'fault.o2_purity_drift': {
      const asset = singleAsset(site, 'o2.plant');
      const pctPoints = requireRange(fault.pctPoints, `${fault.kind} pctPoints`, 0, 10);
      const rampMs = rampMsOf(fault.rampDays, fault.kind);
      return {
        hooks: [hookFor(site, 'o2.htoRise', asset.code, levelRampHook(startMs, rampMs, pctPoints))],
        assetCodes: [asset.code],
        startMs,
        fullEffectMs: startMs + rampMs,
        recoveredMs: null,
        params: { pctPoints },
      };
    }
    case 'fault.delivery_unlogged': {
      const asset = assetOfClass(site, singleAsset(site, 'h2.delivery').code, 'delivery.meterGain', fault.kind);
      const days = requireRange(fault.days, `${fault.kind} days`, 1, 365);
      const endMs = startMs + days * MS_PER_DAY;
      // 계량 이득 0 = 하역은 그대로인데 적산계가 늘지 않는다 (전표도 없으면 원장 delivered가 과소 집계된다)
      const value: DegradationHook = (tMs, baseline) => (tMs >= startMs && tMs < endMs ? 0 : baseline);
      return {
        hooks: [hookFor(site, 'delivery.meterGain', asset.code, value)],
        assetCodes: [asset.code],
        startMs,
        fullEffectMs: startMs,
        recoveredMs: endMs,
        params: { days },
      };
    }
  }
}
