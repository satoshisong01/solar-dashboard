import Link from 'next/link';
import { buttonClass } from '@/components/ui/form-styles';
import { BRAND } from '@/lib/brand';

/**
 * 어느 화면에도 맞지 않는 주소(전역 404). 루트 레이아웃 안에서만 그려지므로 사이드바·상단바가 없고,
 * 로그인 여부도 보지 않는다 — 여기서는 아무 데이터도 읽지 않는다.
 * 콘솔 화면 안에서 notFound()를 부른 경우(없는 사이트 코드·발견사항 id 등)는 app/(console)/not-found.tsx가 받는다.
 * 이 파일이 없으면 Next 기본 404가 뜨는데, 그 화면은 OS 밝기 설정만 따라 어두운 콘솔에서 순백으로 나온다.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-4 px-6 py-16">
      <p className="font-mono text-sm text-muted">404</p>
      <h1 className="text-2xl font-semibold tracking-tight text-balance text-ink">이 주소에는 화면이 없습니다</h1>
      <p className="text-ink-2">주소를 잘못 입력했거나, 옮겨졌거나, 더 이상 쓰지 않는 화면입니다.</p>
      <p>
        <Link href="/" className={buttonClass()}>
          콘솔 첫 화면(대시보드)으로
        </Link>
      </p>
      <p className="border-t border-rule pt-4 text-xs text-muted">
        {BRAND.name} · {BRAND.tagline}
      </p>
    </main>
  );
}
