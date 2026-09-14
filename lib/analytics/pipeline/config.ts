// om.detector_config 활성 행 병합: default < class:<종류> < asset:<id> 순으로 좁은 범위가 이긴다.
// params는 외부 입력이므로 탐지기 기본값에 있는 키이고 타입이 같은 값만 받는다 (모르는 키·틀린 타입은 버린다).
import type { TimeWindow } from '../types';
import type { DetectorConfigRow } from './types';

export interface ConfigTarget {
  /** null = 설비 하나가 아닌 동종 그룹 실행 (asset 범위 설정은 적용하지 않음) */
  readonly id: number | null;
  readonly classKey: string;
}

export interface ResolvedConfig<P> {
  readonly params: Partial<P>;
  readonly referenceWindow: TimeWindow | undefined;
  /** 적용한 설정 'scope@version' (넓은 범위부터) */
  readonly versions: readonly string[];
  /** 버린 키 'scope.key' */
  readonly rejectedKeys: readonly string[];
}

function scopeRank(scope: string, target: ConfigTarget | null): number | null {
  if (scope === 'default') return 0;
  if (target && scope === `class:${target.classKey}`) return 1;
  if (target && target.id !== null && scope === `asset:${target.id}`) return 2;
  return null;
}

function acceptsValue(defaultValue: unknown, value: unknown): boolean {
  if (defaultValue === null) return value === null || (typeof value === 'number' && Number.isFinite(value));
  if (typeof defaultValue === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === typeof defaultValue;
}

/** 탐지기 하나·대상 하나에 적용할 설정. target null이면 default 범위만 (사이트 단위 실행) */
export function resolveDetectorConfig<P extends object>(configs: readonly DetectorConfigRow[], detectorId: string, target: ConfigTarget | null, defaults: P): ResolvedConfig<P> {
  const applicable = configs
    .filter((c) => c.detectorId === detectorId)
    .flatMap((c) => {
      const rank = scopeRank(c.scope, target);
      return rank === null ? [] : [{ config: c, rank }];
    })
    .sort((a, b) => a.rank - b.rank);
  const defaultsRecord = defaults as Readonly<Record<string, unknown>>;
  const rejectedKeys: string[] = [];
  const params = applicable.reduce<Record<string, unknown>>((merged, { config }) => {
    const accepted = Object.entries(config.params).filter(([key, value]) => {
      const ok = Object.hasOwn(defaultsRecord, key) && acceptsValue(defaultsRecord[key], value);
      if (!ok) rejectedKeys.push(`${config.scope}.${key}`);
      return ok;
    });
    return { ...merged, ...Object.fromEntries(accepted) };
  }, {});
  const referenceWindow = applicable.map(({ config }) => config.referenceWindow).filter((w): w is TimeWindow => w !== null).at(-1);
  return {
    params: params as Partial<P>,
    referenceWindow,
    versions: applicable.map(({ config }) => `${config.scope}@${config.version}`),
    rejectedKeys,
  };
}
