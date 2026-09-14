import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '안전' };

export default async function SafetyPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="안전" purpose="안전 이벤트 즉시 경로와 확인 이력" />
      <EmptyState
        phases={[{ code: 'P1' }]}
        items={[
          '미확인 안전 이벤트 — 자동으로 해제되지 않음',
          '안전감시 공백 타임라인',
          '확인(ack) 기록',
        ]}
      />
    </>
  );
}
