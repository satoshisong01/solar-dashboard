import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '탐색기' };

export default async function ExplorePage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="탐색기" purpose="임의 포인트를 골라 원시 데이터 탐색" />
      <EmptyState
        phases={[{ code: 'P1' }]}
        items={[
          '자산 트리와 메트릭 선택기',
          '확대하면 서버에서 구간별 최소·평균·최대를 다시 조회',
          '저장된 뷰',
        ]}
      />
    </>
  );
}
