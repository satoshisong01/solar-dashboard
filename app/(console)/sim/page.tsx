import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/console/page-header';
import { DetectionCurveChart } from '@/components/sim/detection-curve-chart';
import { P3ReferencePanels, TankLeakCurvePanel } from '@/components/sim/p3-panels';
import { DetectorScoresTable, GatesTable } from '@/components/sim/scorecard-tables';
import { EmptyNote, Panel } from '@/components/ui/panel';
import scorecardJson from '@/lib/analytics/scorecard.json';
import { requireAdmin } from '@/lib/auth/dal';
import { isSimConsoleEnabled } from '@/lib/data/sim-console';
import { detectorLabel } from '@/lib/desk/labels';
import { parseScorecard } from '@/lib/desk/scorecard';
import { parseScorecardP3 } from '@/lib/desk/scorecard-p3';

export const metadata: Metadata = { title: '시뮬레이터' };

/** 설계 §4 시뮬레이터 행 (개발 플래그): 주입 고장 대비 탐지기 성능. 데이터는 npm run sim:eval이 갱신하는 lib/analytics/scorecard.json */
export default async function SimPage() {
  await requireAdmin();
  if (!isSimConsoleEnabled()) notFound();
  const scorecard = parseScorecard(scorecardJson);
  const p3 = parseScorecardP3(scorecardJson);
  const withCurves = scorecard.detectors.filter((d) => d.curve.length > 0);
  const meta = [scorecard.mode === 'memory' ? '메모리 모드' : scorecard.mode, scorecard.days !== null ? `${scorecard.days}일` : null, scorecard.seeds.length > 0 ? `시드 ${scorecard.seeds.join('·')}` : null, scorecard.jobs !== null ? `사이트 잡 ${scorecard.jobs}개` : null, scorecard.generatedAt ? `생성 ${scorecard.generatedAt}` : null]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <>
      <PageHeader title="시뮬레이터" purpose="주입한 고장 대비 탐지기 성능: 재현율·정밀도·오탐·탐지 지연·크기 오차·최소 탐지 크기" />
      <p className="-mt-3 text-xs text-muted">
        {meta}. 시뮬레이터 정답 기준 평가라 현장 데이터 성능이 아닙니다. 갱신: <code className="font-mono">npm run sim:eval</code>
      </p>

      <Panel title="CI 게이트" meta={scorecard.pass === null ? undefined : scorecard.pass ? '전부 통과' : '미달 있음'}>
        <GatesTable gates={scorecard.gates} />
      </Panel>

      <Panel title="탐지기별 성능" meta="P2 6종 · P3 8종 (설계 §5.3 탐지기 로드맵)">
        {scorecard.detectors.length === 0 ? <EmptyNote>스코어카드에 탐지기 결과가 없습니다</EmptyNote> : <DetectorScoresTable detectors={scorecard.detectors} />}
        {scorecard.notEvaluated.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-ink-2">
            {scorecard.notEvaluated.map(([id, note]) => (
              <li key={id}>
                평가 안 함 · {detectorLabel(id)} ({id}): {note}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <TankLeakCurvePanel detector={scorecard.detectors.find((d) => d.detectorId === 'tank.static_leak')} gate={scorecard.gates.find((g) => g.id === 'tank.static_leak.min_detectable_kg_per_day')} />

      <P3ReferencePanels p3={p3} gates={scorecard.gates} />

      <Panel title="최소 탐지 크기 곡선" meta="주입 크기별 재현율 (주입 3건씩)">
        {withCurves.length === 0 ? (
          <EmptyNote>곡선을 그릴 주입 결과가 없습니다</EmptyNote>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {withCurves.map((d) => (
              <figure key={d.detectorId} className="flex flex-col gap-1">
                <figcaption className="text-sm font-medium text-ink">{detectorLabel(d.detectorId)}</figcaption>
                <DetectionCurveChart detector={d.detector} curve={d.curve} unit={d.unit ?? ''} minDetectable={d.minDetectableMagnitude} />
              </figure>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="파라미터 조정 기록">
        <ul className="flex flex-col gap-3 text-sm">
          {scorecard.detectors
            .filter((d) => d.paramsNote)
            .map((d) => (
              <li key={d.detectorId}>
                <span className="font-medium text-ink">{detectorLabel(d.detectorId)}</span>
                <span className="block text-ink-2">{d.paramsNote}</span>
              </li>
            ))}
        </ul>
      </Panel>
    </>
  );
}
