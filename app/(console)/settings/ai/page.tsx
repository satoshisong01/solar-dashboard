import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { AiGlobalForm, AiSiteForm } from '@/components/settings/ai-forms';
import { EmptyNote, Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { listSites } from '@/lib/data/sites';
import { db } from '@/lib/db/kysely';
import { getGeminiProvider } from '@/lib/llm/gemini';
import { PLAIN_PROMPT_VERSION } from '@/lib/llm/prompt';
import { aiEnabledFor, readAiSettings } from '@/lib/ops/ai-settings';

export const metadata: Metadata = { title: 'AI 설명' };

export default async function AiSettingsPage() {
  await requireAdmin();
  const provider = getGeminiProvider();
  const hasKey = provider !== null;
  const [settings, sites] = await Promise.all([readAiSettings(db), listSites()]);

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/ai" />

      <Panel title="AI 설명" meta={hasKey ? `모델 ${provider.model} · 프롬프트 ${PLAIN_PROMPT_VERSION}` : '키가 없어 규칙 기반 요약만 씁니다'}>
        <p className="text-sm text-ink-2">
          발견사항의 쉬운 요약 문장을 AI가 다시 씁니다. <strong className="font-medium text-ink">판정과 수치는 언제나 분석 엔진 값</strong>이고, AI가 쓴 문장에 엔진이 내지 않은 숫자·뒤집힌 방향·금지
          표현이 있으면 채택하지 않고 규칙 기반 요약을 그대로 씁니다. 같은 근거면 한 번만 만들어 두고 다시 쓰며, 근거가 바뀌면 새로 만듭니다.
        </p>
        <p className="text-sm text-muted">
          GEMINI_API_KEY {hasKey ? '등록됨' : '없음'}
          {hasKey ? '' : ' — 키를 넣기 전에는 이 설정을 켜도 규칙 기반 요약만 나옵니다.'}
        </p>
        <AiGlobalForm current={settings.global ?? hasKey} />
      </Panel>

      <Panel title="사이트별 설정" meta="사이트 설정이 전역 기본값보다 앞섭니다">
        {sites.length === 0 ? (
          <EmptyNote>등록된 사이트가 없습니다</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-4">
            {sites.map((site) => (
              <li key={site.id}>
                <AiSiteForm
                  site={{
                    id: site.id,
                    code: site.code,
                    name: site.name,
                    choice: settings.bySite.has(site.id) ? (aiEnabledFor(settings, site.id, hasKey) ? 'on' : 'off') : 'inherit',
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
