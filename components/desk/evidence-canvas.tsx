import { EmptyNote, Panel } from '@/components/ui/panel';
import { formatSigned } from '@/lib/desk/effect';
import { cautionLabel } from '@/lib/desk/labels';
import { pendingProjectionText } from '@/lib/desk/projection';
import type { CapacityEvidence, EvidenceView, SohTargetView } from '@/lib/desk/evidence-types';
import { formatKstDate } from '@/lib/format';
import { CapacityBinsTable, CellImbalanceTables, DqPointsTable, PvPeerTable, StackBinsTable } from './comparison-tables';
import { OverlayChart } from './overlay-chart';
import { GapyeongCanvas } from './p3/gapyeong-canvas';
import { MassBalanceCanvas } from './p3/mass-balance-canvas';
import { RiseCanvas } from './p3/rise-canvas';
import { SoilingCanvas } from './p3/soiling-canvas';
import { TankLeakCanvas } from './p3/tank-leak-canvas';
import { ThermalCanvas } from './p3/thermal-canvas';
import { PeerChart } from './peer-chart';
import { TrendPanel } from './trend-panel';

function sohTargetText(target: SohTargetView | null): string | null {
  const projection = target?.projection;
  if (!target || !projection) return null;
  if (projection.kind === 'pending') return `SOH ${target.pct}% 도달 예상일: ${pendingProjectionText(projection.spanDays)} — 데이터 기간이 짧거나 감소 기울기가 유의하지 않거나 예상 시점이 10년 넘게 떨어져 날짜를 쓰지 않습니다.`;
  const range = projection.early !== null && projection.late !== null ? ` (기울기 95% CI로 ${formatKstDate(projection.early)} ~ ${formatKstDate(projection.late)})` : projection.early !== null ? ` (빠르면 ${formatKstDate(projection.early)})` : '';
  return `SOH ${target.pct}% 도달 예상일 ${formatKstDate(projection.estimate)}${range} — 현재 추세가 이어진다고 가정한 외삽입니다.`;
}

function CapacityCanvas({ evidence, chargeTimeText }: Readonly<{ evidence: CapacityEvidence; chargeTimeText: string | null }>) {
  const hasOverlay = evidence.overlay.reference !== null || evidence.overlay.recent !== null;
  return (
    <>
      <Panel title="같은 조건 비교표" meta="bin별 기준(각 bin의 가장 이른 표본)·최근 표본 수·가중 중앙값·비율 (최근 가중치 결합 + 부트스트랩 95% CI)">
        <div className="flex flex-col gap-2">
          <CapacityBinsTable evidence={evidence} />
          {evidence.cautions.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
              {evidence.cautions.map((code) => (
                <li key={code}>주의: {cautionLabel(code)}</li>
              ))}
            </ul>
          )}
        </div>
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
  siteCode: string;
  peerCodes: ReadonlyMap<number, string>;
}>;

/** 증거 캔버스 (설계 §4 분석 데스크): 탐지기 근거 형식별 비교표·오버레이·추세·동종 비교 (P3 8종은 p3/ 렌더러) */
export function EvidenceCanvas({ evidence, chargeTimeText, assetLabel, siteCode, peerCodes }: CanvasProps) {
  switch (evidence.kind) {
    case 'capacity':
      return <CapacityCanvas evidence={evidence} chargeTimeText={chargeTimeText} />;
    case 'stack':
      return (
        <>
          <Panel title="같은 조건 비교표" meta="전류밀도×스택 온도 구간별 정상운전">
            <StackBinsTable evidence={evidence} />
          </Panel>
          <TrendPanel
            trend={evidence.trend}
            label="조건 보정 셀 전압 잔차"
            footnote={evidence.slopeBasis === 'post_change' && evidence.trend?.changeStart != null ? `효과 기울기는 CUSUM 변화점(누적 ${Math.round(evidence.trend.changeStart)} h) 이후 점으로 계산했습니다${evidence.fullSlopeUvPerH === null ? '' : ` (전체 점 기울기 ${formatSigned(evidence.fullSlopeUvPerH, 1)} µV/h)`}.` : null}
          />
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
    case 'rise':
      return <RiseCanvas evidence={evidence} />;
    case 'tank_leak':
      return <TankLeakCanvas evidence={evidence} />;
    case 'mass_balance':
      return <MassBalanceCanvas evidence={evidence} siteCode={siteCode} />;
    case 'soiling':
      return <SoilingCanvas evidence={evidence} />;
    case 'thermal':
      return <ThermalCanvas evidence={evidence} />;
    case 'gapyeong':
      return <GapyeongCanvas evidence={evidence} />;
    default:
      return (
        <Panel title="근거">
          <EmptyNote>이 근거 형식은 화면에서 아직 보여 주지 않습니다</EmptyNote>
        </Panel>
      );
  }
}
