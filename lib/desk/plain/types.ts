// 발견사항 쉬운 말 요약의 입력·출력 타입. 순수 타입 모듈 (서버·클라이언트 공용).
// 수치와 판정은 분석 엔진이 낸 값(finding.effect · finding_evidence.snapshot)을 그대로 쓰고 표현만 바꾼다.
import type { FailureMode } from '@/lib/analytics/detectors/types';
import type { EffectView } from '../effect';

/** 문장에서 주어가 되는 대상 (설비가 없으면 사이트 단위 발견사항) */
export interface PlainSubject {
  /** 사람이 부르는 설비 이름 ('배터리 랙 1'). 사이트 단위 발견사항은 null */
  readonly assetName: string | null;
  /** 설비 코드 ('RACK01') */
  readonly assetCode: string | null;
  readonly siteName: string;
}

/** 한 줄 요약(1번 문장)에 필요한 것: 근거 스냅샷 없이 인박스 행만으로 만들 수 있다 */
export interface PlainHeadlineInput extends PlainSubject {
  readonly detectorId: string;
  readonly effect: EffectView;
  /** 탐지기 문장을 만들 수 없을 때 쓰는 원래 제목 */
  readonly title: string;
}

/** 4줄 요약에 필요한 것 (한 줄 요약 입력 + 판정 보류 판단·권고에 쓰는 값) */
export interface PlainFinding extends PlainHeadlineInput {
  readonly failureMode: FailureMode | null;
  readonly severity: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export interface PlainSummary {
  /** 1) 무엇이 어떻게 됐는지 */
  readonly what: string;
  /** 2) 왜 믿을 만한지 (비교 조건) */
  readonly basis: string | null;
  /** 3) 왜 문제인지 · 언제까지 괜찮은지 */
  readonly outlook: string | null;
  /** 4) 지금 할 일 */
  readonly nextStep: string | null;
  /** 데이터가 모자라 아직 판단하기 이른 건 */
  readonly hold: boolean;
}
