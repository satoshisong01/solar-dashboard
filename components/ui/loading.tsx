import { LoaderCircle } from 'lucide-react';

/**
 * 화면 하나를 불러오는 동안. 회색 골격 칸 대신 스피너만 보여 준다.
 * 골격은 자리를 정확히 잡아 주지만 화면이 '비어 있는 것'처럼 보여서, 기다리는 중이라는 것이 읽히지 않는다.
 */
export function ScreenLoading({ label = '불러오는 중' }: Readonly<{ label?: string }>) {
  return (
    <div role="status" className="flex min-h-[60dvh] flex-col items-center justify-center gap-3">
      <LoaderCircle aria-hidden="true" className="size-8 text-accent motion-safe:animate-spin" />
      <p className="text-sm font-medium text-ink-2">{label}</p>
    </div>
  );
}

/** 화면 안의 한 영역(패널·표)을 불러오는 동안. 화면 골격보다 낮게 잡아 다른 영역을 밀어내지 않는다 */
export function SectionLoading({ label = '불러오는 중', className = 'min-h-40' }: Readonly<{ label?: string; className?: string }>) {
  return (
    <div role="status" className={`flex flex-col items-center justify-center gap-2 ${className}`}>
      <LoaderCircle aria-hidden="true" className="size-6 text-accent motion-safe:animate-spin" />
      <p className="text-sm text-ink-2">{label}</p>
    </div>
  );
}

/**
 * 이동을 기다리는 동안 화면 위에 띄우는 진행 배지 (NavigationBadge·router.push 경로가 쓴다).
 * position:fixed라 흐름에서 빠져 레이아웃을 밀지 않고, 여러 개가 떠도 같은 자리에 겹쳐 하나로 보인다.
 * 150ms 뒤에 나타난다(.loading-badge) — 금방 끝나는 이동에서는 깜빡이지 않는다.
 */
export function LoadingBadge({ label = '불러오는 중' }: Readonly<{ label?: string }>) {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-18 z-20 flex justify-center lg:pl-60">
      <span className="loading-badge inline-flex items-center gap-2 rounded-full border border-rule bg-surface/95 px-3 py-1.5 text-sm font-medium text-ink-2 shadow-panel backdrop-blur-md">
        <LoaderCircle className="size-4 text-accent motion-safe:animate-spin" />
        {label}
      </span>
    </div>
  );
}
