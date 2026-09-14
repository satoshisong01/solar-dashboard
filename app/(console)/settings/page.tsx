import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '설정' };

export default async function SettingsPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <EmptyState
        phases={[
          { code: 'P1', note: '카탈로그·키' },
          { code: 'P2', note: '탐지기' },
        ]}
        items={[
          '자산 트리와 메트릭 정의 편집',
          '탐지기 파라미터 설정 버전 (P2)',
          '게이트웨이 키 — 활성 키 2개로 회전',
          '관리자 계정',
        ]}
      />
    </>
  );
}
