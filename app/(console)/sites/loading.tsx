import { SkeletonHeader, SkeletonPanel, SkeletonStatus, SkeletonTable } from '@/components/ui/skeleton';

/** 사이트 목록 골격 */
export default function SitesLoading() {
  return (
    <>
      <SkeletonStatus />
      <SkeletonHeader guide />
      <SkeletonPanel titleClassName="w-28">
        <SkeletonTable rows={5} />
      </SkeletonPanel>
    </>
  );
}
