// 시드 데이터 정의 타입. DB 코드와 분리된 순수 모듈이다 (lib/sim 시뮬레이터도 import한다).

export type AssetLevel = 'system' | 'asset' | 'component';
export type ValueKind = 'gauge' | 'counter' | 'state' | 'bool';
export type RollupKind = 'avg' | 'sum' | 'last' | 'max' | 'min' | 'delta';

export interface NameplateField {
  readonly type: 'number' | 'integer' | 'string';
  readonly title: string;
}

/** om.asset_class.nameplate_schema에 저장하는 JSON Schema (object) */
export interface NameplateSchema {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, NameplateField>>;
}

export interface AssetClassDef {
  readonly key: string;
  readonly level: AssetLevel;
  readonly parentKey: string | null;
  readonly nameKo: string;
  readonly nameplateSchema: NameplateSchema;
  readonly safetyEventCodes: readonly string[];
}

export interface MetricDef {
  readonly key: string;
  readonly nameKo: string;
  readonly quantity: string;
  readonly unit: string; // 정규 단위
  readonly valueKind: ValueKind;
  readonly rollup: RollupKind;
  readonly hardMin: number | null;
  readonly hardMax: number | null;
  readonly expectedMin: number | null;
  readonly expectedMax: number | null;
  readonly flatlineMaxS: number | null;
  readonly aliases: readonly string[];
}

/** 원본 태그 → 정규값 변환: value = raw × scale + valueOffset */
export interface PointDef {
  readonly metricKey: string;
  readonly qualifier: string;
  readonly sourceKey: string;
  readonly sourceUnit: string;
  readonly scale: number;
  readonly valueOffset: number;
  readonly periodS: number;
}

export type Nameplate = Readonly<Record<string, number | string>>;

export interface AssetDef {
  readonly code: string; // 사이트 안 경로. 부모는 마지막 '/' 앞부분
  readonly classKey: string;
  readonly level: AssetLevel;
  readonly name: string;
  readonly nameplate: Nameplate;
  readonly peerGroup: string | null;
  readonly criticality: 1 | 2 | 3 | 4 | 5;
  readonly commissionedAt: string; // YYYY-MM-DD
  readonly points: readonly PointDef[];
}

export interface GatewayDef {
  readonly code: string;
  readonly keyId: string;
  /** 개발용 HMAC 비밀값을 담는 환경변수 (.env.development.local / .env.test.local) */
  readonly secretEnvVar: string;
}

/** 게이트웨이가 보내지만 일부러 매핑하지 않는 태그 (미매핑 인박스·재처리 시연용) */
export interface UnmappedTagDef {
  readonly sourceKey: string;
  readonly unit: string;
  readonly periodS: number;
  /** 나중에 매핑할 대상 */
  readonly assetCode: string;
  readonly metricKey: string;
}

export interface SiteDef {
  readonly code: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly timezone: string;
  readonly attributes: Readonly<Record<string, boolean | string>>;
  readonly gateway: GatewayDef;
  readonly assets: readonly AssetDef[];
  readonly unmappedTags: readonly UnmappedTagDef[];
}
