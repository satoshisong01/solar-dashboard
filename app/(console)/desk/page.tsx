import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '분석 데스크' };

export default async function DeskPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="분석 데스크" purpose="발견사항(finding) 분류와 근거 확인·원인 판별·권고 작성" />
      <EmptyState
        phases={[{ code: 'P2' }]}
        items={[
          '분석 실행 — 사이트·설비·기간을 골라 수동으로 실행하고 결과를 발견사항으로 저장',
          '인박스 — 심각도×신뢰도 정렬, 필터, 일괄 분류, 기각 사유 필수',
          '증거 캔버스 — 같은 조건 비교표, 에피소드 오버레이, 추세·변화시점, 원시 시계열',
          '원인 후보 판별 체크와 권고 조치 작성',
        ]}
      />
    </>
  );
}
