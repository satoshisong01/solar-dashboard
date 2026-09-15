import { EmptyNote, Panel } from '@/components/ui/panel';
import { trendAxisText, type TrendView } from '@/lib/desk/trend';
import { TrendChart } from './trend-chart';

type TrendPanelProps = Readonly<{
  trend: TrendView | null;
  label: string;
  footnote?: string | null;
  /** 회색 점 설명을 바꿀 때 (기본: x축 종류별 설명) */
  pointLabel?: string;
}>;

/** 추세 패널 (용량·스택·셀 편차·P3 상승 탐지기 공용): Theil–Sen 산점도 + 기울기 CI + CUSUM 변화 시작 */
export function TrendPanel({ trend, label, footnote, pointLabel }: TrendPanelProps) {
  const axis = trend === null ? null : trendAxisText(trend.xKind);
  return (
    <Panel title="추세" meta={trend?.slopeText ? `Theil–Sen ${trend.slopeText}` : undefined}>
      {trend === null || axis === null ? (
        <EmptyNote>근거에 추세 점이 없습니다</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          <TrendChart trend={trend} label={label} />
          <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
            <li>회색 점: {pointLabel ?? axis.pointLabel} · 선: Theil–Sen 추세 · 음영: 기울기 95% CI 범위</li>
            {trend.line === null && <li>이 근거 스냅샷에는 추세선 좌표가 없습니다(이전 버전 스냅샷). 분석을 다시 실행하면 추세선이 함께 저장됩니다.</li>}
            <li>{trend.changeStart === null ? 'CUSUM 변화 시작점은 찾지 못했습니다.' : `CUSUM 변화 시작: ${axis.value(trend.changeStart)}`}</li>
            {footnote && <li className="font-medium text-ink">{footnote}</li>}
          </ul>
        </div>
      )}
    </Panel>
  );
}
