import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/console/breadcrumb';
import { PageHeader } from '@/components/console/page-header';
import { TrustBadgeView } from '@/components/desk/finding-header';
import { DetectorConfigForm, type ActiveConfig, type ScopeOption } from '@/components/settings/detector-config-form';
import { DetectorConfigHistory } from '@/components/settings/detector-config-history';
import { DefaultParamsTable } from '@/components/settings/detector-tables';
import { Panel } from '@/components/ui/panel';
import { DETECTORS } from '@/lib/analytics/detectors';
import { allowedScopeKinds, targetingOf, type DetectorTargeting } from '@/lib/analytics/pipeline/targets';
import { playbookFor } from '@/lib/analytics/playbooks';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { requireAdmin } from '@/lib/auth/dal';
import { assetScopeNames, listConfigAssets, listDetectorConfigVersions } from '@/lib/data/detector-configs';
import { decodeRouteParam } from '@/lib/data/range';
import { isSimConsoleEnabled } from '@/lib/data/sim-console';
import { paramFields } from '@/lib/detector-config/fields';
import { configHistory } from '@/lib/detector-config/history';
import { scopeKindOf, scopeLabel } from '@/lib/detector-config/types';
import { CATEGORY_LABELS, detectorLabel } from '@/lib/desk/labels';
import { parseScorecard, trustBadgeFor } from '@/lib/desk/scorecard';

type DetectorPageProps = Readonly<{ params: Promise<{ detectorId: string }> }>;

const detectorOf = (id: string | null) => (id === null ? null : (DETECTORS.find((d) => d.id === id) ?? null));

export async function generateMetadata({ params }: DetectorPageProps): Promise<Metadata> {
  const { detectorId } = await params;
  const id = decodeRouteParam(detectorId);
  return { title: id === null ? '탐지기 설정' : `${detectorLabel(id)} 설정` };
}

function scopeOptions(targeting: DetectorTargeting): ScopeOption[] {
  const labels = { default: '기본 (모든 대상)', class: `설비 종류 (class:${targeting.configClass ?? ''})`, asset: '설비 하나 (asset:id)' } as const;
  return allowedScopeKinds(targeting).map((kind) => ({ kind, label: labels[kind] }));
}

function scopeNote(targeting: DetectorTargeting): string {
  if (targeting.configClass === null) return '이 탐지기는 사이트 전체를 한 번에 판정해 기본(default) 범위 설정만 적용됩니다.';
  if (!targeting.assetScope) return `이 탐지기는 ${targeting.configClass} 동종 그룹을 한 번에 판정해 기본·설비 종류 범위 설정만 적용됩니다.`;
  return `기본 < 설비 종류(${targeting.configClass}) < 설비 순으로 좁은 범위가 이깁니다.`;
}

export default async function DetectorConfigPage({ params }: DetectorPageProps) {
  await requireAdmin();
  const { detectorId } = await params;
  const detector = detectorOf(decodeRouteParam(detectorId));
  const targeting = detector ? targetingOf(detector.id) : null;
  if (!detector || !targeting) notFound();

  const fields = paramFields(detector.paramSchema);
  const [versions, assets] = await Promise.all([listDetectorConfigVersions(detector.id), targeting.assetScope && targeting.configClass ? listConfigAssets(targeting.configClass) : Promise.resolve([])]);
  const history = configHistory(versions, fields);
  const assetIds = versions.flatMap((v) => (scopeKindOf(v.scope) === 'asset' ? [Number(v.scope.slice('asset:'.length))] : []));
  const names = await assetScopeNames(assetIds);
  const scopeNames = Object.fromEntries(history.map((h) => [h.scope, scopeLabel(h.scope, scopeKindOf(h.scope) === 'asset' ? names.get(Number(h.scope.slice('asset:'.length))) : null)]));
  const activeByScope: Record<string, ActiveConfig> = Object.fromEntries(history.flatMap((h) => (h.active ? [[h.scope, { version: h.active.version, params: h.active.params, referenceWindow: h.active.referenceWindow }]] : [])));
  const playbook = playbookFor(detector.failureMode);
  const { requires } = detector;

  return (
    <>
      <Breadcrumb items={[{ label: '설정', href: '/settings' }, { label: '탐지기', href: '/settings/detectors' }, { label: detectorLabel(detector.id) }]} />
      <PageHeader title={`${detectorLabel(detector.id)} 설정`} purpose={`${detector.id}@${detector.version} · ${playbook.title}`} />

      <Panel title="탐지기 정보">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted">고장모드 · 카테고리</dt>
          <dd className="text-ink">
            <span className="font-mono">{detector.failureMode}</span> · {CATEGORY_LABELS[detector.category]}
          </dd>
          <dt className="text-muted">판정 단위</dt>
          <dd className="text-ink">{targeting.findingUnit === 'site' ? '사이트 단위 (발견사항에 설비 없음)' : `설비 단위${targeting.targetClass ? ` (${targeting.targetClass})` : ' (포인트가 있는 모든 설비)'}`}</dd>
          <dt className="text-muted">요구 조건</dt>
          <dd className="text-ink">
            설비 종류 {requires.assetClass.length === 0 ? '제한 없음' : requires.assetClass.join(', ')} · 최소 이력 {requires.minHistoryDays}일 · 포인트 주기 {requires.minPeriodS === null ? '제한 없음' : `${requires.minPeriodS}초 이하`}
            <span className="block font-mono text-xs break-words text-muted">{requires.metrics.length === 0 ? '(필수 메트릭 없음)' : requires.metrics.join(', ')}</span>
          </dd>
          <dt className="text-muted">설정 적용 범위</dt>
          <dd className="text-ink">{scopeNote(targeting)}</dd>
        </dl>
        <TrustBadgeView badge={trustBadgeFor(parseScorecard(scorecardJson), detector.id)} detectorId={detector.id} simEnabled={isSimConsoleEnabled()} />
      </Panel>

      <Panel title="코드 기본값" meta={`파라미터 ${fields.length}개 · 설정 행이 없으면 이 값으로 실행합니다`}>
        <DefaultParamsTable fields={fields} />
      </Panel>

      <Panel title="새 버전 만들기" meta="빈 칸은 저장하지 않고 넓은 범위·코드 기본값을 물려받습니다 · 기본값과 다른 칸은 강조합니다">
        <DetectorConfigForm detectorId={detector.id} fields={fields} scopeOptions={scopeOptions(targeting)} classKey={targeting.configClass} assets={assets} activeByScope={activeByScope} />
      </Panel>

      <Panel title="범위별 활성 버전과 이력" meta={`설정 버전 ${versions.length}개`}>
        <DetectorConfigHistory detectorId={detector.id} history={history} scopeNames={scopeNames} />
      </Panel>
    </>
  );
}
