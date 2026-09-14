// 조치 효과 검증 bin 키 → 표시 이름, 전후 bin 표 행 맞추기 (순수). 키 형식은 lib/analytics/verification/before-after.ts의 bin 함수를 따른다.
import { DEFAULT_STACK_EXTRACTOR_PARAMS } from '@/lib/analytics/episodes/stack-episodes';
import { capacityBinLabel } from '@/lib/desk/conditions';

/** before-after.ts ess.capacity_ah bin 폭 (C-rate 0.05 · 셀온도 5 °C) */
const CAPACITY_WIDTHS = { cRate: 0.05, tempC: 5 };

export function verificationBinLabel(metric: string, key: string): string {
  if (metric === 'ess.capacity_ah') return capacityBinLabel(key, CAPACITY_WIDTHS);
  if (key === 'all') return '전체';
  const [j = 'na', t = 'na'] = key.split('|');
  const num = (text: string) => (text !== 'na' && text !== 'null' && Number.isFinite(Number(text)) ? Number(text) : null);
  if (metric === 'el.v_cell_v') {
    const jv = num(j);
    const tv = num(t);
    const jText = jv === null ? '전류밀도 없음' : `${jv.toFixed(1)}~${(jv + DEFAULT_STACK_EXTRACTOR_PARAMS.jBinWidth).toFixed(1)} A/cm²`;
    const tText = tv === null ? '온도 없음' : `${tv.toFixed(0)}~${(tv + DEFAULT_STACK_EXTRACTOR_PARAMS.tempBinWidthC).toFixed(0)}°C`;
    return `${jText} · ${tText}`;
  }
  if (metric === 'fc.v_cell_v') {
    const tv = num(j);
    return tv === null ? '온도 없음' : `${tv.toFixed(0)}~${(tv + DEFAULT_STACK_EXTRACTOR_PARAMS.tempBinWidthC).toFixed(0)}°C`;
  }
  return key;
}

/** 'a|b' 키를 조각별 수치 오름차순으로 (0.1 < 0.15, 값 없는 조각은 뒤로) */
function byBinKey(a: string, b: string): number {
  const pa = a.split('|');
  const pb = b.split('|');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const [x, y] = [Number(pa[i]), Number(pb[i])];
    const diff = Number.isFinite(x) && Number.isFinite(y) ? x - y : Number.isFinite(x) ? -1 : Number.isFinite(y) ? 1 : (pa[i] ?? '').localeCompare(pb[i] ?? '');
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface BinPair {
  readonly key: string;
  readonly label: string;
  readonly beforeN: number;
  readonly beforeMedian: number | null;
  readonly afterN: number;
  readonly afterMedian: number | null;
}

/** 전·후 bin을 키로 맞춘 행 (한쪽에만 있는 bin도 0건으로 보여 준다) */
export function pairBins(metric: string, before: readonly { key: string; n: number; median: number | null }[], after: readonly { key: string; n: number; median: number | null }[]): BinPair[] {
  const keys = [...new Set([...before.map((b) => b.key), ...after.map((b) => b.key)])].sort(byBinKey);
  return keys.map((key) => {
    const b = before.find((x) => x.key === key);
    const a = after.find((x) => x.key === key);
    return { key, label: verificationBinLabel(metric, key), beforeN: b?.n ?? 0, beforeMedian: b?.median ?? null, afterN: a?.n ?? 0, afterMedian: a?.median ?? null };
  });
}
