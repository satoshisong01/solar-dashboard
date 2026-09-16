// 가평 구성 고장 주입 정답 (기대 고장모드·탐지기·부수 탐지기). 고장모드 키는 lib/analytics/detectors/types.ts FailureMode와 같다.
import type { SiteDef } from '@/db/seed/types';
import { resolveGapyeongFault, type GapyeongFaultKind, type GapyeongFaultScenario } from './fault-scenarios-gapyeong';
import type { RunBounds, P3Expectation } from './truth-p3';
import type { InjectionTruth } from './truth';

const PRV_SEAT_LEAK: P3Expectation = { failureModes: ['prv.seat_leak'], detectors: ['prv.seat_leak'], related: [] };
const HX_FOULING: P3Expectation = { failureModes: ['hx.heat_recovery_loss'], detectors: ['hx.fouling'], related: [] };
const O2_PURITY: P3Expectation = { failureModes: ['o2.purity_drift'], detectors: ['o2.purity_drift'], related: [] };
/** 수질 악화는 아직 전용 탐지기가 없다 — 데이터는 쌓이지만 재현율을 재지 않는다 */
const WATER_QUALITY: P3Expectation = { failureModes: [], detectors: [], related: [] };
/** 반입 기록 누락은 원장 delivered가 과소 집계돼 물질수지 잔차로 나타난다 */
const DELIVERY_UNLOGGED: P3Expectation = { failureModes: ['h2chain.mass_balance_gap'], detectors: ['h2chain.mass_balance_gap'], related: [] };

export const GAPYEONG_FAULT_EXPECTATION: Readonly<Record<GapyeongFaultKind, P3Expectation>> = {
  'fault.prv_seat_leak': PRV_SEAT_LEAK,
  'fault.hx_fouling': HX_FOULING,
  'fault.o2_purity_drift': O2_PURITY,
  'fault.water_quality': WATER_QUALITY,
  'fault.delivery_unlogged': DELIVERY_UNLOGGED,
};

export function gapyeongFaultTruths(site: SiteDef, fault: GapyeongFaultScenario, run: RunBounds): InjectionTruth[] {
  const resolved = resolveGapyeongFault(site, fault, run.originMs);
  const expectation = GAPYEONG_FAULT_EXPECTATION[fault.kind];
  return resolved.assetCodes.map((code) => ({
    siteCode: site.code,
    assetPath: `${site.code}/${code}`,
    kind: fault.kind,
    startTs: Math.max(resolved.startMs, run.fromMs),
    endTs: resolved.recoveredMs === null ? run.toMs : Math.min(resolved.recoveredMs, run.toMs),
    params: { ...resolved.params, fullEffectTs: resolved.fullEffectMs },
    expectedFailureModes: expectation.failureModes,
    expectedDetectors: expectation.detectors,
    ...(expectation.related.length > 0 ? { relatedDetectors: expectation.related } : {}),
  }));
}
