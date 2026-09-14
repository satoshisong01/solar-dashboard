import type { Metadata } from 'next';
import { EmptyState } from '@/components/console/empty-state';
import { PageHeader } from '@/components/console/page-header';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '사이트' };

// 사이트 목록 자리. 사이트 테이블과 등록은 P1에서 생기므로 지금은 조회하지 않는다.
export default async function SitesPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="사이트" purpose="사이트 맥락: 설비 트리, KPI, 타임라인, 에너지·수소 체인" />
      <EmptyState
        title="등록된 사이트가 없습니다"
        phases={[
          { code: 'P1', note: '목록·상세' },
          { code: 'P3', note: '수소 체인' },
        ]}
        items={[
          '자산 트리와 발견사항 배지',
          'KPI 카드 — PR, ESS 왕복효율, 전해조 kWh/kg, 연료전지 kg/MWh, 가용률',
          '이벤트 타임라인',
          '에너지·수소 체인 흐름도와 물질수지 잔차 (P3)',
        ]}
      />
    </>
  );
}
