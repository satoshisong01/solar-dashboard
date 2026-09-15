// 탐지기 파라미터 zod 스키마 도우미 (detector_config.params 설정 UI·검증용).
// 필드마다 기본값(.default = defaultParams 값)·min·max와 meta({ label, unit, description })를 붙인다.
// 설정 UI는 z.toJSONSchema(schema)로 필드별 label·unit·description·minimum·maximum·default를 읽는다.
import * as z from 'zod';

export interface ParamMeta {
  /** 한국어 라벨 */
  readonly label: string;
  /** 단위 (무차원이면 빈 문자열) */
  readonly unit: string;
  /** 한국어 설명 */
  readonly description: string;
}

interface NumberSpec extends ParamMeta {
  readonly min: number;
  readonly max: number;
}

/** 실수 파라미터 */
export const numParam = (defaultValue: number, spec: NumberSpec) =>
  z.number().min(spec.min).max(spec.max).default(defaultValue).meta({ label: spec.label, unit: spec.unit, description: spec.description });

/** 정수 파라미터 (횟수·반복 수·개수) */
export const intParam = (defaultValue: number, spec: NumberSpec) =>
  z.number().int().min(spec.min).max(spec.max).default(defaultValue).meta({ label: spec.label, unit: spec.unit, description: spec.description });

/** null 허용 실수 파라미터 (null = 자동·명판값 사용) */
export const nullableNumParam = (defaultValue: number | null, spec: NumberSpec) =>
  z.number().min(spec.min).max(spec.max).nullable().default(defaultValue).meta({ label: spec.label, unit: spec.unit, description: spec.description });

/** 켜기·끄기 파라미터 */
export const boolParam = (defaultValue: boolean, meta: Omit<ParamMeta, 'unit'>) => z.boolean().default(defaultValue).meta({ label: meta.label, unit: '', description: meta.description });

/** 선택지 파라미터 */
export const choiceParam = <const T extends readonly [string, ...string[]]>(options: T, defaultValue: T[number], meta: Omit<ParamMeta, 'unit'>) =>
  z.enum(options).default(defaultValue as never).meta({ label: meta.label, unit: '', description: meta.description });

/** 부트스트랩 반복 수 (공용) */
export const iterationsParam = (defaultValue: number) => intParam(defaultValue, { label: '부트스트랩 반복 수', unit: '회', min: 100, max: 10_000, description: '95% 신뢰구간을 구하는 재표집 횟수. 늘리면 CI가 안정되지만 느려집니다.' });

/** 최소 데이터 완결성 (공용) */
export const completenessParam = (defaultValue: number) => numParam(defaultValue, { label: '최소 데이터 완결성', unit: '', min: 0, max: 1, description: '기대 샘플 대비 good 샘플 비율이 이 값 미만인 구간·일은 판정에서 뺍니다.' });
