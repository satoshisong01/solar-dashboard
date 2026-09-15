// inv.thermal_derating 버킷 판정·일 집계·외기 bin 비교·판별 체크·근거 (순수).
import type { InverterThermalSample } from '../episodes/inverter-thermal';
import { binFloor, downsample } from '../episodes/series';
import { median } from '../stats/robust';
import { kstDateString, kstDayStart, MS_PER_HOUR, type JsonObject } from '../types';
import { levelCheck, makeCheck, medianShift } from './check-helpers';
import { r } from './common';
import type { InvThermalDeratingInput, InvThermalDeratingParams, ThermalInverter } from './inv-thermal-derating';
import type { CheckStatus, DiagnosticCheck } from './types';

/** 동종 비교가 가능한 시각의 인버터 한 대 버킷 */
export interface DerateSample {
  readonly ts: number;
  readonly assetId: number;
  readonly kwp: number;
  readonly own: number;
  readonly peerMedian: number;
  readonly heatsinkC: number | null;
  readonly ambientC: number | null;
  readonly limitKnown: boolean;
  readonly limited: boolean;
  readonly hot: boolean;
  readonly derate: boolean;
  /** 같은 시각 다른 인버터 중 고온 비율·출력제한 비율 */
  readonly peersHotShare: number;
  readonly peersLimitedShare: number;
  readonly bucketHours: number;
}

const LIMIT_ACTIVE_PCT = 99.5;

function bucketHoursOf(samples: readonly InverterThermalSample[]): number {
  const times = [...new Set(samples.map((s) => s.ts))].sort((a, b) => a - b);
  const gaps = times.slice(1).map((ts, i) => ts - (times[i] as number)).filter((g) => g > 0);
  return (gaps.length === 0 ? 300_000 : median(gaps)) / MS_PER_HOUR;
}

/** 버킷 표본 → 동종 비교 판정. 출력제한이 아닌 인버터가 minPeers 미만이거나 동종 중앙값이 낮은 시각은 뺀다 */
export function derateSamples(samples: readonly InverterThermalSample[], inverters: readonly ThermalInverter[], p: InvThermalDeratingParams): DerateSample[] {
  const byId = new Map(inverters.filter((inv) => inv.dcKwp > 0).map((inv) => [inv.assetId, inv]));
  const bucketHours = bucketHoursOf(samples);
  const byTs = new Map<number, InverterThermalSample[]>();
  for (const s of samples) {
    if (!byId.has(s.assetId)) continue;
    const list = byTs.get(s.ts);
    if (list) list.push(s); // 이 함수 안에서 만든 배열만 채운다
    else byTs.set(s.ts, [s]);
  }
  const isLimited = (s: InverterThermalSample) => s.limitPct !== null && s.limitPct < LIMIT_ACTIVE_PCT;
  const isHot = (s: InverterThermalSample) => s.heatsinkC !== null && s.heatsinkC >= (byId.get(s.assetId)?.derateStartC ?? p.defaultDerateStartC) - p.marginC;
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).flatMap(([ts, group]) => {
    const eligible = group.filter((s) => !isLimited(s));
    if (eligible.length < p.minPeers) return [];
    const peerMedian = median(eligible.map((s) => s.kwPerKwp));
    if (peerMedian < p.minPeerKwPerKwp) return [];
    return group.map((s) => {
      const others = group.filter((o) => o.assetId !== s.assetId);
      const limited = isLimited(s);
      const hot = isHot(s);
      return {
        ts,
        assetId: s.assetId,
        kwp: byId.get(s.assetId)?.dcKwp ?? 0,
        own: s.kwPerKwp,
        peerMedian,
        heatsinkC: s.heatsinkC,
        ambientC: s.ambientC,
        limitKnown: s.limitPct !== null,
        limited,
        hot,
        derate: !limited && hot && (peerMedian - s.kwPerKwp) / peerMedian >= p.derateGapPct / 100,
        peersHotShare: others.length === 0 ? 0 : others.filter(isHot).length / others.length,
        peersLimitedShare: others.length === 0 ? 0 : others.filter(isLimited).length / others.length,
        bucketHours,
      };
    });
  });
}

export interface DayRow {
  readonly day: number;
  readonly derateHours: number;
  readonly lossKwh: number;
  readonly energyKwh: number;
  readonly ambientMaxC: number | null;
  readonly heatsinkMaxC: number | null;
  /** 방열판 온도가 있는 버킷 비율 */
  readonly coverage: number;
}

/** 인버터 한 대의 버킷 → KST 일 집계 (출력제한 버킷은 발전량에서도 뺀다) */
export function dayRowsOf(samples: readonly DerateSample[]): DayRow[] {
  const byDay = new Map<number, DerateSample[]>();
  for (const s of samples) {
    const key = kstDayStart(s.ts);
    const list = byDay.get(key);
    if (list) list.push(s); // 이 함수 안에서 만든 배열만 채운다
    else byDay.set(key, [s]);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, list]) => {
    const used = list.filter((s) => !s.limited);
    const derate = used.filter((s) => s.derate);
    const ambient = list.flatMap((s) => s.ambientC ?? []);
    const heatsink = list.flatMap((s) => s.heatsinkC ?? []);
    return {
      day,
      derateHours: derate.reduce((sum, s) => sum + s.bucketHours, 0),
      lossKwh: derate.reduce((sum, s) => sum + (s.peerMedian - s.own) * s.kwp * s.bucketHours, 0),
      energyKwh: used.reduce((sum, s) => sum + s.own * s.kwp * s.bucketHours, 0),
      ambientMaxC: ambient.length === 0 ? null : ambient.reduce((max, v) => Math.max(max, v), -Infinity),
      heatsinkMaxC: heatsink.length === 0 ? null : heatsink.reduce((max, v) => Math.max(max, v), -Infinity),
      coverage: list.length === 0 ? 0 : heatsink.length / list.length,
    };
  });
}

export interface BinShift {
  readonly ref: number;
  readonly cur: number;
  readonly bins: readonly JsonObject[];
}

/** 일 최고 외기 온도 bin마다 기준(최근 이전 가장 이른 referencePerBin일)·최근 일 저감 시간 평균을 최근 일수로 가중 평균 */
function ambientBinShift(reference: readonly DayRow[], recent: readonly DayRow[], p: InvThermalDeratingParams): BinShift | null {
  const keyOf = (row: DayRow) => (row.ambientMaxC === null ? null : binFloor(row.ambientMaxC, p.ambientBinWidthC));
  const keys = [...new Set(recent.flatMap((row) => keyOf(row) ?? []))].sort((a, b) => a - b);
  const mean = (rows: readonly DayRow[]) => rows.reduce((sum, row) => sum + row.derateHours, 0) / rows.length;
  const bins = keys.flatMap((key) => {
    const ref = reference.filter((row) => keyOf(row) === key).slice(0, p.referencePerBin);
    const cur = recent.filter((row) => keyOf(row) === key);
    return ref.length === 0 ? [] : [{ key, ref, cur }];
  });
  const total = bins.reduce((sum, b) => sum + b.cur.length, 0);
  if (bins.length === 0 || total === 0) return null;
  return {
    ref: bins.reduce((sum, b) => sum + b.cur.length * mean(b.ref), 0) / total,
    cur: bins.reduce((sum, b) => sum + b.cur.length * mean(b.cur), 0) / total,
    bins: bins.map((b) => ({ ambient_bin_c: b.key, n_ref: b.ref.length, n_cur: b.cur.length, ref_derate_h: r(mean(b.ref), 3), cur_derate_h: r(mean(b.cur), 3) })),
  };
}

export interface DerateEvidenceInput {
  readonly inverter: ThermalInverter;
  readonly recent: readonly DayRow[];
  readonly reference: readonly DayRow[];
  readonly samples: readonly DerateSample[];
  readonly p: InvThermalDeratingParams;
}

export function derateEvidence(e: DerateEvidenceInput): { json: JsonObject; binShift: BinShift | null } {
  const binShift = ambientBinShift(e.reference, e.recent, e.p);
  const worst = [...e.recent].sort((a, b) => b.derateHours - a.derateHours)[0];
  const worstSamples = worst ? e.samples.filter((s) => s.assetId === e.inverter.assetId && kstDayStart(s.ts) === worst.day) : [];
  return {
    binShift,
    json: {
      method: 'peer_gap_heatsink_threshold',
      derate_start_c: e.inverter.derateStartC ?? e.p.defaultDerateStartC,
      margin_c: e.p.marginC,
      gap_pct: e.p.derateGapPct,
      days: e.recent.slice(-31).map((row) => ({ date: kstDateString(row.day), derate_h: r(row.derateHours, 2), loss_kwh: r(row.lossKwh, 1), ambient_max_c: r(row.ambientMaxC, 1) })),
      ambient_bins: binShift === null ? [] : [...binShift.bins],
      ambient_bin_shift_h: binShift === null ? null : { ref: r(binShift.ref, 3), cur: r(binShift.cur, 3) },
      representative_day: worst ? { date: kstDateString(worst.day), unit: 'kW/kWp', points: downsample(worstSamples, 120).map((s) => ({ ts: s.ts, own: r(s.own, 3), peer: r(s.peerMedian, 3), heatsink_c: r(s.heatsinkC, 1) })) } : null,
    },
  };
}

export interface ThermalCheckInput {
  readonly inverter: ThermalInverter;
  readonly recent: readonly DayRow[];
  readonly reference: readonly DayRow[];
  /** 최근 기간 모든 인버터 버킷 */
  readonly samples: readonly DerateSample[];
  readonly input: InvThermalDeratingInput;
  readonly p: InvThermalDeratingParams;
}

function ambientCheck({ inverter, recent, reference, samples, p }: ThermalCheckInput): DiagnosticCheck {
  const derate = samples.filter((s) => s.assetId === inverter.assetId && s.derate && s.ambientC !== null);
  const coolShare = derate.length === 0 ? null : derate.filter((s) => (s.ambientC ?? 0) < p.hotAmbientC).length / derate.length;
  const shift = medianShift(reference.flatMap((row) => row.ambientMaxC ?? []), recent.flatMap((row) => row.ambientMaxC ?? []));
  const status: CheckStatus = coolShare === null && shift === null ? 'no_data' : coolShare !== null && coolShare >= 0.5 ? 'refutes' : shift !== null && shift.shift >= p.ambientShiftC ? 'supports' : 'unknown';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '최근 기간이 더 더웠습니다. 여름철 정상 저감이 섞였을 수 있으니 같은 외기 bin 저감 시간 비교를 함께 보세요.',
    refutes: `외기 ${p.hotAmbientC} °C 미만에서도 저감이 났습니다. 외기 탓보다 냉각팬·필터·방열판 오염을 의심하세요.`,
    unknown: '외기 온도 영향을 구분하기 어렵습니다.',
    no_data: '외기 온도 데이터가 없습니다.',
  };
  return makeCheck('ambient_hot', '외기 고온 편중', status, { derate_buckets_below_hot_ambient_share: r(coolShare, 3), ref_ambient_max_c: r(shift?.ref ?? null, 1), recent_ambient_max_c: r(shift?.cur ?? null, 1) }, notes[status]);
}

function fanCheck({ inverter, input, samples }: ThermalCheckInput): DiagnosticCheck {
  const from = samples.reduce((min, s) => Math.min(min, s.ts), Infinity);
  const events = input.faultEvents;
  const fan = (events ?? []).filter((e) => e.assetId === inverter.assetId && e.ts >= from && /FAN|팬/i.test(e.code));
  const status: CheckStatus = events === undefined ? 'no_data' : fan.length > 0 ? 'supports' : 'refutes';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '냉각팬 고장·경보 코드가 기록됐습니다. 팬 동작과 교체를 점검하세요.',
    refutes: '최근 기간 냉각팬 고장 코드는 없습니다. 필터·방열판 오염이나 설치 환경을 확인하세요.',
    unknown: '냉각팬 고장 여부를 판단하기 어렵습니다.',
    no_data: '인버터 고장 코드(event_log) 입력이 없습니다.',
  };
  return makeCheck('fan_fault', '냉각팬 고장 코드', status, { fan_fault_events: fan.length }, notes[status]);
}

function installationCheck({ inverter, samples, p }: ThermalCheckInput): DiagnosticCheck {
  const hot = samples.filter((s) => s.assetId === inverter.assetId && s.hot);
  const together = hot.length === 0 ? null : hot.filter((s) => s.peersHotShare >= p.allPeersHotShare).length / hot.length;
  return levelCheck('installation_environment', '설치 환경 (동종 전체 고온 → 설치실 환기)', together, [0.75, 0.25], { hot_buckets: hot.length, peers_hot_together_share: r(together, 3) }, {
    supports: '고온 시각에 동종 인버터도 대부분 함께 뜨거웠습니다. 설치실 환기·차양 등 설치 환경을 점검하세요.',
    refutes: '이 인버터만 뜨거웠습니다. 설치 환경보다 이 인버터의 냉각 계통을 의심하세요.',
    unknown: '고온 시각에 일부 동종만 함께 뜨거웠습니다.',
    no_data: '방열판 고온 구간이 없습니다.',
  });
}

function curtailmentCheck({ inverter, samples }: ThermalCheckInput): DiagnosticCheck {
  const own = samples.filter((s) => s.assetId === inverter.assetId);
  const derate = own.filter((s) => s.derate);
  const excluded = own.filter((s) => s.limited).length;
  const peerLimited = derate.length === 0 ? 0 : derate.filter((s) => s.peersLimitedShare > 0).length / derate.length;
  const status: CheckStatus = !own.some((s) => s.limitKnown) ? 'no_data' : peerLimited >= 0.2 ? 'unknown' : 'refutes';
  const notes: Readonly<Record<CheckStatus, string>> = {
    supports: '출력제한과 겹칩니다.',
    refutes: `출력제한 설정이 걸린 버킷 ${excluded}개는 뺐고, 저감 시각에 다른 인버터도 제한이 없었습니다. 출력제한 혼동은 아닙니다.`,
    unknown: '저감 시각에 다른 인버터 일부가 출력제한 중이었습니다. 동종 중앙값에 영향이 있었을 수 있습니다.',
    no_data: '출력제한 설정값(ac.power.limit) 데이터가 없어 제한 구간을 가려낼 수 없습니다.',
  };
  return makeCheck('curtailment_confusion', '출력제한 혼동 배제', status, { excluded_limited_buckets: excluded, derate_buckets_with_peer_limit_share: r(peerLimited, 3) }, notes[status]);
}

export function thermalChecks(input: ThermalCheckInput): DiagnosticCheck[] {
  return [ambientCheck(input), fanCheck(input), installationCheck(input), curtailmentCheck(input)];
}
