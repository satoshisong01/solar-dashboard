import Link from 'next/link';
import { PageHeader } from '@/components/console/page-header';

/** 콘솔 안에서 notFound()가 불렸을 때 (없는 사이트 코드·설비 id 등) */
export default function ConsoleNotFound() {
  return (
    <>
      <PageHeader title="찾을 수 없습니다" purpose="주소의 사이트나 설비가 없거나 다른 사이트에 속해 있습니다." />
      <p className="text-sm">
        <Link href="/sites" className="font-medium text-accent hover:underline">
          사이트 목록으로 이동
        </Link>
      </p>
    </>
  );
}
