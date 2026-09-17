'use client';

import { useMemo, useSyncExternalStore } from 'react';
import type { ChartTone } from '@/lib/data/domains';

export interface ChartTheme {
  readonly ink: string;
  readonly ink2: string;
  readonly muted: string;
  readonly rule: string;
  readonly surface: string;
  readonly sunken: string;
  readonly tones: Readonly<Record<ChartTone, readonly [main: string, edge: string]>>;
  readonly warn: string;
  readonly crit: string;
  readonly accent: string;
  /** 범주형 계열 6색 (고정 순서, app/globals.css --chart-series-1..6). 인접 쌍 색각 이상 분리를 검증한 순서라 바꾸지 않는다 */
  readonly series: readonly string[];
}

// 콘솔은 어두운 단일 테마다(app/globals.css). 서버 렌더에서는 토큰을 읽을 수 없어 null을 돌려주고,
// 마운트 뒤 한 번 다시 읽는다.
const noop = () => () => {};
const isMounted = () => true;
const isServer = () => false;

/** app/globals.css의 디자인 토큰을 읽는다. 서버 렌더에서는 null */
export function useChartTheme(): ChartTheme | null {
  const mounted = useSyncExternalStore(noop, isMounted, isServer);
  return useMemo(() => {
    if (!mounted) return null;
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
    return {
      ink: token('ink'),
      ink2: token('ink-2'),
      muted: token('muted'),
      rule: token('rule'),
      surface: token('surface'),
      sunken: token('sunken'),
      tones: {
        solar: [token('solar'), token('solar-edge')],
        hydrogen: [token('hydrogen'), token('hydrogen-edge')],
        // 어두운 배경에서 ink-2보다 muted가 청록(--hydrogen)과 더 멀다 (ΔE 20.5 대 16.2)
        neutral: [token('muted'), token('rule-strong')],
      },
      warn: token('warn'),
      crit: token('crit'),
      accent: token('accent'),
      series: [1, 2, 3, 4, 5, 6].map((i) => token(`chart-series-${i}`)),
    };
  }, [mounted]);
}
