import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/console/page-header';
import { SCREEN_GUIDES } from '@/lib/desk/plain/guides';
import { Panel } from '@/components/ui/panel';
import { SkeletonSpinner } from '@/components/ui/skeleton';
import { requireAdmin } from '@/lib/auth/dal';
import { FLEET_THRESHOLDS, LEDGER_RESIDUAL_RULES } from '@/lib/data/fleet-status';
import { requestTimeMs } from '@/lib/data/time';
import { formatDuration, formatKstDateTime } from '@/lib/format';
import { FleetBoardSection, FleetBoardSkeleton } from './sections';

export const metadata: Metadata = { title: '플릿' };

/** 제목·기준 시각·판정 규칙은 바로 그리고, 오래 걸리는 도메인 집계는 Suspense 경계 안에서 채운다 (sections.tsx) */
export default async function FleetPage() {
  await requireAdmin();
  const nowMs = requestTimeMs();

  return (
    <>
      <PageHeader title="플릿" purpose="여러 사이트를 도메인별 건강 상태로 관망" guide={SCREEN_GUIDES.fleet} />
      <Panel title="사이트 × 도메인 상태" meta={`기준 시각 ${formatKstDateTime(nowMs)} KST`}>
        <Suspense fallback={<><SkeletonSpinner /><FleetBoardSkeleton /></>}>
          <FleetBoardSection nowMs={nowMs} />
        </Suspense>
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
              데이터 품질 발견사항은 데이터품질 열에, 나머지는 설비 종류의 도메인 열에 넣습니다. 사이트 단위 발견사항은 탐지기로 열을 정합니다(태양광 오염 → PV, 수소 물질수지 잔차 → 저장).
            </li>
            <li>열린 안전 발견사항(안전 카테고리·심각도 4 이상, 분석 결과): 위험. 사유에 건수를 따로 적습니다.</li>
            <li>
              수소 원장 잔차(저장 열): 최근 {LEDGER_RESIDUAL_RULES.recentDays}일 원장 중 완결성 기준 이상인 날이 {LEDGER_RESIDUAL_RULES.minDays}일 이상이고 잔차율 중앙값의 절댓값이 물질수지 탐지기 기준(활성 설정)을 넘으면 주의. 분석 실행이 저장한 끝난 날의 원장만 보며, 14일보다 오래 멈춘 원장은 쓰지 않습니다.
            </li>
            <li>데이터품질 열의 신선도·품질 이상 비율은 사이트 전체 포인트를 봅니다.</li>
          </ul>
        </details>
      </Panel>
    </>
  );
}
