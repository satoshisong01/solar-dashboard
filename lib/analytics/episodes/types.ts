// 운전 에피소드 타입 (om.episode 한 행과 1:1). features·conditions·dq는 jsonb로 그대로 저장한다 (키는 snake_case).
import type { AssetSeries, TimeWindow } from '../types';

export type EpisodeKind =
  | 'ess.charge'
  | 'ess.discharge'
  | 'ess.rest'
  | 'pv.day'
  | 'el.steady_run'
  | 'el.start'
  | 'fc.steady_run'
  | 'fc.start';

/**
 * 에피소드 종류별 추출기 버전. 특징(features)이 바뀐 종류만 올린다 — 이전 버전으로 저장한 에피소드는 조회에서 빠지고 다시 추출하면 교체된다.
 * ess.rest@2: 휴지 끝 SOC(soc_end)·휴지 구간 순 Ah(ah_net) 추가 (ess.capacity_fade 휴지 앵커 방식)
 */
export const EXTRACTOR_VERSIONS: Readonly<Record<EpisodeKind, number>> = {
  'ess.charge': 1,
  'ess.discharge': 1,
  'ess.rest': 2,
  'pv.day': 1,
  'el.steady_run': 1,
  'el.start': 1,
  'fc.steady_run': 1,
  'fc.start': 1,
};

/** om.episode.extractor_version 값: 'ess.charge@1' */
export const extractorId = (kind: EpisodeKind): string => `${kind}@${EXTRACTOR_VERSIONS[kind]}`;

export type EpisodeDq = {
  /** 기대 샘플 대비 good 샘플 비율 (필수 메트릭 중 가장 낮은 값) */
  readonly completeness: number;
  /** 기대 샘플 대비 수신되지 않았거나 값이 null인 비율 */
  readonly missing_ratio: number;
  /** 기대 샘플 대비 BAD 품질 비트가 있는 비율 */
  readonly bad_ratio: number;
};

export interface Episode<K extends EpisodeKind, F, C> {
  readonly assetId: number;
  readonly kind: K;
  readonly extractorVersion: string;
  readonly start: number;
  readonly end: number;
  readonly features: F;
  readonly conditions: C;
  readonly dq: EpisodeDq;
  /** 에피소드가 추출 창 경계에 걸려 시작·끝을 확정하지 못함 (다음 추출에서 다시 계산한다) */
  readonly open: boolean;
  readonly valid: boolean;
  readonly invalidReason: string | null;
}

export interface ExtractInput<N> {
  readonly assetId: number;
  readonly window: TimeWindow;
  /** 메트릭 키 → 샘플. 상위 설비 메트릭(예: 전해조 h2.flow.mass, 연료전지 블로워 blower.power)도 같은 맵에 합쳐서 넣는다. */
  readonly series: AssetSeries;
  readonly nameplate: N;
}

/** 에피소드 유효성: 창 경계에 걸리면 무효('open'), 아니면 완결성 기준 */
export function validity(open: boolean, completeness: number, minCompleteness: number): { valid: boolean; invalidReason: string | null } {
  if (open) return { valid: false, invalidReason: 'open' };
  if (completeness < minCompleteness) return { valid: false, invalidReason: 'low_completeness' };
  return { valid: true, invalidReason: null };
}
