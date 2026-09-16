import 'server-only';
import { db } from '@/lib/db/kysely';
import { plainSummary, type PlainFinding } from '@/lib/desk/plain';
import { getGeminiProvider } from '@/lib/llm/gemini';
import type { ExplainFinding } from '@/lib/llm/prompt';
import { aiEnabledFor, readAiSettings } from '@/lib/ops/ai-settings';
import { getOrCreateExplanation, type Explanation } from '@/lib/ops/finding-explanation';
import type { FindingDetail } from './finding-workspace';

/** 워크스페이스 발견사항 → 쉬운 말 요약 입력 */
export function plainFindingOf(finding: FindingDetail): PlainFinding {
  return {
    assetName: finding.asset?.name ?? null,
    assetCode: finding.asset?.code ?? null,
    siteName: finding.siteName,
    detectorId: finding.detectorId,
    failureMode: finding.failureMode,
    severity: finding.severity,
    title: finding.title,
    effect: finding.effect,
    windowStartMs: finding.windowStartMs,
    windowEndMs: finding.windowEndMs,
  };
}

const explainFindingOf = (finding: FindingDetail): ExplainFinding => ({ ...plainFindingOf(finding), category: finding.category, assetPath: finding.asset?.path ?? null });

/**
 * 쉬운 요약 한 벌: 저장된 AI 문장이 있으면 그것, 없으면 한 번 만들어 저장한다.
 * 어떤 실패에서도 과제 2의 틀 문장이 돌아온다 — 화면은 배지로만 출처를 구분한다.
 */
export async function explanationForFinding(finding: FindingDetail, regenerate = false): Promise<Explanation> {
  const provider = getGeminiProvider();
  const settings = await readAiSettings(db);
  return getOrCreateExplanation(
    db,
    {
      findingId: finding.id,
      evidenceId: finding.evidenceId,
      finding: explainFindingOf(finding),
      evidence: finding.evidence,
      template: plainSummary(plainFindingOf(finding), finding.evidence),
      enabled: aiEnabledFor(settings, finding.siteId, provider !== null),
    },
    provider,
    regenerate,
  );
}
