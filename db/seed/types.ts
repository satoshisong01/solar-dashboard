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
  /** 도면 계장 태그 (예: PT-201). 도면이 없는 사이트는 null */
  readonly instrumentTag: string | null;
}

/**
 * 계기가 아직 없어 om.point을 만들지 않는 포인트 (데이터 계약으로 벤더·설계사에 요청할 항목).
 * 화면은 '미설치'로 표시한다 — 태그는 있으나 point가 없는 '미매핑'과 다르다.
 */
export interface PlannedPointDef {
  /** 제안 태그. 도면에 태그 자리가 없으면 null */
  readonly instrumentTag: string | null;
  readonly assetCode: string;
  readonly metricKey: string;
  readonly qualifier: string;
  /** 요청 주기 [s]. 계약 문서의 값 그대로 (수집 규약의 60·300 제약을 받지 않는다) */
  readonly periodS: number;
  /** required = 없으면 해당 판정 자체가 성립하지 않음 · recommended = 판별 체크가 줄어듦 */
  readonly necessity: 'required' | 'recommended';
}

/** 명판 값. null은 '미확인'(벤더·설계사 회신 대기)이다 — 추정값으로 채우지 않는다. */
export type Nameplate = Readonly<Record<string, number | string | null>>;

export interface AssetDef {
  readonly code: string; // 사이트 안 경로. 부모는 마지막 '/' 앞부분
  readonly classKey: string;
  readonly level: AssetLevel;
  readonly name: string;
  readonly nameplate: Nameplate;
  readonly peerGroup: string | null;
  readonly criticality: 1 | 2 | 3 | 4 | 5;
  /** YYYY-MM-DD. 아직 준공하지 않은 사이트는 null */
  readonly commissionedAt: string | null;
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
  /** 계기 신설을 요청할 포인트 (DB에 넣지 않는다) */
  readonly plannedPoints: readonly PlannedPointDef[];
}
