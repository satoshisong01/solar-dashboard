import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '오늘' };

export default async function TodayPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="오늘" purpose="출근 후 5분 안에 할 일과 밤사이 변화 파악" />
      <EmptyState
        phases={[
          { code: 'P1', note: '골격' },
          { code: 'P2', note: '완성' },
        ]}
        items={[
          '안전 배너 — 확인(ack) 전까지 고정 표시',
          '할 일 카운터 — 새 발견사항 · 조사 중 · 리포트 승인 대기 · 검증 결과 도착',
          '신규·악화 발견사항 Top 10과 데이터 공백(끊긴 게이트웨이, 미매핑 태그)',
          '수익 요약 — SMP·REC 수기 입력과 CSV 업로드',
        ]}
      />
    </>
  );
}
