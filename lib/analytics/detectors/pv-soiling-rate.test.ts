import { describe, expect, it } from 'vitest';
import { createRng } from '@/lib/sim/rng';
import type { PvDayEpisode } from '../episodes/pv';
import type { WxDayEpisode } from '../episodes/wx-day';
import { kstDayStart, MS_PER_DAY } from '../types';
import { PV_SOILING_DEFAULTS, pvSoilingRate, type PvSoilingInput } from './pv-soiling-rate';
import { DAY0, DQ_FULL } from './test-fixtures';

const DAYS = 120;
const FIRST = kstDayStart(DAY0);
const NOW = FIRST + DAYS * MS_PER_DAY;
const KWP = 250;
const GAMMA = -0.0035;
const ctx = (params = {}, seed = 1) => ({ now: NOW, rng: createRng(seed), params });

interface SiteOptions {
  readonly seed: number;
  /** 오염 누적률 [%/일] */
  readonly soilingPctPerDay: number;
  /** 이 날들에 강우로 오염이 초기화된다 */
  readonly rainDays?: readonly number[];
  /** 흐린 날 (일사 낮고 변동 큼) */
  readonly cloudyDays?: readonly number[];
  readonly curtailedDays?: readonly number[];
  /** 오염되는 인버터 번호 (기본: 전부) */
  readonly soiledInverters?: readonly number[];
}

function site(o: SiteOptions): Pick<PvSoilingInput, 'inverterDays' | 'wxDays'> {
  const rng = createRng(o.seed);
  const rain = [0, ...(o.rainDays ?? [])];
  const wxDays: WxDayEpisode[] = [];
  const inverterDays: PvDayEpisode[] = [];
  for (let day = 0; day < DAYS; day += 1) {
    const start = FIRST + day * MS_PER_DAY;
    const cloudy = o.cloudyDays?.includes(day) ?? day % 6 === 5;
    const poa = cloudy ? 2.2 + rng.next() : 6 + 0.2 * Math.sin(day / 20) + 0.05 * rng.next();
    const tmod = 30 + 8 * Math.sin(day / 25);
    wxDays.push({ assetId: 1, kind: 'wx.day', extractorVersion: 'wx.day@1', start, end: start + MS_PER_DAY, features: { day: '', poa_kwh_m2: poa, ghi_kwh_m2: poa * 0.85, tmod_weighted_c: tmod, poa_peak_w_m2: 950, variability: cloudy ? 2.4 : 1.05, sun_h: 10 }, conditions: {}, dq: DQ_FULL, open: false, valid: true, invalidReason: null });
    const sinceRain = day - Math.max(...rain.filter((d) => d <= day));
    const curtailed = o.curtailedDays?.includes(day) ?? false;
    for (let inv = 1; inv <= 4; inv += 1) {
      const soiled = o.soiledInverters === undefined || o.soiledInverters.includes(inv);
      const soiling = soiled ? (o.soilingPctPerDay / 100) * sinceRain : 0;
      const pi = 0.86 * (1 - soiling) * (cloudy ? 0.93 : 1) * (curtailed ? 0.7 : 1) * (1 + 0.004 * rng.gaussian());
      const energy = KWP * poa * (1 + GAMMA * (tmod - 25)) * pi;
      inverterDays.push({ assetId: inv, kind: 'pv.day', extractorVersion: 'pv.day@1', start, end: start + MS_PER_DAY, features: { day: '', energy_kwh: energy, kwh_per_kwp: energy / KWP, operating_h: 11, sun_h: null, insolation_kwh_m2: null, clipping_ratio: 0, curtailed_h: curtailed ? 3 : 0, stopped_h: 0, trip_count: 0 }, conditions: { curtailed, clipping: false, stopped: false }, dq: DQ_FULL, open: false, valid: true, invalidReason: null });
    }
  }
  return { inverterDays, wxDays };
}

const run = (o: SiteOptions, extra: Partial<PvSoilingInput> = {}, params = {}) => pvSoilingRate.detect({ siteId: 2, assetId: 20, gammaPerC: GAMMA, cleaningTs: [], smpKrwPerKwh: 150, ...site(o), ...extra }, ctx(params));
const checksOf = (result: ReturnType<typeof run>) => (result.status === 'ok' ? Object.fromEntries(((result.findings[0]?.evidence.checks ?? []) as { id: string; status: string }[]).map((c) => [c.id, c.status])) : {});

describe('pv.soiling_rate@1', () => {
  it('강우 사이 오염 0.1%/일 주입을 맑은 날 PI 기울기로 ±15% 복원, 누적 손실 약 5% severity 3, 세척 경제성 문장', () => {
    const result = run({ seed: 2, soilingPctPerDay: 0.1, rainDays: [30, 70] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const [finding] = result.findings;
    expect(finding).toMatchObject({ detectorId: 'pv.soiling_rate', assetId: 20, failureMode: 'pv.soiling', category: 'performance', severity: 3, effect: { metric: 'soiling_loss_pct', unit: '%' } });
    const rate = (finding?.evidence as { rate_pct_per_day: number }).rate_pct_per_day;
    expect(rate).toBeGreaterThan(0.1 * 0.85);
    expect(rate).toBeLessThan(0.1 * 1.15);
    expect(finding?.effect.value).toBeGreaterThan(4);
    expect(finding?.effect.value).toBeLessThan(5.6);
    expect(finding?.summary).toContain('SMP 150.0원/kWh');
    expect(checksOf(result)).toEqual({ site_wide: 'supports', irradiance_sensor: 'refutes', seasonal_incidence: 'unknown', restoration_recovery: 'supports' });
    const evidence = finding?.evidence as { resets: { kind: string }[]; pi_points: unknown[] };
    expect(evidence.resets.map((x) => x.kind)).toEqual(['pi_step', 'pi_step']);
    expect(evidence.pi_points.length).toBeLessThanOrEqual(120);
  });

  it('세척 이벤트로 복원 시점을 받고, SMP가 없으면 "가격 데이터 없음"', () => {
    const result = run({ seed: 3, soilingPctPerDay: 0.08, rainDays: [70] }, { cleaningTs: [FIRST + 70 * MS_PER_DAY + 3_600_000], smpKrwPerKwh: null });
    expect(result.status === 'ok' && result.findings[0]?.summary).toContain('가격 데이터 없음');
    const evidence = result.status === 'ok' ? (result.findings[0]?.evidence as { resets: { kind: string }[] }) : { resets: [] };
    expect(evidence.resets.at(-1)?.kind).toBe('cleaning');
  });

  it('대조군: 오염 없음 + 흐린 주 + 출력제한 3회는 0건, 일부 인버터만 오염되면 동종 이상으로 빠져 0건', () => {
    const cloudyWeek = [...Array.from({ length: 7 }, (_, i) => 100 + i), 5, 11, 17, 23, 29, 35, 41, 47, 53, 59, 65, 71, 77, 83, 89, 95];
    expect(run({ seed: 4, soilingPctPerDay: 0, cloudyDays: cloudyWeek, curtailedDays: [60, 85, 110] })).toEqual({ status: 'ok', findings: [] });
    expect(run({ seed: 5, soilingPctPerDay: 0.4, rainDays: [70], soiledInverters: [2] })).toEqual({ status: 'ok', findings: [] });
    expect(run({ seed: 6, soilingPctPerDay: 0.02, rainDays: [70] })).toEqual({ status: 'ok', findings: [] });
  });

  it('insufficient: 최근 복원 뒤 구간이 짧음 · 데이터 없음, 결정성·스키마 기본값', () => {
    const recent = run({ seed: 7, soilingPctPerDay: 0.1, rainDays: [110] });
    expect(recent.status).toBe('insufficient');
    expect(pvSoilingRate.detect({ siteId: 2, assetId: null, gammaPerC: null, inverterDays: [], wxDays: [], cleaningTs: [], smpKrwPerKwh: null }, ctx()).status).toBe('insufficient');
    const input = { siteId: 2, assetId: 20, gammaPerC: null, cleaningTs: [], smpKrwPerKwh: 120, ...site({ seed: 8, soilingPctPerDay: 0.12, rainDays: [60] }) };
    expect(pvSoilingRate.detect(input, ctx())).toEqual(pvSoilingRate.detect(input, ctx()));
    expect(pvSoilingRate.paramSchema.parse({})).toEqual(PV_SOILING_DEFAULTS);
  });
});
