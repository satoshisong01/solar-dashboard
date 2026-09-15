// pv.soiling_rate 판별 체크 4종 (순수).
import { median } from '../stats/robust';
import { theilSen } from '../stats/trend';
import { MS_PER_DAY } from '../types';
import { levelCheck, makeCheck } from './check-helpers';
import { r } from './common';
import type { PiDay, Reset, Segment } from './pv-soiling-days';
import type { PvSoilingParams } from './pv-soiling-rate';
import type { CheckStatus, DiagnosticCheck } from './types';

export interface SoilingCheckInput {
  readonly days: readonly PiDay[];
  readonly current: Segment;
  readonly lossPct: number;
  readonly ratePctPerDay: number;
  readonly lastReset: Reset | null;
  readonly p: PvSoilingParams;
}

/** 점들의 오염 속도 [%/일] (x = 기준일 이후 일수). 점이 모자라면 null */
function rateOf(points: readonly { readonly x: number; readonly pi: number }[], minPoints: number): number | null {
  if (points.length < minPoints || new Set(points.map((pt) => pt.x)).size < 3) return null;
  const fit = theilSen(points.map((pt) => pt.x), points.map((pt) => pt.pi));
  return fit.intercept > 0 ? (-fit.slope / fit.intercept) * 100 : null;
}

function siteWideCheck({ current, ratePctPerDay, p }: SoilingCheckInput): DiagnosticCheck {
  const byAsset = new Map<number, { x: number; pi: number }[]>();
  for (const day of current.clearDays) {
    for (const inv of day.inverters) {
      const list = byAsset.get(inv.assetId);
      const point = { x: (day.day - current.from) / MS_PER_DAY, pi: inv.pi };
      if (list) list.push(point); // 이 함수 안에서 만든 배열만 채운다
      else byAsset.set(inv.assetId, [point]);
    }
  }
  const rates = [...byAsset.entries()].flatMap(([assetId, points]) => {
    const rate = rateOf(points, p.minClearDays);
    return rate === null ? [] : [{ assetId, rate }];
  });
  const declining = rates.filter((x) => x.rate >= 0.5 * ratePctPerDay).length;
  const share = rates.length < 2 ? null : declining / rates.length;
  const status: CheckStatus = share === null ? 'no_data' : share >= p.siteWideShare ? 'supports' : share <= 0.5 ? 'refutes' : 'unknown';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '사이트 인버터 대부분이 함께 떨어집니다. 모듈 오염(또는 일사계 오염)과 맞는 모습입니다.',
    refutes: '일부 인버터만 떨어집니다. 오염보다 인버터·스트링 문제일 수 있으니 pv.inverter_peer 결과를 먼저 보세요.',
    unknown: '떨어지는 인버터가 절반을 조금 넘습니다. 부분 음영·오염 편중을 확인하세요.',
    no_data: '인버터별 기울기를 계산할 데이터가 부족합니다.',
  };
  return makeCheck('site_wide', '사이트 전체 동시 저하 (오염 vs 일부 인버터)', status, { inverters: rates.length, declining, rates_pct_per_day: rates.map((x) => ({ asset_id: x.assetId, rate: r(x.rate, 4) })) }, notes[status]);
}

function sensorCheck({ current, p }: SoilingCheckInput): DiagnosticCheck {
  const ratios = current.clearDays.flatMap((d) => (d.ghiKwhM2 !== null && d.poaKwhM2 > 0 ? [d.ghiKwhM2 / d.poaKwhM2] : []));
  const third = Math.floor(ratios.length / 3);
  const shift = ratios.length < 6 || third === 0 ? null : Math.abs(median(ratios.slice(-third)) / median(ratios.slice(0, third)) - 1) * 100;
  return levelCheck('irradiance_sensor', '일사계 자체 오염·드리프트 (GHI/POA 비율 변화)', shift, [p.sensorRatioShiftPct, 1], { days: ratios.length, ratio_shift_pct: r(shift, 2) }, {
    supports: '같은 구간에서 GHI/POA 비율이 바뀌었습니다. 일사계 오염·기울어짐·드리프트로 PI가 흔들릴 수 있으니 일사계를 청소·점검하세요.',
    refutes: 'GHI/POA 비율은 그대로입니다. 일사계 문제로 설명하기 어렵습니다.',
    unknown: 'GHI/POA 비율이 조금 바뀌었습니다.',
    no_data: 'GHI 데이터가 없어 일사계를 교차 확인할 수 없습니다.',
  });
}

function seasonCheck({ days, current, ratePctPerDay, p }: SoilingCheckInput): DiagnosticCheck {
  const yearMs = 365 * MS_PER_DAY;
  const last = current.clearDays.at(-1)?.day ?? current.from;
  const previous = days.filter((d) => d.clear && d.day >= current.from - yearMs && d.day <= last - yearMs).map((d) => ({ x: (d.day - (current.from - yearMs)) / MS_PER_DAY, pi: d.pi }));
  const lastYear = rateOf(previous, p.minClearDays);
  const status: CheckStatus = lastYear === null ? 'unknown' : lastYear >= 0.5 * ratePctPerDay ? 'supports' : lastYear <= 0.2 * ratePctPerDay ? 'refutes' : 'unknown';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '전년 같은 기간에도 PI가 비슷하게 떨어졌습니다. 계절 입사각·스펙트럼 영향이 섞였을 수 있습니다.',
    refutes: '전년 같은 기간에는 PI가 떨어지지 않았습니다. 계절 영향으로 설명하기 어렵습니다.',
    unknown: lastYear === null ? '전년 같은 기간 데이터가 없어 계절 입사각 영향은 판단할 수 없습니다(불명).' : '전년 같은 기간 기울기와 비교해 판단하기 어렵습니다.',
    no_data: '전년 같은 기간 데이터가 없습니다.',
  };
  return makeCheck('seasonal_incidence', '계절 입사각 영향 (전년 같은 기간)', status, { last_year_rate_pct_per_day: r(lastYear, 4), last_year_clear_days: previous.length }, notes[status]);
}

function recoveryCheck({ lastReset, lossPct }: SoilingCheckInput): DiagnosticCheck {
  const label = '복원 이벤트 후 회복 폭';
  if (lastReset === null || lastReset.recoveryPct === null) return makeCheck('restoration_recovery', label, 'no_data', { reset_kind: lastReset?.kind ?? null }, '분석 기간에 세척·강우 복원 전후 데이터가 없습니다.');
  return levelCheck('restoration_recovery', label, lastReset.recoveryPct, [Math.max(0.5, 0.5 * lossPct), 0.3], { reset_kind: lastReset.kind, recovery_pct: r(lastReset.recoveryPct, 2) }, {
    supports: '직전 복원(세척·강우) 뒤 PI가 뚜렷하게 회복됐습니다. 오염 누적 가설과 맞습니다.',
    refutes: '직전 세척 뒤에도 PI가 회복되지 않았습니다. 오염이 아닌 원인(열화·음영·계측)을 확인하세요.',
    unknown: '직전 복원 뒤 회복 폭이 작습니다.',
    no_data: '복원 전후 데이터가 없습니다.',
  });
}

export function soilingChecks(input: SoilingCheckInput): DiagnosticCheck[] {
  return [siteWideCheck(input), sensorCheck(input), seasonCheck(input), recoveryCheck(input)];
}
