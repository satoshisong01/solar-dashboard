// 지도 상태 수준의 표시 규칙 (색·아이콘·글자). 색만으로 구분하지 않는다: 어디서나 아이콘과 글자를 함께 쓴다.
import { CircleCheck, OctagonAlert, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { MAP_LEVEL_LABELS, type MapLevel } from '@/lib/data/map-status';

interface LevelMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  /** 지도 위 마커 원. 카카오 지도는 늘 밝은 배경이라 테마와 무관한 고정 색을 쓴다 */
  readonly marker: string;
  /** 목록·요약의 작은 점 */
  readonly dot: string;
  /** 패널 위 배지. 여기서는 테마를 따르는 시맨틱 토큰을 써 밝은/어두운 화면 모두에서 읽힌다 */
  readonly badge: string;
}

export const MAP_LEVEL_META: Readonly<Record<MapLevel, LevelMeta>> = {
  critical: { label: MAP_LEVEL_LABELS.critical, icon: OctagonAlert, marker: 'bg-map-crit text-map-crit-on', dot: 'bg-map-crit', badge: 'border-crit/50 bg-crit-fill text-crit' },
  warning: { label: MAP_LEVEL_LABELS.warning, icon: TriangleAlert, marker: 'bg-map-warn text-map-warn-on', dot: 'bg-map-warn', badge: 'border-warn/50 bg-warn-fill text-warn' },
  normal: { label: MAP_LEVEL_LABELS.normal, icon: CircleCheck, marker: 'bg-map-ok text-map-ok-on', dot: 'bg-map-ok', badge: 'border-ok/50 bg-ok-fill text-ok' },
  offline: { label: MAP_LEVEL_LABELS.offline, icon: WifiOff, marker: 'bg-map-off text-map-off-on', dot: 'bg-map-off', badge: 'border-rule-strong bg-sunken text-ink-2' },
};

export function MapLevelBadge({ level, className = '' }: Readonly<{ level: MapLevel; className?: string }>) {
  const { label, icon: Icon, badge } = MAP_LEVEL_META[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${badge} ${className}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
