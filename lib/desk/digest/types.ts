// 분석 데스크 종합 요약의 집계·문장 타입. 순수 타입 모듈 (서버·클라이언트 공용).
// 수치와 분류는 모두 열린 발견사항을 센 값이고, 문장은 그 값만 쓴다 (lib/desk/digest/template.ts).
import type { FleetColumn } from '@/lib/data/domains';

/** 설비 계통. 플릿 열(FleetColumn)과 같게 묶고, 어디에도 속하지 않는 건은 'other' */
export type DigestDomain = FleetColumn | 'other';

/** 급함 세 단계 (심각도 4·5 → 바로 확인, 3 → 이번 주 확인, 1·2 → 지켜보기) */
export type DigestUrgency = 'now' | 'week' | 'watch';

export interface DigestCount<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly count: number;
}

/** 목록에 한 줄로 나오는 발견사항 하나 */
export interface DigestItem {
  readonly id: string;
  /** 쉬운 말 한 줄 요약 (인박스와 같은 문장) */
  readonly headline: string;
  /** 문장의 주어 ('배터리 랙 1(RACK01)') */
  readonly subject: string;
  readonly siteCode: string;
  readonly severity: number;
  readonly domain: DigestDomain;
  readonly urgency: DigestUrgency;
}

export interface DigestUrgencyGroup {
  readonly key: DigestUrgency;
  readonly label: string;
  readonly items: readonly DigestItem[];
}

export interface DigestGroup {
  readonly key: DigestDomain;
  readonly label: string;
  readonly count: number;
  readonly urgencies: readonly DigestUrgencyGroup[];
}

/** 열린 발견사항을 센 값. 문장에 쓸 수 있는 숫자는 여기 있는 것뿐이다 */
export interface DigestStats {
  /** 사이트 필터가 걸려 있으면 그 사이트 코드 (전체면 null) */
  readonly site: string | null;
  /** 문장에서 부르는 사이트 이름 (필터가 없거나 이름을 모르면 null) */
  readonly siteLabel: string | null;
  readonly total: number;
  /** 아직 분류하지 않은 새 건 */
  readonly newCount: number;
  /** 조치 뒤 악화·재개로 다시 열린 건 */
  readonly reopenedCount: number;
  /** 계통별 건수 (많은 순) */
  readonly byDomain: readonly DigestCount<DigestDomain>[];
  /** 급함별 건수 (바로 확인 → 이번 주 확인 → 지켜보기, 0건도 포함) */
  readonly byUrgency: readonly DigestCount<DigestUrgency>[];
  /** 사이트별 건수 (많은 순) */
  readonly bySite: readonly DigestCount[];
  /** 가장 심각한 건 (심각도×신뢰도 순) */
  readonly top: readonly DigestItem[];
  /** 상세 보기 목록: 계통 → 급함 */
  readonly groups: readonly DigestGroup[];
}

/** 화면에 그대로 쓰는 종합 요약 문장. 만들 수 없는 줄은 null */
export interface DigestSummary {
  /** 1) 몇 건인가 */
  readonly headline: string;
  /** 2) 어느 계통인가 */
  readonly breakdown: string | null;
  /** 3) 얼마나 급한가 */
  readonly urgency: string | null;
  /** 4) 지금 할 일 */
  readonly nextStep: string | null;
}
