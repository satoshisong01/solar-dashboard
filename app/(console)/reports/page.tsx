import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '코칭 리포트' };

// 설계 §0: 분석과 출력 분리, 메일 발송 없음.
export default async function ReportsPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="코칭 리포트" purpose="사이트별 리포트 초안을 만들고 검토·승인한 뒤 PDF로 출력" />
      <EmptyState
        phases={[{ code: 'P2' }]}
        items={[
          '리포트 만들기 — 관리자가 버튼으로 발견사항에서 초안 생성',
          '초안 구성 — 이번 주 할 일 3개, 발견사항, 데이터 품질 요청, 검증된 조치 효과, KPI',
          '인용 칩과 검증기 결과로 검토·승인',
          '인쇄용 화면에서 PDF 출력 (메일 발송 없음)',
        ]}
      />
    </>
  );
}
