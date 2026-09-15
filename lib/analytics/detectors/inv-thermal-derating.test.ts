import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { InverterThermalSample } from '../episodes/inverter-thermal';
import { kstDayStart, MS_PER_DAY, MS_PER_HOUR } from '../types';
import { INV_THERMAL_DERATING_DEFAULTS, invThermalDerating, type InvThermalDeratingInput, type ThermalInverter } from './inv-thermal-derating';
import { DAY0 } from './test-fixtures';

const DAYS = 60;
const FIRST = kstDayStart(DAY0);
const NOW = FIRST + DAYS * MS_PER_DAY;
const BUCKET_MS = 5 * 60_000;
const INVERTERS: ThermalInverter[] = [1, 2, 3, 4].map((assetId) => ({ assetId, dcKwp: 250, derateStartC: 70 }));
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface SiteOptions {
  readonly seed: number;
  /** 이 날부터 4번 인버터 방열판 온도 추가 상승 [°C] (냉각팬·필터 열화) */
  readonly coolingLoss?: { readonly fromDay: number; readonly extraC: number };
  /** 모든 인버터 추가 상승 (설치실 환기 불량) */
  readonly allHotC?: number;
  /** 4번 인버터 출력제한 [%] 날 */
  readonly limitedDays?: readonly number[];
  /** 4번 인버터 출력 저하(방열판은 정상) — 스트링 문제 */
  readonly coldLossPct?: number;
  readonly ambientOffsetC?: number;
}

/** 08~17시 5분 버킷. 방열판 = 외기 + 5 + 35 × 부하. 저감 시작(70 °C) 넘으면 °C당 2%씩 출력 제한 */
function site(o: SiteOptions): { samples: InverterThermalSample[] } {
  const rng = createRng(o.seed);
  const samples: InverterThermalSample[] = [];
  for (let day = 0; day < DAYS; day += 1) {
    const ambientMax = 26 + 6 * Math.sin(day / 9) + (o.ambientOffsetC ?? 0);
    for (let k = 0; k < 108; k += 1) {
      const ts = FIRST + day * MS_PER_DAY + 8 * MS_PER_HOUR + k * BUCKET_MS;
      const shape = Math.sin((Math.PI * (k + 0.5)) / 108);
      const load = 0.85 * shape;
      const ambient = ambientMax - 6 * (1 - shape);
      for (const inv of INVERTERS) {
        const extra = (inv.assetId === 4 && o.coolingLoss && day >= o.coolingLoss.fromDay ? o.coolingLoss.extraC : 0) + (o.allHotC ?? 0);
        const heatsink = ambient + 5 + 35 * load + extra;
        const derateFrac = heatsink > 70 ? Math.min(0.5, 0.02 * (heatsink - 70) + 0.06) : 0;
        const limited = inv.assetId === 4 && (o.limitedDays?.includes(day) ?? false);
        const coldLoss = inv.assetId === 4 ? (o.coldLossPct ?? 0) / 100 : 0;
        const available = load * (1 - coldLoss) * (1 + 0.003 * rng.gaussian());
        const own = limited ? Math.min(available, 0.5) : available * (1 - derateFrac);
        samples.push({ ts, assetId: inv.assetId, kwPerKwp: own, heatsinkC: heatsink, limitPct: limited ? 50 : 100, ambientC: ambient });
      }
    }
  }
  return { samples };
}

/** 최근 30일 4번 인버터 실제 손실률 (생성기에서 직접 다시 계산) */
function truthRecentLossPct(samples: readonly InverterThermalSample[]): number {
  const recentFrom = NOW - 30 * MS_PER_DAY;
  const byTs = new Map<number, InverterThermalSample[]>();
  for (const s of samples.filter((x) => x.ts >= recentFrom)) byTs.set(s.ts, [...(byTs.get(s.ts) ?? []), s]);
  let loss = 0;
  let energy = 0;
  for (const group of byTs.values()) {
    const own = group.find((s) => s.assetId === 4);
    const peers = group.filter((s) => s.assetId !== 4).map((s) => s.kwPerKwp);
    if (!own || own.limitPct !== 100) continue;
    const reference = peers.reduce((a, b) => a + b, 0) / peers.length;
    energy += own.kwPerKwp;
    if ((own.heatsinkC ?? 0) > 70) loss += Math.max(0, reference - own.kwPerKwp);
  }
  return (loss / (loss + energy)) * 100;
}

const run = (o: SiteOptions, extra: Partial<InvThermalDeratingInput> = {}, params = {}) => invThermalDerating.detect({ siteId: 1, inverters: INVERTERS, samples: site(o).samples, ...extra }, ctx(params));
const checksOf = (result: ReturnType<typeof run>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('inv.thermal_derating@1', () => {
  it('4번 인버터 냉각 열화(방열판 +18 °C) 열 저감 손실을 실제 손실률 ± 15%로 복원하고 판별 체크를 기록한다', () => {
    const { samples } = site({ seed: 2, coolingLoss: { fromDay: 20, extraC: 18 } });
    const truth = truthRecentLossPct(samples);
    const result = invThermalDerating.detect({ siteId: 1, inverters: INVERTERS, samples, faultEvents: [{ assetId: 4, ts: NOW - 5 * MS_PER_DAY, code: 'FAN_FAULT' }] }, ctx());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.findings.map((f) => f.assetId)).toEqual([4]);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'inv.thermal_derating', failureMode: 'pv.inverter_thermal_derating', category: 'performance', effect: { metric: 'thermal_derate_loss_pct', unit: '%' } });
    expect(truth).toBeGreaterThan(1);
    expect(finding?.effect.value).toBeGreaterThan(truth * 0.85);
    expect(finding?.effect.value).toBeLessThan(truth * 1.15);
    expect(finding?.severity).toBe(truth >= 3 ? 3 : 2);
    expect(checksOf(result)).toEqual({ ambient_hot: 'refutes', fan_fault: 'supports', installation_environment: 'refutes', curtailment_confusion: 'refutes' });
    const evidence = finding?.evidence as { representative_day: { points: unknown[] }; ambient_bins: unknown[] };
    expect(evidence.representative_day.points.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(finding?.evidence).length).toBeLessThan(20_000);
  });

  it('대조군: 정상 · 출력제한 3일 · 동종 전체 고온(설치실) · 방열판 정상인 출력 저하(스트링)는 0건', () => {
    expect(run({ seed: 3 })).toEqual({ status: 'ok', findings: [] });
    expect(run({ seed: 4, limitedDays: [45, 50, 55] })).toEqual({ status: 'ok', findings: [] });
    expect(run({ seed: 5, allHotC: 18 })).toEqual({ status: 'ok', findings: [] });
    expect(run({ seed: 6, coldLossPct: 10 })).toEqual({ status: 'ok', findings: [] });
  });

  it('고장 코드 입력이 없으면 냉각팬 체크는 데이터없음, 출력제한 신호가 없으면 혼동 배제 체크도 데이터없음', () => {
    const { samples } = site({ seed: 7, coolingLoss: { fromDay: 10, extraC: 20 } });
    const noLimit = samples.map((s) => ({ ...s, limitPct: null }));
    const result = invThermalDerating.detect({ siteId: 1, inverters: INVERTERS, samples: noLimit }, ctx());
    expect(checksOf(result)).toMatchObject({ fan_fault: 'no_data', curtailment_confusion: 'no_data' });
  });

  it('insufficient: 동종 부족·저출력뿐, 결정성·스키마 기본값', () => {
    const { samples } = site({ seed: 8, coolingLoss: { fromDay: 20, extraC: 18 } });
    expect(invThermalDerating.detect({ siteId: 1, inverters: INVERTERS.slice(0, 2), samples }, ctx()).status).toBe('insufficient');
    expect(invThermalDerating.detect({ siteId: 1, inverters: INVERTERS, samples: samples.map((s) => ({ ...s, kwPerKwp: s.kwPerKwp * 0.2 })) }, ctx()).status).toBe('insufficient');
    const input = { siteId: 1, inverters: INVERTERS, samples };
    expect(invThermalDerating.detect(input, ctx())).toEqual(invThermalDerating.detect(input, ctx()));
    expect(invThermalDerating.paramSchema.parse({})).toEqual(INV_THERMAL_DERATING_DEFAULTS);
  });
});
