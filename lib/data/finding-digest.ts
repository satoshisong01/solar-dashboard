import 'server-only';
import { db } from '@/lib/db/kysely';
import { buildDigestStats, digestFingerprint, digestTemplate, openFindingsFor, type DigestStats } from '@/lib/desk/digest';
import type { InboxRow } from '@/lib/desk/inbox';
import { getGeminiProvider } from '@/lib/llm/gemini';
import { aiEnabledFor, readAiSettings, type AiSettings } from '@/lib/ops/ai-settings';
import { ALL_SITES_SCOPE, getOrCreateDigest, type Digest } from '@/lib/ops/finding-digest';

export interface DeskDigest {
  readonly stats: DigestStats;
  /** 열린 발견사항이 없으면 문장을 만들지 않는다 (화면이 '확인할 이슈가 없습니다'를 대신 보인다) */
  readonly digest: Digest | null;
}

/**
 * 이 범위에서 AI 설명을 쓰는가.
 * 한 사이트로 좁혀 보는 중이면 그 사이트 설정을, 사이트 전체면 전역 설정을 따른다 (둘 다 없으면 키가 있을 때 켠 것으로 본다).
 */
function digestEnabled(settings: AiSettings, siteId: number | null, hasKey: boolean): boolean {
  return siteId === null ? (settings.global ?? hasKey) : aiEnabledFor(settings, siteId, hasKey);
}

const siteIdOf = async (siteCode: string): Promise<number | null> => {
  const row = await db.selectFrom('om.site').select('id').where('code', '=', siteCode).executeTakeFirst();
  return row?.id ?? null;
};

/**
 * 분석 데스크 맨 위 종합 요약 한 벌: 저장된 문장이 있으면 그것을, 없으면 한 번 만들어 저장한다.
 * 어떤 실패에서도 엔진이 만든 틀 문장이 돌아온다 — 화면은 배지로만 출처를 구분한다.
 * rows는 인박스가 읽은 발견사항 전체이고, 열린 건·사이트 필터는 여기서 건다 (인박스 목록과 같은 규칙).
 */
export async function buildDeskDigest(rows: readonly InboxRow[], site: string | null, regenerate = false): Promise<DeskDigest> {
  const open = openFindingsFor(rows, site);
  const stats = buildDigestStats(open, site);
  if (stats.total === 0) return { stats, digest: null };

  const provider = getGeminiProvider();
  const [settings, siteId] = await Promise.all([readAiSettings(db), site === null ? Promise.resolve(null) : siteIdOf(site)]);
  const digest = await getOrCreateDigest(
    db,
    {
      scopeKey: site ?? ALL_SITES_SCOPE,
      fingerprint: digestFingerprint(open, site),
      stats,
      template: digestTemplate(stats),
      enabled: digestEnabled(settings, siteId, provider !== null),
    },
    provider,
    regenerate,
  );
  return { stats, digest };
}
