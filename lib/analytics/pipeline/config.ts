// om.detector_config 활성 행 병합과 검증: default < class:<종류> < asset:<id> 순으로 좁은 범위가 이기고, 코드 기본값 위에 얹어 paramSchema로 검증한다.
//   - 기본값에 없는 키는 버리고 ignoredKeys에 남긴다 (삭제된 파라미터가 남은 설정 행과의 호환)
//   - 기본값에 있는 키의 타입·범위가 스키마에 맞지 않으면 ok false (탐지기는 insufficient 'invalid_config'로 끝난다)
//   - 근거 스냅샷에 남길 설정 참조: 가장 좁은 적용 범위·버전(없으면 code_default)과 적용 파라미터 해시
import { hashInput } from '../hash';
import type { ParamSchema } from '../detectors/types';
import type { TimeWindow } from '../types';
import type { ConfigRef, DetectorConfigRow } from './types';

export interface ConfigTarget {
  /** null = 설비 하나가 아닌 동종 그룹·사이트 실행 (asset 범위 설정은 적용하지 않음) */
  readonly id: number | null;
  readonly classKey: string;
}

export const INVALID_CONFIG = 'invalid_config';
export const CODE_DEFAULT_SCOPE = 'code_default';

interface ConfigurableDetector<P> {
  readonly defaultParams: P;
  readonly paramSchema: ParamSchema<P>;
}

interface ResolvedBase {
  readonly referenceWindow: TimeWindow | undefined;
  /** 적용한 설정 'scope@version' (넓은 범위부터) */
  readonly versions: readonly string[];
  /** 기본값에 없어 버린 키 'scope.key' */
  readonly ignoredKeys: readonly string[];
  readonly ref: ConfigRef;
}

export type ResolvedConfig<P> = (ResolvedBase & { readonly ok: true; readonly params: P }) | (ResolvedBase & { readonly ok: false; readonly reason: string });

function scopeRank(scope: string, target: ConfigTarget | null): number | null {
  if (scope === 'default') return 0;
  if (target && scope === `class:${target.classKey}`) return 1;
  if (target && target.id !== null && scope === `asset:${target.id}`) return 2;
  return null;
}

/** 설정 행 없이 코드 기본값으로 실행한 결과의 설정 참조 */
export const codeDefaultConfigRef = (params: object): ConfigRef => ({ scope: CODE_DEFAULT_SCOPE, version: null, paramsHash: hashInput(params).slice(0, 16), applied: [] });

/** 탐지기 하나·대상 하나에 적용할 설정. target null이면 default 범위만 (사이트 단위 실행) */
export function resolveDetectorConfig<P extends object>(configs: readonly DetectorConfigRow[], detectorId: string, target: ConfigTarget | null, detector: ConfigurableDetector<P>): ResolvedConfig<P> {
  const applicable = configs
    .filter((c) => c.detectorId === detectorId)
    .flatMap((c) => {
      const rank = scopeRank(c.scope, target);
      return rank === null ? [] : [{ config: c, rank }];
    })
    .sort((a, b) => a.rank - b.rank);
  const known = detector.defaultParams as Readonly<Record<string, unknown>>;
  const ignoredKeys = applicable.flatMap(({ config }) => Object.keys(config.params).filter((key) => !Object.hasOwn(known, key)).map((key) => `${config.scope}.${key}`));
  const merged = applicable.reduce<Record<string, unknown>>((acc, { config }) => ({ ...acc, ...Object.fromEntries(Object.entries(config.params).filter(([key]) => Object.hasOwn(known, key))) }), {});
  const narrowest = applicable.at(-1)?.config;
  const base = {
    referenceWindow: applicable.map(({ config }) => config.referenceWindow).filter((w): w is TimeWindow => w !== null).at(-1),
    versions: applicable.map(({ config }) => `${config.scope}@${config.version}`),
    ignoredKeys,
  };
  const parsed = detector.paramSchema.safeParse({ ...known, ...merged });
  const ref = (params: unknown): ConfigRef => ({ scope: narrowest?.scope ?? CODE_DEFAULT_SCOPE, version: narrowest?.version ?? null, paramsHash: hashInput(params).slice(0, 16), applied: base.versions });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ...base, ok: false, reason: `${INVALID_CONFIG}: ${issues} (${base.versions.join(', ')})`, ref: ref(merged) };
  }
  return { ...base, ok: true, params: parsed.data, ref: ref(parsed.data) };
}
