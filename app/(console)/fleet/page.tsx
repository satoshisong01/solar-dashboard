import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '플릿' };

export default async function FleetPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="플릿" purpose="여러 사이트를 도메인별 건강 상태로 관망" />
      <EmptyState
        phases={[{ code: 'P1' }]}
        items={[
          '사이트 × 도메인(PV · ESS · 전해조 · 저장 · 연료전지 · 데이터 품질) 건강 매트릭스',
          '지도 보기 전환 — 사이트 상태·날씨 마커',
        ]}
      />
    </>
  );
}
