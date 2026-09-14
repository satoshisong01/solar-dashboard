import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { FleetMatrix } from '@/components/fleet/fleet-matrix';
import { FleetView } from '@/components/fleet/fleet-view';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getFleetMatrix } from '@/lib/data/fleet';
import { FLEET_THRESHOLDS } from '@/lib/data/fleet-status';
import { requestTimeMs } from '@/lib/data/time';
import { formatDuration, formatKstDateTime } from '@/lib/format';

export const metadata: Metadata = { title: '플릿' };

export default async function FleetPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();
  const rows = await getFleetMatrix(nowMs);
  const sites = rows.map((row) => ({
    code: row.site.code,
    name: row.site.name,
    lat: row.site.lat,
    lon: row.site.lon,
    level: row.overall,
  }));

  return (
    <>
      <PageHeader title="플릿" purpose="여러 사이트를 도메인별 건강 상태로 관망" />
      <Panel title="사이트 × 도메인 상태" meta={`기준 시각 ${formatKstDateTime(nowMs)} KST`}>
        <FleetView matrix={<FleetMatrix rows={rows} />} sites={sites} />
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">상태 판정 규칙</summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            <li>
              데이터 신선도: 마지막 샘플이 {formatDuration(FLEET_THRESHOLDS.staleWarnMs)} 넘게 없으면 주의,{' '}
              {formatDuration(FLEET_THRESHOLDS.staleCritMs)} 넘게 없으면 위험. 수신 기록이 없으면 데이터 없음.
            </li>
            <li>최근 24시간 알람(안전 이벤트 제외): 주요 알람은 주의, 심각 알람은 위험.</li>
            <li>확인되지 않은 안전 이벤트: 기간과 관계없이 위험.</li>
            <li>
              최근 24시간 품질 이상 비율(장치 불량·범위 밖·급변·고착·시계 의심): {FLEET_THRESHOLDS.dqWarnRatio * 100}% 이상 주의,{' '}
              {FLEET_THRESHOLDS.dqCritRatio * 100}% 이상 위험. 지연 도착·재처리 표시는 값 이상으로 보지 않습니다.
            </li>
            <li>
              열린 발견사항(기각·효과 확인 제외)의 최고 심각도: {FLEET_THRESHOLDS.findingCritSeverity} 이상 위험, {FLEET_THRESHOLDS.findingWarnSeverity} 이상 주의, 1(관찰)은 사유만 표시.
              데이터 품질 발견사항은 데이터품질 열에, 나머지는 설비 종류의 도메인 열에 넣습니다.
            </li>
            <li>데이터품질 열의 신선도·품질 이상 비율은 사이트 전체 포인트를 봅니다.</li>
          </ul>
        </details>
      </Panel>
    </>
  );
}
