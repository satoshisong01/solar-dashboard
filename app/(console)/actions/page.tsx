import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '조치 추적' };

export default async function ActionsPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="조치 추적" purpose="권고가 조치와 효과 검증으로 이어지는지 추적" />
      <EmptyState
        phases={[{ code: 'P2' }]}
        items={[
          '조치 목록과 연결된 발견사항',
          '정비 이력 — 콘솔에서 직접 기록하거나 CSV로 가져오기',
          '검증 대기 큐와 조치 전후 같은 조건 비교',
          '코칭 성과 — 수용률, 효과 확인률, 재발률',
        ]}
      />
    </>
  );
}
