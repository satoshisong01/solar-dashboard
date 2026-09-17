// 종합 요약 프롬프트 만들기와 응답 읽기 (순수). 모델에 보내는 것은 분석 엔진이 센 값과 엔진이 이미 만든 문장뿐이다.
// 보내지 않는 것: 원시 시계열·계정 정보·키를 비롯한 비밀값.
import type { DigestStats, DigestSummary } from '@/lib/desk/digest';
import { parseLines } from './parse';
import { DIGEST_LINE_KEYS, type DigestLines, type LlmRequest } from './types';

/** om.finding_digest.prompt_version. 프롬프트를 고치면 올린다 */
export const DIGEST_PROMPT_VERSION = 'digest@1';

export const DIGEST_TEMPERATURE = 0.2;
export const DIGEST_MAX_OUTPUT_TOKENS = 700;

const SYSTEM = [
  '당신은 태양광·수소 발전소 운영 콘솔의 문장 다듬기 도우미입니다.',
  '분석 엔진이 열린 발견사항을 이미 세어 두었습니다. 당신이 하는 일은 engineSentences의 각 줄을 현장 담당자가 읽기 쉬운 우리말로 다시 쓰는 것뿐입니다.',
  '',
  '반드시 지킬 것',
  '1. 숫자는 engineSentences에 나온 것만 글자 그대로 씁니다. 더하거나 빼거나 비율로 바꾸지 마세요. counts의 숫자는 맥락을 이해하는 데만 쓰고 문장에 새로 옮기지 마세요.',
  '2. 계통 이름·설비 이름·사이트 이름은 engineSentences에 나온 그대로 씁니다.',
  '3. 각 줄은 engineSentences의 같은 줄과 같은 내용이어야 합니다. 사실을 더하거나 빼지 마세요.',
  '4. 원인을 단정하지 마세요. "~때문입니다", "원인은 ~입니다"라고 쓰지 말고, 확인해야 할 거리로만 쓰세요.',
  '5. 안전을 보장하거나, 운전 정지 여부를 지시하거나, 법적·계약적 조언을 하지 마세요.',
  '6. 전문 용어 대신 현장에서 쓰는 쉬운 말로, 각 줄 두 문장 이내로 짧게 씁니다. 네 줄을 이어 읽었을 때 한 사람이 말해 주는 것처럼 자연스러워야 합니다.',
  '',
  `출력은 JSON 객체 하나입니다. engineSentences에 있는 키(${DIGEST_LINE_KEYS.join(', ')} 중 주어진 것)만 넣고, 값은 다시 쓴 문장 문자열입니다. 다른 키·설명·코드블록을 넣지 마세요.`,
].join('\n');

/** 엔진이 만든 줄만 추린다 (null인 줄은 모델에게 주지도, 받지도 않는다) */
export function engineDigestLines(summary: DigestSummary): DigestLines {
  return Object.fromEntries(DIGEST_LINE_KEYS.flatMap((key) => (summary[key] === null ? [] : [[key, summary[key]]])));
}

const counts = (rows: readonly { readonly label: string; readonly count: number }[]) => rows.map((row) => ({ label: row.label, count: row.count }));

export function buildDigestRequest(stats: DigestStats, summary: DigestSummary): LlmRequest {
  const payload = {
    scope: stats.siteLabel,
    counts: {
      total: stats.total,
      new: stats.newCount,
      reopened: stats.reopenedCount,
      byEquipment: counts(stats.byDomain),
      byUrgency: counts(stats.byUrgency),
      bySite: counts(stats.bySite),
    },
    worst: stats.top.map((item) => ({ subject: item.subject, site: item.siteCode, severity: item.severity, sentence: item.headline })),
    engineSentences: engineDigestLines(summary),
  };
  return { system: SYSTEM, user: JSON.stringify(payload), temperature: DIGEST_TEMPERATURE, maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS };
}

/** 응답 본문 → 종합 요약 4줄 */
export const parseDigestLines = (text: string): DigestLines | null => parseLines(DIGEST_LINE_KEYS, text);
