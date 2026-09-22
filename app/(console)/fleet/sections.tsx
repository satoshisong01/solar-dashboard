import { FleetMatrix } from '@/components/fleet/fleet-matrix';
import { FleetView } from '@/components/fleet/fleet-view';
import { getFleetMatrix } from '@/lib/data/fleet';
import { getFleetMapSites } from '@/lib/data/site-map-board';

/**
 * 플릿의 느린 부분. 사이트 × 도메인 집계(품질 비율·열린 발견사항)가 이 화면에서 가장 오래 걸려
 * 제목·기준 시각·판정 규칙과 떼어 Suspense 경계 안에 둔다 (page.tsx).
 * 골격은 loading.tsx와 Suspense fallback이 함께 쓴다.
 */
export async function FleetBoardSection({ nowMs }: Readonly<{ nowMs: number }>) {
  const [rows, mapBoard] = await Promise.all([getFleetMatrix(nowMs), getFleetMapSites(nowMs)]);
  return <FleetView matrix={<FleetMatrix rows={rows} />} sites={mapBoard.sites} nowMs={nowMs} />;
}
