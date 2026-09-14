'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { buttonClass } from '@/components/forms/controls';

/** 인쇄 화면 도구 막대 (인쇄물에는 나오지 않음). PDF 출력 = 브라우저 인쇄 대화상자 */
export function PrintToolbar({ reportId, approved }: Readonly<{ reportId: string; approved: boolean }>) {
  return (
    <div className="print-hidden mx-auto mb-4 flex w-full max-w-[210mm] flex-wrap items-center gap-3">
      <Link href={`/reports/${reportId}`} className={buttonClass('secondary')}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        검토 화면으로
      </Link>
      <button type="button" onClick={() => window.print()} className={buttonClass('primary')}>
        <Printer aria-hidden="true" className="size-4" />
        PDF 출력
      </button>
      <p className="text-xs text-muted">인쇄 대화상자에서 대상(프린터)을 &lsquo;PDF로 저장&rsquo;으로 고르세요. 용지 A4, 배경 그래픽을 켜면 표 머리 색이 함께 나옵니다.{approved ? '' : ' 승인 전 초안입니다.'}</p>
    </div>
  );
}
