// 설비 템플릿을 AssetDef로 만드는 도우미. 순수 데이터 모듈 ('server-only' 금지).
// 원본 태그 source_key는 `${설비 코드}/${태그}` 형식이다 (예: ESS1/RACK03/I_DC).
import { ASSET_CLASS_BY_KEY, METRIC_DEF_BY_KEY } from './catalog';
import type { AssetDef, Nameplate, PointDef } from './types';

/** ESS 랙 I/V/SOC·셀 통계, 전해조·연료전지 스택 V/I, 태양광 인버터 AC/DC 전력 */
export const FAST_PERIOD_S = 60;
/** 나머지 전부 */
export const SLOW_PERIOD_S = 300;

export interface PointOptions {
  readonly fast?: boolean;
  readonly qualifier?: string;
  readonly sourceUnit?: string; // 생략하면 메트릭의 정규 단위
  readonly scale?: number;
  readonly valueOffset?: number;
}

export type PointSpec = readonly [metricKey: string, tag: string, options?: PointOptions];

export interface AssetSpec {
  readonly code: string;
  readonly classKey: string;
  readonly name: string;
  readonly nameplate: Nameplate;
  readonly criticality: AssetDef['criticality'];
  readonly peer?: boolean; // 사이트 안 같은 종류끼리 비교하는 동종 그룹
  readonly points?: readonly PointSpec[];
}

export interface SiteContext {
  readonly siteCode: string;
  readonly commissionedAt: string; // YYYY-MM-DD
}

export const FAST: PointOptions = { fast: true };
/** 원본 단위 변환 예시: 게이트웨이가 정규 단위와 다른 단위로 보내는 태그 */
export const MILLIVOLT: PointOptions = { sourceUnit: 'mV', scale: 0.001 };
export const MEGAOHM: PointOptions = { sourceUnit: 'MΩ', scale: 1000 };
export const MEGAPASCAL: PointOptions = { sourceUnit: 'MPa', scale: 10 };
export const KELVIN: PointOptions = { sourceUnit: 'K', valueOffset: -273.15 };

export const pad2 = (n: number): string => String(n).padStart(2, '0');
export const sequence = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

function buildPoint(assetCode: string, [metricKey, tag, options = {}]: PointSpec): PointDef {
  const metric = METRIC_DEF_BY_KEY.get(metricKey);
  if (!metric) throw new Error(`카탈로그에 없는 메트릭: ${metricKey} (${assetCode}/${tag})`);
  return {
    metricKey,
    qualifier: options.qualifier ?? '',
    sourceKey: `${assetCode}/${tag}`,
    sourceUnit: options.sourceUnit ?? metric.unit,
    scale: options.scale ?? 1,
    valueOffset: options.valueOffset ?? 0,
    periodS: options.fast ? FAST_PERIOD_S : SLOW_PERIOD_S,
  };
}

/** 부모가 자식보다 먼저 오도록 템플릿 순서를 유지한다. */
export function buildAssets(ctx: SiteContext, specs: readonly AssetSpec[]): readonly AssetDef[] {
  return specs.map((spec) => {
    const assetClass = ASSET_CLASS_BY_KEY.get(spec.classKey);
    if (!assetClass) throw new Error(`카탈로그에 없는 설비 종류: ${spec.classKey} (${spec.code})`);
    return {
      code: spec.code,
      classKey: spec.classKey,
      level: assetClass.level,
      name: spec.name,
      nameplate: spec.nameplate,
      peerGroup: spec.peer ? `${ctx.siteCode}/${spec.classKey}` : null,
      criticality: spec.criticality,
      commissionedAt: ctx.commissionedAt,
      points: (spec.points ?? []).map((point) => buildPoint(spec.code, point)),
    };
  });
}
