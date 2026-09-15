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

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const getScheme = () => (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light');
const getServerScheme = () => 'server';

/** app/globals.css의 디자인 토큰을 읽는다. 다크 모드로 바뀌면 다시 읽는다. 서버 렌더에서는 null */
export function useChartTheme(): ChartTheme | null {
  const scheme = useSyncExternalStore(subscribe, getScheme, getServerScheme);
  return useMemo(() => {
    if (scheme === 'server') return null;
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
        // 다크 모드의 ink-2는 앰버와 너무 가까워(검증 스크립트 ΔE < 15) muted를 쓴다
        neutral: [token(scheme === 'dark' ? 'muted' : 'ink-2'), token('rule-strong')],
      },
      warn: token('warn'),
      crit: token('crit'),
      accent: token('accent'),
      series: [1, 2, 3, 4, 5, 6].map((i) => token(`chart-series-${i}`)),
    };
  }, [scheme]);
}
