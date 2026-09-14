/** 로딩 자리. 스크린리더에는 loading.tsx의 상태 문구만 읽힌다 */
export function Skeleton({ className = '' }: Readonly<{ className?: string }>) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-sunken ${className}`} />;
}
