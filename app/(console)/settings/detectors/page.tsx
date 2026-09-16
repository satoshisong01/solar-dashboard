import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { DetectorListTable, type DetectorListRow } from '@/components/settings/detector-tables';
import { Panel } from '@/components/ui/panel';
import { DETECTORS, metricRequirementText } from '@/lib/analytics/detectors';
import { playbookFor } from '@/lib/analytics/playbooks';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { targetingOf } from '@/lib/analytics/pipeline/targets';
import { requireAdmin } from '@/lib/auth/dal';
import { activeScopeCounts } from '@/lib/data/detector-configs';
import { CATEGORY_LABELS, detectorLabel } from '@/lib/desk/labels';
import { parseScorecard, trustBadgeFor } from '@/lib/desk/scorecard';

export const metadata: Metadata = { title: '탐지기 설정' };

export default async function DetectorSettingsPage() {
  await requireAdmin();
  const counts = await activeScopeCounts();
  const scorecard = parseScorecard(scorecardJson);
  const rows: readonly DetectorListRow[] = DETECTORS.map((detector) => ({
    id: detector.id,
    version: detector.version,
    label: detectorLabel(detector.id),
    failureMode: detector.failureMode,
    failureModeTitle: playbookFor(detector.failureMode).title,
    categoryLabel: CATEGORY_LABELS[detector.category],
    unitLabel: targetingOf(detector.id)?.findingUnit === 'site' ? '사이트 단위' : '설비 단위',
    assetClasses: detector.requires.assetClass,
    metrics: detector.requires.metrics.map(metricRequirementText),
    badge: trustBadgeFor(scorecard, detector.id),
    activeScopes: counts.get(detector.id) ?? 0,
  }));

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current="/settings/detectors" />
      <Panel title="탐지기" meta={`${rows.length}종 · 파라미터는 코드 기본값 위에 기본 < 설비 종류 < 설비 범위 설정을 얹어 분석 실행 때 적용합니다`}>
        <DetectorListTable rows={rows} />
        <p className="text-xs text-muted">
          스코어카드는 시뮬레이터 평가(npm run sim:eval, {scorecard.generatedAt ?? '생성 시각 없음'}) 결과이며 현장 데이터 성능이 아닙니다. 설정 변경은 다음 분석 실행부터 적용되며 기존 발견사항은 바뀌지 않습니다.
        </p>
      </Panel>
    </>
  );
}
