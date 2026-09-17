// 프롬프트 만들기와 응답 읽기 (순수). 모델에 보내는 것은 구조화된 근거와 엔진이 이미 만든 문장뿐이다.
// 보내지 않는 것: 원시 시계열(추세 점 좌표 포함)·계정 정보·키를 비롯한 비밀값.
import { PLAYBOOKS } from '@/lib/analytics/playbooks';
import { SAFETY_DECISION_NOTICE } from '@/lib/desk/plain/outlook';
import type { EvidenceView } from '@/lib/desk/evidence-types';
import type { PlainFinding, PlainSummary } from '@/lib/desk/plain';
import { parseLines } from './parse';
import { PLAIN_LINE_KEYS, type LlmRequest, type PlainLines } from './types';

/** om.finding_explanation.prompt_version. 프롬프트를 고치면 올린다 */
export const PLAIN_PROMPT_VERSION = 'plain@2';

export const PLAIN_TEMPERATURE = 0.2;
export const PLAIN_MAX_OUTPUT_TOKENS = 700;

/** 프롬프트에 보내는 발견사항 (쉬운 말 요약 입력 + 카테고리·설비 경로) */
export interface ExplainFinding extends PlainFinding {
  readonly category: string;
  readonly assetPath: string | null;
}

const SYSTEM = [
  '당신은 태양광·수소 발전소 운영 콘솔의 문장 다듬기 도우미입니다.',
  '분석 엔진이 이미 판정과 수치를 냈습니다. 당신이 하는 일은 engineSentences의 각 줄을 현장 담당자가 읽기 쉬운 우리말로 다시 쓰는 것뿐입니다.',
  '',
  '반드시 지킬 것',
  '1. 숫자·날짜·시간은 engineSentences에 나온 것만 글자 그대로 씁니다. 계산하거나 새로 만들지 마세요. evidence의 숫자는 맥락을 이해하는 데만 쓰고 문장에 옮기지 마세요.',
  '2. 늘었다/줄었다, 커졌다/작아졌다 같은 방향을 바꾸지 마세요.',
  '3. 설비 이름과 코드, 사이트 이름은 engineSentences에 나온 그대로 씁니다.',
  '4. 원인을 단정하지 마세요. "~때문입니다", "원인은 ~입니다"라고 쓰지 말고, 확인해야 할 후보로만 쓰세요.',
  `5. 안전을 보장하거나, 운전 정지 여부를 지시하거나, 법적·계약적 조언을 하지 마세요. 고정 안전 문구("${SAFETY_DECISION_NOTICE}")는 엔진이 소유합니다 — 지우거나 바꾸지 마세요.`,
  '6. 각 줄은 engineSentences의 같은 줄과 같은 내용이어야 합니다. 사실을 더하거나 빼지 마세요.',
  '7. 전문 용어 대신 현장에서 쓰는 쉬운 말로, 각 줄 두 문장 이내로 짧게 씁니다. 고정 안전 문구는 이 두 문장에 넣지 않습니다 — 그 문구를 빼려고 다른 사실을 버리지 마세요.',
  '',
  `출력은 JSON 객체 하나입니다. engineSentences에 있는 키(${PLAIN_LINE_KEYS.join(', ')} 중 주어진 것)만 넣고, 값은 다시 쓴 문장 문자열입니다. 다른 키·설명·코드블록을 넣지 마세요.`,
].join('\n');

const checksOf = (evidence: EvidenceView): readonly { label: string; status: string; note: string }[] =>
  'checks' in evidence ? evidence.checks.map((check) => ({ label: check.label, status: check.status, note: check.note })) : [];

/** 추세는 기울기 표기와 점 개수만 보낸다 (점 좌표는 원시 시계열이라 보내지 않는다) */
function trendOf(evidence: EvidenceView): Readonly<Record<string, unknown>> | null {
  if (!('trend' in evidence) || evidence.trend === null) return null;
  const { yName, xKind, slopeText, points, changeStart } = evidence.trend;
  return { yName, xKind, slopeText, pointCount: points.length, hasChangePoint: changeStart !== null };
}

function playbookOf(finding: ExplainFinding): Readonly<Record<string, unknown>> | null {
  const playbook = finding.failureMode === null ? null : PLAYBOOKS[finding.failureMode];
  if (!playbook) return null;
  return {
    title: playbook.title,
    causes: playbook.causes.map((cause) => ({ label: cause.label, check: cause.check })),
    inspections: playbook.inspections,
    actions: playbook.actions,
    falsePositiveTraps: playbook.falsePositiveTraps,
  };
}

/** 엔진이 만든 줄만 추린다 (null인 줄은 모델에게 주지도, 받지도 않는다) */
export function engineLines(summary: PlainSummary): PlainLines {
  return Object.fromEntries(PLAIN_LINE_KEYS.flatMap((key) => (summary[key] === null ? [] : [[key, summary[key]]])));
}

export function buildPlainRequest(finding: ExplainFinding, evidence: EvidenceView, summary: PlainSummary): LlmRequest {
  const payload = {
    site: finding.siteName,
    assetPath: finding.assetPath,
    assetName: finding.assetName,
    detectorId: finding.detectorId,
    failureMode: finding.failureMode,
    category: finding.category,
    severity: finding.severity,
    effect: { metric: finding.effect.metric, value: finding.effect.value, unit: finding.effect.unit, ci: [finding.effect.ciLow, finding.effect.ciHigh], baseline: finding.effect.baseline, current: finding.effect.current, levelUnit: finding.effect.levelUnit },
    evidence: { kind: evidence.kind, trend: trendOf(evidence), checks: checksOf(evidence) },
    playbook: playbookOf(finding),
    engineSentences: engineLines(summary),
  };
  return { system: SYSTEM, user: JSON.stringify(payload), temperature: PLAIN_TEMPERATURE, maxOutputTokens: PLAIN_MAX_OUTPUT_TOKENS };
}

/** 응답 본문 → 쉬운 말 4줄 */
export const parsePlainLines = (text: string): PlainLines | null => parseLines(PLAIN_LINE_KEYS, text);
