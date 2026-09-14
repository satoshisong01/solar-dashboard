// validateDraft (설계 §5.4): 초안이 팩과 맞는지 검사한다 (순수). 어떤 Composer든 이 검사를 통과해야 승인할 수 있다.
//   1) 팩 해시: 초안의 packHash = 팩 해시 = 팩 내용으로 다시 계산한 해시
//   2) 인용 id가 팩에 있음
//   3) 본문 숫자 = 토큰 = 팩 값 (표시 반올림 허용), 추적되지 않은 숫자 없음
//   4) 심각도 4 이상 발견사항은 포함한 블록이 모두 인용
//   5) 금지 표현(법정 안전 판단 대체·안전 보장 등) 없음, 안전 고정 문구는 포함·원문 그대로
import { SAFETY_NOTICE, type DraftBlock, type ReportDraft } from './composer';
import { computePackHash } from './evidence-pack';
import type { EvidencePack } from './pack-types';
import { SEVERE_THRESHOLD } from './planner';
import { blockTokenIssues, type TokenIssueCode } from './tokens';

export type ValidationIssueCode = TokenIssueCode | 'pack_hash_mismatch' | 'citation_missing' | 'severity_not_mentioned' | 'forbidden_expression' | 'safety_notice_missing' | 'exclude_reason_missing' | 'empty_text';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly blockId: string | null;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  /** 검사한(포함한) 블록 수 */
  readonly checkedBlocks: number;
}

/** 검토 상태가 붙은 블록도 받는다 (포함 여부·제외 사유) */
export type ValidatableBlock = DraftBlock & { readonly included?: boolean; readonly excludeReason?: string | null };
export type ValidatableDraft = Omit<ReportDraft, 'sections'> & { readonly sections: readonly { readonly kind: string; readonly blocks: readonly ValidatableBlock[] }[] };

/** 금지 표현: 콘솔 리포트가 법정 안전 판단·인터록을 대신하거나 안전을 보증하는 문장 (부정문 "대체하지 않습니다"는 허용) */
export const FORBIDDEN_EXPRESSIONS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /안전(을|이)?\s*(보장|보증)/, reason: '안전을 보장·보증하는 표현' },
  { pattern: /(법정|법적)\s*안전\S*.{0,20}(대체|갈음|대신)(합니다|한다|할\s*수\s*있|가능)/, reason: '법정 안전 판단을 대체한다는 표현' },
  { pattern: /인터록.{0,20}(대체|대신|갈음)(합니다|한다|할\s*수\s*있|가능)/, reason: '인터록을 대체한다는 표현' },
  { pattern: /인터록.{0,10}(불필요|해제해도|꺼도)/, reason: '인터록 해제·불필요 표현' },
  { pattern: /안전\s*(점검|검사).{0,6}(불필요|생략|필요\s*없)/, reason: '안전 점검이 필요 없다는 표현' },
  { pattern: /(수소|가스)\s*누출(이|은)?\s*없(음|습니다|다)/, reason: '누출이 없다고 단정하는 표현' },
  { pattern: /(설비|사이트|발전소)(는|은|가|이)?\s*안전(합니다|하다|함)/, reason: '설비가 안전하다고 단정하는 표현' },
];

export function forbiddenReasons(text: string): string[] {
  return FORBIDDEN_EXPRESSIONS.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
}

/** 팩 안에서 인용할 수 있는 근거 id */
export function packCitationIds(pack: EvidencePack): ReadonlySet<string> {
  return new Set([
    'stats',
    'energy',
    'data_quality',
    ...pack.findings.flatMap((f) => [`finding:${f.id}`, ...(f.evidenceId ? [`evidence:${f.evidenceId}`] : [])]),
    ...pack.verifiedActions.flatMap((a) => [`verification:${a.verificationId}`, `action:${a.actionId}`]),
    ...pack.kpis.map((k) => `kpi:${k.key}`),
    ...pack.kpiByAsset.map((k) => `kpi:${k.key}`),
    ...pack.revenueSummary.map((r) => `market:${r.key}`),
  ]);
}

const isIncluded = (block: ValidatableBlock): boolean => block.included !== false;

function blockIssues(block: ValidatableBlock, pack: EvidencePack, citations: ReadonlySet<string>): ValidationIssue[] {
  const at = (code: ValidationIssueCode, message: string): ValidationIssue => ({ code, blockId: block.id, message });
  if (block.text.trim() === '') return [at('empty_text', '본문이 비어 있습니다')];
  return [
    ...block.citations.filter((id) => !citations.has(id)).map((id) => at('citation_missing', `인용 근거 ${id}이(가) 팩에 없습니다`)),
    ...blockTokenIssues(block, pack).map((issue) => at(issue.code, issue.message)),
    ...forbiddenReasons(block.text).map((reason) => at('forbidden_expression', `금지 표현: ${reason}`)),
  ];
}

export function validateDraft(draft: ValidatableDraft, pack: EvidencePack): ValidationResult {
  const blocks = draft.sections.flatMap((section) => section.blocks.map((b) => ({ section: section.kind, block: b })));
  const included = blocks.filter(({ block }) => isIncluded(block));
  const citations = packCitationIds(pack);
  const hash = computePackHash(pack);
  const hashIssues: ValidationIssue[] =
    draft.packHash === pack.provenance.packHash && hash === pack.provenance.packHash ? [] : [{ code: 'pack_hash_mismatch', blockId: null, message: '초안의 팩 해시가 팩 내용과 맞지 않습니다. 리포트를 다시 만드세요' }];
  const excludeIssues = blocks
    .filter(({ block }) => !isIncluded(block) && (block.excludeReason ?? '').trim() === '')
    .map(({ block }): ValidationIssue => ({ code: 'exclude_reason_missing', blockId: block.id, message: '제외한 블록에 제외 사유가 없습니다' }));
  const cited = new Set(included.flatMap(({ block }) => block.citations));
  const severityIssues = pack.findings
    .filter((f) => f.severity >= SEVERE_THRESHOLD && !cited.has(`finding:${f.id}`))
    .map((f): ValidationIssue => ({ code: 'severity_not_mentioned', blockId: null, message: `심각도 ${f.severity} 발견사항 #${f.id}(${f.assetPath})을 언급한 블록이 없습니다` }));
  const safety = included.some(({ section, block }) => section === 'safety' && block.text.includes(SAFETY_NOTICE));
  const safetyIssues: ValidationIssue[] = safety ? [] : [{ code: 'safety_notice_missing', blockId: null, message: `안전 고정 문구가 없습니다: "${SAFETY_NOTICE}"` }];
  const issues = [...hashIssues, ...included.flatMap(({ block }) => blockIssues(block, pack, citations)), ...excludeIssues, ...severityIssues, ...safetyIssues];
  return { ok: issues.length === 0, issues, checkedBlocks: included.length };
}
