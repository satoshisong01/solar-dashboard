import { EmptyNote, Panel } from '@/components/ui/panel';
import type { CapacityEvidence, EvidenceView, SohTargetView } from '@/lib/desk/evidence-types';
import type { TrendView } from '@/lib/desk/trend';
import { formatKstDate } from '@/lib/format';
import { CapacityBinsTable, CellImbalanceTables, DqPointsTable, PvPeerTable, StackBinsTable } from './comparison-tables';
import { OverlayChart } from './overlay-chart';
import { PeerChart } from './peer-chart';
import { TrendChart } from './trend-chart';

function sohTargetText(target: SohTargetView | null): string | null {
  if (!target || target.estimate === null) return null;
  const range = target.early !== null && target.late !== null ? ` (기울기 95% CI로 ${formatKstDate(target.early)} ~ ${formatKstDate(target.late)})` : target.early !== null ? ` (빠르면 ${formatKstDate(target.early)})` : '';
  return `SOH ${target.pct}% 도달 예상일 ${formatKstDate(target.estimate)}${range} — 현재 추세가 이어진다고 가정한 외삽입니다.`;
}

function TrendPanel({ trend, label, footnote }: Readonly<{ trend: TrendView | null; label: string; footnote?: string | null }>) {
  return (
    <Panel title="추세" meta={trend?.slopeText ? `Theil–Sen ${trend.slopeText}` : undefined}>
      {trend === null ? (
        <EmptyNote>근거에 추세 점이 없습니다</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          <TrendChart trend={trend} label={label} />
          <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
            <li>회색 점: {trend.xKind === 'time' ? '일별 중앙값' : '운전시간 구간 중앙값'} · 선: Theil–Sen 추세 · 음영: 기울기 95% CI 범위</li>
            {trend.line === null && <li>이 근거 스냅샷에는 추세선 좌표가 없습니다(이전 버전 스냅샷). 분석을 다시 실행하면 추세선이 함께 저장됩니다.</li>}
            <li>{trend.changeStart === null ? 'CUSUM 변화 시작점은 찾지 못했습니다.' : `CUSUM 변화 시작: ${trend.xKind === 'time' ? formatKstDate(trend.changeStart) : `누적 ${Math.round(trend.changeStart)} h`}`}</li>
            {footnote && <li className="font-medium text-ink">{footnote}</li>}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function CapacityCanvas({ evidence, chargeTimeText }: Readonly<{ evidence: CapacityEvidence; chargeTimeText: string | null }>) {
  const hasOverlay = evidence.overlay.reference !== null || evidence.overlay.recent !== null;
  return (
    <>
      <Panel title="같은 조건 비교표" meta="bin별 표본 수·중앙값·비율 (표본 가중 결합 + 부트스트랩 95% CI)">
        <CapacityBinsTable evidence={evidence} />
      </Panel>
      <Panel title="에피소드 오버레이" meta="기준·최근 대표 충전 (용량 추정값이 중앙값에 가장 가까운 세션), t=0 정렬">
        {hasOverlay ? <OverlayChart curves={evidence.overlay} chargeTimeText={chargeTimeText} /> : <EmptyNote>근거에 대표 충전 곡선이 없습니다</EmptyNote>}
      </Panel>
      <TrendPanel trend={evidence.trend} label="정격 대비 유효용량" footnote={sohTargetText(evidence.sohTarget)} />
    </>
  );
}

type CanvasProps = Readonly<{
  evidence: EvidenceView;
  chargeTimeText: string | null;
  assetLabel: string;
  peerCodes: ReadonlyMap<number, string>;
}>;

/** 증거 캔버스 (설계 §4 분석 데스크): 탐지기 근거 형식별 비교표·오버레이·추세·동종 비교 */
export function EvidenceCanvas({ evidence, chargeTimeText, assetLabel, peerCodes }: CanvasProps) {
  switch (evidence.kind) {
    case 'capacity':
      return <CapacityCanvas evidence={evidence} chargeTimeText={chargeTimeText} />;
    case 'stack':
      return (
        <>
          <Panel title="같은 조건 비교표" meta="전류밀도×스택 온도 구간별 정상운전">
            <StackBinsTable evidence={evidence} />
          </Panel>
          <TrendPanel trend={evidence.trend} label="조건 보정 셀 전압 잔차" />
        </>
      );
    case 'cell_imbalance':
      return (
        <>
          <Panel title="같은 조건 비교표 · 동종 비교" meta="충전 종료 셀 전압 편차">
            <CellImbalanceTables evidence={evidence} assetCodes={peerCodes} selfLabel={assetLabel} />
          </Panel>
          <TrendPanel trend={evidence.trend} label="셀 전압 편차" />
        </>
      );
    case 'pv_peer':
      return (
        <Panel title="동종 비교" meta="같은 사이트 동종 인버터 일 kWh/kWp (기상 영향은 동종 비교로 제거)">
          <PeerChart days={evidence.days} assetLabel={assetLabel} />
          <PvPeerTable evidence={evidence} />
        </Panel>
      );
    case 'dq':
      return (
        <Panel title="데이터 품질 근거" meta="포인트별 결측·고착">
          <DqPointsTable evidence={evidence} />
        </Panel>
      );
    default:
      return (
        <Panel title="근거">
          <EmptyNote>이 근거 형식은 화면에서 아직 보여 주지 않습니다</EmptyNote>
        </Panel>
      );
  }
}
