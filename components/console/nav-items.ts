import {
  ChartSpline,
  Database,
  FileText,
  FlaskConical,
  LayoutGrid,
  ListChecks,
  MapPin,
  Microscope,
  Settings,
  ShieldAlert,
  Sunrise,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = Readonly<{ href: string; label: string; icon: LucideIcon }>;
export type NavGroup = Readonly<{ id: string; label: string; items: readonly NavItem[] }>;

/** 설계 §4 IA의 메뉴 구조. 사이드바·모바일 탭·상단 바 제목이 함께 쓴다. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'operate',
    label: '운영',
    items: [
      { href: '/', label: '오늘', icon: Sunrise },
      { href: '/fleet', label: '플릿', icon: LayoutGrid },
      { href: '/sites', label: '사이트', icon: MapPin },
      { href: '/explore', label: '탐색기', icon: ChartSpline },
    ],
  },
  {
    id: 'analysis',
    label: '분석·코칭',
    items: [
      { href: '/desk', label: '분석 데스크', icon: Microscope },
      { href: '/reports', label: '코칭 리포트', icon: FileText },
      { href: '/actions', label: '조치 추적', icon: ListChecks },
    ],
  },
  {
    id: 'safety-data',
    label: '안전·데이터',
    items: [
      { href: '/safety', label: '안전', icon: ShieldAlert },
      { href: '/data', label: '데이터', icon: Database },
      { href: '/settings', label: '설정', icon: Settings },
    ],
  },
];

/** 시뮬레이터 스코어카드 (개발 플래그 HYSOL_SHOW_SIM=1일 때만 분석·코칭 그룹 끝에 붙인다) */
export const SIM_NAV_ITEM: NavItem = { href: '/sim', label: '시뮬레이터', icon: FlaskConical };

/** 메뉴 구성: showSim이면 분석·코칭 그룹에 시뮬레이터를 더한다 */
export function navGroupsFor(showSim: boolean): readonly NavGroup[] {
  if (!showSim) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => (group.id === 'analysis' ? { ...group, items: [...group.items, SIM_NAV_ITEM] } : group));
}

/** '/'는 정확히 일치할 때만, 나머지는 하위 경로(/sites/SIM-A 등)까지 활성으로 본다. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
