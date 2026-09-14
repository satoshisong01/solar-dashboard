import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrintReport } from '@/components/reports/print-report';
import { PrintToolbar } from '@/components/reports/print-toolbar';
import { requireAdmin } from '@/lib/auth/dal';
import { getReportDetail } from '@/lib/data/reports';

export const metadata: Metadata = { title: '리포트 인쇄' };

const BIGINT_ID = /^[1-9]\d{0,17}$/;

type PrintPageProps = Readonly<{ params: Promise<{ id: string }> }>;

// 인쇄 전용 화면: 콘솔 크롬(사이드바·상단 바) 없이 A4 한 장 흐름. "PDF 출력" = window.print(). 메일·서버 PDF·전달 기록 없음 (설계 §0).
export default async function ReportPrintPage({ params }: PrintPageProps) {
  await requireAdmin();
  const { id } = await params;
  if (!BIGINT_ID.test(id)) notFound();
  const report = await getReportDetail(id);
  if (!report || !report.draft || !report.pack) notFound();

  return (
    <main className="print-root min-h-dvh px-4 py-6">
      <PrintToolbar reportId={report.id} approved={report.status === 'approved'} />
      <PrintReport report={report} draft={report.draft} pack={report.pack} />
    </main>
  );
}
