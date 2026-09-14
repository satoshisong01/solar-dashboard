// ReportComposer 인터페이스 (설계 §5.4). 순수 타입 모듈.
// Composer는 EvidencePack을 문장으로 옮기기만 한다: 어떤 항목·수치·우선순위를 말할지는 팩(planner)이 이미 정했다.
// 본문의 숫자는 모두 numberTokens로 팩 경로와 이어져야 하고, validateDraft가 그 값을 팩과 대조한다.
//
// LLM 연결 지점 (이번 단계는 구현하지 않음, 설계 §4.2·§5.4):
//   나중에 LlmComposer가 이 인터페이스를 구현할 수 있다. 조건은 세 가지다.
//   1) 입력은 EvidencePack뿐이다 (원시 시계열·DB 직접 조회 금지). 사이트 데이터를 외부 LLM으로 보내도 되는지는 착수 전에 정책으로 정한다.
//   2) 출력은 같은 ReportDraft 구조(구조화 출력)이고, 숫자는 numberTokens로만 쓴다.
//   3) validateDraft를 통과한 초안만 채택하고, 실패하면 templateComposer 결과로 되돌린다. 바뀌는 것은 문장 품질뿐이다.
import type { EvidencePack } from './pack-types';

export type SectionKind = 'summary' | 'todo' | 'findings' | 'data_quality' | 'verified_actions' | 'kpi' | 'safety';

/** 본문 숫자 표기 방식 */
export type TokenFormat = 'number' | 'signed' | 'percent' | 'date' | 'duration' | 'label';

/**
 * 본문에 들어간 값 하나와 그 출처(팩 경로).
 * - number/signed/percent: 소수 digits자리 반올림 표시 (percent는 0~1 값을 ×100), abs면 절댓값
 * - date: KST 'YYYY-MM-DD' / duration: 시간 → '8h 00m'
 * - label: 숫자가 섞일 수 있는 이름(설비 경로·조치 이름 등). 문자열 그대로 비교하고, 본문 숫자 검사에서는 뺀다
 */
export interface NumberToken {
  readonly text: string;
  readonly path: string;
  readonly format: TokenFormat;
  readonly digits: number;
  readonly abs: boolean;
}

export interface DraftBlock {
  /** 초안 안에서 고유 (예: finding.12.message) */
  readonly id: string;
  readonly text: string;
  /** 팩 안의 근거 id (finding:12, evidence:34, verification:5, kpi:pv.kwh, market:smp_land, energy, stats) */
  readonly citations: readonly string[];
  readonly numberTokens: readonly NumberToken[];
}

export interface DraftSection {
  readonly kind: SectionKind;
  readonly title: string;
  readonly blocks: readonly DraftBlock[];
}

export interface ReportDraft {
  readonly composerId: string;
  readonly packHash: string;
  readonly title: string;
  readonly sections: readonly DraftSection[];
}

export interface ComposeOptions {
  /** 문장 언어. 현재 한국어만 지원한다 */
  readonly locale?: 'ko';
}

export interface ReportComposer {
  /** 예: templateComposer@1 (om.report.composer_id) */
  readonly id: string;
  compose(pack: EvidencePack, options?: ComposeOptions): ReportDraft;
}

/** 안전 고정 문구 (설계 §9: 콘솔을 안전설비로 오인하지 않게). 편집·제외할 수 없다 */
export const SAFETY_NOTICE = '이 리포트는 법정 안전설비·현장 PLC 인터록 판단을 대체하지 않습니다.';
