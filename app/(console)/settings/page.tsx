import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/console/page-header';
import { SETTINGS_TABS, SectionTabs } from '@/components/console/section-tabs';
import { requireAdmin } from '@/lib/auth/dal';

export const metadata: Metadata = { title: '설정' };

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/settings/catalog': '설비 종류와 메트릭 정의. 메트릭 추가·수정은 스키마 변경 없이 INSERT·UPDATE로 합니다.',
  '/settings/detectors': '탐지기 14종의 파라미터 설정 버전(기본·설비 종류·설비 범위)과 기준 창, 활성 전환. 다음 분석 실행부터 적용됩니다.',
  '/settings/gateways': '게이트웨이 등록과 HMAC 키 발급·폐기. 활성 키 2개로 무중단 회전합니다.',
  '/settings/admins': '관리자 계정 발급, 비활성, 로그인 세션 폐기.',
  '/settings/market': 'SMP(육지·제주)·REC 일별 값 수기 입력과 CSV 업로드. 오늘 화면 수익 요약에 쓰입니다.',
};

export default async function SettingsPage() {
  await requireAdmin();

  return (
    <>
      <PageHeader title="설정" purpose="스키마 변경 없이 자산·메트릭 등록, 탐지기 파라미터, 키 회전, 관리자" />
      <SectionTabs label="설정 하위 화면" tabs={SETTINGS_TABS} current={null} />
      <ul className="grid gap-3 md:grid-cols-2">
        {SETTINGS_TABS.map((tab) => (
          <li key={tab.href}>
            <Link href={tab.href} className="flex h-full flex-col gap-1.5 rounded-lg border border-rule bg-surface p-4 hover:border-accent hover:bg-sunken">
              <span className="flex items-center justify-between gap-2 font-semibold text-ink">
                {tab.label}
                <ArrowRight aria-hidden="true" className="size-4 text-accent" />
              </span>
              <span className="text-sm text-ink-2">{DESCRIPTIONS[tab.href]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
