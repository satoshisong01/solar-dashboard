import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '데이터' };

export default async function DataPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="데이터" purpose="수집 상태·데이터 품질 관리, 데이터 계약 협의 지원" />
      <EmptyState
        phases={[
          { code: 'P1', note: '수집·품질' },
          { code: 'P3', note: '준비도' },
        ]}
        items={[
          '게이트웨이 표 — 마지막 수신, 시계 오차, 배치 공백',
          '미매핑 태그 → 매핑 → 재처리',
          '데이터 품질 이슈',
          '탐지 준비도 매트릭스 (P3)',
        ]}
      />
    </>
  );
}
