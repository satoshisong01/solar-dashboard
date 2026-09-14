import { signOutAction } from '@/lib/auth/actions';
import { requireAdmin } from '@/lib/auth/dal';

// 임시 홈. 콘솔 셸과 "오늘" 화면은 다음 단계에서 만든다.
export default async function TodayPage() {
  const { user } = await requireAdmin();

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">HySol Desk</h1>
      <p>{user.name}({user.email})으로 로그인했습니다.</p>
      <form action={signOutAction}>
        <button type="submit" className="rounded border px-3 py-1.5">
          로그아웃
        </button>
      </form>
    </main>
  );
}
