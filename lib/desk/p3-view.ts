// P3 근거 화면 계산 (순수, 서버·클라이언트 공용): 날짜 축 좌표, 외기 bin 배정, 사이트 체인 원장 링크, 세척 경제성, 조건 문장.
import { INV_THERMAL_DERATING_DEFAULTS } from '@/lib/analytics/detectors/inv-thermal-derating';
import { formatNumber } from '@/lib/format';
import { formatSigned } from './effect';
import type { MassBalanceEvidence, P3EvidenceView, SoilingEvidence, ThermalEvidence } from './p3-evidence-types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** KST 'YYYY-MM-DD' → 그날 정오(KST) epoch ms (시간 축 막대·점이 날짜 칸 가운데 오게). 형식이 틀리면 null */
export function kstNoonMs(date: string): number | null {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T12:00:00+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

/** 외기 bin 폭: 근거 bin 키 간격의 최솟값, 알 수 없으면 탐지기 기본값 */
export function ambientBinWidth(bins: ThermalEvidence['ambientBins']): number {
  const keys = [...new Set(bins.map((b) => b.binC))].sort((a, b) => a - b);
  const gaps = keys.slice(1).map((key, i) => key - (keys[i] as number)).filter((gap) => gap > 0);
  return gaps.length === 0 ? INV_THERMAL_DERATING_DEFAULTS.ambientBinWidthC : Math.min(...gaps);
}

/** 일 최고 외기 → bin 하한 (탐지기 binFloor와 같은 내림) */
export const ambientBinOf = (ambientMaxC: number | null, width: number): number | null => (ambientMaxC === null || !(width > 0) ? null : Math.round(Math.floor(ambientMaxC / width + 1e-9) * width * 1e6) / 1e6);

export interface ThermalBinSeries {
  /** bin 하한 [°C] (외기 없음은 null) */
  readonly binC: number | null;
  readonly label: string;
  /** [정오 ms, 저감 시간 h] */
  readonly points: readonly (readonly [number, number])[];
}

/** 일별 저감 시간을 일 최고 외기 bin으로 나눈 계열 (bin 하한 오름차순, 외기 없음은 끝) */
export function thermalBinSeries(evidence: Pick<ThermalEvidence, 'days' | 'ambientBins'>): ThermalBinSeries[] {
  const width = ambientBinWidth(evidence.ambientBins);
  const groups = new Map<number | null, [number, number][]>();
  for (const day of evidence.days) {
    const x = kstNoonMs(day.date);
    if (x === null || day.derateH === null) continue;
    const key = ambientBinOf(day.ambientMaxC, width);
    groups.set(key, [...(groups.get(key) ?? []), [x, day.derateH]]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([binC, points]) => ({ binC, label: binC === null ? '외기 없음' : `외기 ${formatNumber(binC, 1)}~${formatNumber(binC + width, 1)} °C`, points }));
}

/** 사이트 상세 체인 원장 섹션 링크: 근거 일 행 첫날~마지막 날 (사용자 지정 기간) */
export function chainSectionHref(siteCode: string, days: readonly { readonly date: string }[]): string {
  const dates = days.map((d) => d.date).filter((date) => DATE.test(date)).sort();
  const base = `/sites/${encodeURIComponent(siteCode)}`;
  const [from, to] = [dates[0], dates.at(-1)];
  return from === undefined || to === undefined ? `${base}#chain` : `${base}?${new URLSearchParams({ chain: 'custom', from, to }).toString()}#chain`;
}

export interface CleaningEconomics {
  readonly lossValueKrw: number | null;
  /** 누적 손실액 ÷ 세척비 [%] (가격·세척비가 없으면 null) */
  readonly shareOfCleaningPct: number | null;
  readonly verdict: 'clean' | 'wait' | 'no_price';
}

/** 세척 경제성: 누적 손실액이 세척비를 넘으면 세척 검토 */
export function cleaningEconomics(evidence: Pick<SoilingEvidence, 'economics' | 'smpKrwPerKwh' | 'cleaningCostKrw'>): CleaningEconomics {
  const { cumulativeLossKwh } = evidence.economics;
  const value = evidence.economics.lossValueKrw ?? (cumulativeLossKwh !== null && evidence.smpKrwPerKwh !== null ? cumulativeLossKwh * evidence.smpKrwPerKwh : null);
  if (value === null) return { lossValueKrw: null, shareOfCleaningPct: null, verdict: 'no_price' };
  const share = evidence.cleaningCostKrw !== null && evidence.cleaningCostKrw > 0 ? (value / evidence.cleaningCostKrw) * 100 : null;
  return { lossValueKrw: value, shareOfCleaningPct: share, verdict: share !== null && share >= 100 ? 'clean' : 'wait' };
}

/** 세척·복원 이벤트 종류 → 문구 */
export const resetKindLabel = (kind: string): string => (kind === 'cleaning' ? '세척' : kind === 'pi_step' ? '강우·복원(성능지수 급상승)' : kind);

const SOILING_EXCLUSION_LABELS: Readonly<Record<string, string>> = {
  cloudy_days: '맑지 않은 날',
  peer_outlier: '동종 이상 인버터',
  stopped: '정지',
  curtailed: '출력제한',
  clipping: '클리핑',
  low_completeness: '완결성 미달',
};

export const soilingExclusionLabel = (code: string): string => SOILING_EXCLUSION_LABELS[code] ?? code;

const massBalanceCondition = (e: MassBalanceEvidence): string =>
  [
    `최근 유효 ${e.recent.days}일 잔차율 중앙값 ${formatSigned(e.recent.medianPct, 2)}%`,
    `기준 ${e.reference.days}일 중앙값 ${formatSigned(e.reference.medianPct, 2)}%${e.reference.sigmaPct === null ? '' : `·σ ${formatNumber(e.reference.sigmaPct, 2)}%p`}`,
    e.cusum.alarmDay === null ? null : `CUSUM(k ${formatNumber(e.cusum.k, 1)}·h ${formatNumber(e.cusum.h, 1)}) 경보 ${e.cusum.alarmDay}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

/** 효과 카드 '같은 조건' 문장 (P3 근거) */
export function p3ConditionText(evidence: P3EvidenceView): string | null {
  switch (evidence.kind) {
    case 'rise': {
      const used = evidence.bins.filter((b) => b.used);
      if (used.length === 0) return null;
      const nRef = used.reduce((sum, b) => sum + b.nRef, 0);
      const nCur = used.reduce((sum, b) => sum + b.nCur, 0);
      return `같은 조건 bin ${used.length}개(${used.map((b) => b.label).slice(0, 3).join(' / ')}${used.length > 3 ? ' …' : ''}), 기준 ${nRef}${evidence.countWord}·최근 ${nCur}${evidence.countWord}${evidence.notes.length > 0 ? `, ${evidence.notes[0]}` : ''}`;
    }
    case 'tank_leak': {
      const recent = evidence.holds.filter((h) => h.role === 'recent').length;
      const reference = evidence.holds.length - recent;
      const eos = evidence.eosModel === 'lemmon2008' ? 'NIST 상태식' : evidence.eosModel === 'abel_noble' ? 'Abel–Noble' : '상태식';
      return `유입·유출 없는 정지 보유 구간 최근 ${recent}개·기준 ${reference}개의 온도 보정 질량(${eos}${evidence.volumeM3 === null ? '' : `, 내용적 ${formatNumber(evidence.volumeM3, 2)} m³`}) 기울기, 센서 잡음 σ ${formatNumber(evidence.noiseSigma, 3)} kg/일·유의 기준 ${formatNumber(evidence.thresholdKgPerDay, 3)} kg/일`;
    }
    case 'mass_balance':
      return massBalanceCondition(evidence);
    case 'soiling': {
      const current = evidence.segments.at(-1);
      const last = evidence.resets.at(-1);
      return `맑은 날 온도 보정 성능지수${current ? ` ${current.clearDays}일(${current.from} ~ ${current.to})` : ''}, ${last ? `마지막 복원 ${last.date} ${resetKindLabel(last.kind)} 이후` : '데이터 시작 이후'} 구간 Theil–Sen 기울기`;
    }
    case 'thermal':
      return `최근 ${evidence.days.length}일, 방열판 ${formatNumber(evidence.derateStartC === null || evidence.marginC === null ? null : evidence.derateStartC - evidence.marginC, 0)} °C 이상에서 동종 중앙값보다 ${formatNumber(evidence.gapPct, 0)}% 이상 낮은 시간(출력제한 제외)${evidence.binShift === null ? '' : `, 같은 외기 bin 일 저감 ${formatNumber(evidence.binShift.ref, 2)} h → ${formatNumber(evidence.binShift.cur, 2)} h`}`;
  }
}
