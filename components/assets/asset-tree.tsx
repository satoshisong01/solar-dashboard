import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { AssetNode } from '@/lib/data/asset-tree';
import { ASSET_LEVEL_LABELS } from '@/lib/data/domains';
import type { SiteAssetRow } from '@/lib/data/sites';

type TreeNode = AssetNode<SiteAssetRow>;

function NodeLabel({ node, siteCode }: Readonly<{ node: TreeNode; siteCode: string }>) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
      <Link href={`/sites/${encodeURIComponent(siteCode)}/assets/${node.id}`} className="font-medium text-ink hover:underline">
        {node.name}
      </Link>
      <span className="font-mono text-xs text-muted">{node.code}</span>
      <span className="text-xs text-muted">
        {ASSET_LEVEL_LABELS[node.level] ?? node.level} · {node.className} · 포인트 {node.pointCount}
      </span>
    </span>
  );
}

function TreeItem({ node, siteCode }: Readonly<{ node: TreeNode; siteCode: string }>) {
  if (node.children.length === 0) {
    return (
      <li className="flex items-baseline gap-1.5 py-1 pl-5">
        <NodeLabel node={node} siteCode={siteCode} />
      </li>
    );
  }
  return (
    <li>
      {/* 계통은 펼친 채로, 그 아래는 접어 둔다. 브라우저 기본 details라 JS 없이 접고 편다 */}
      <details open={node.level === 'system'}>
        <summary className="flex cursor-pointer list-none items-baseline gap-1.5 rounded py-1 hover:bg-sunken [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted transition-transform [details[open]>summary>&]:rotate-90" />
          <NodeLabel node={node} siteCode={siteCode} />
          <span className="sr-only">하위 설비 {node.children.length}개</span>
        </summary>
        <ul className="ml-1.5 border-l border-rule pl-3">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} siteCode={siteCode} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** 사이트 설비 트리 (system → asset → component) */
export function AssetTree({ nodes, siteCode }: Readonly<{ nodes: readonly TreeNode[]; siteCode: string }>) {
  return (
    <ul className="flex flex-col text-sm">
      {nodes.map((node) => (
        <TreeItem key={node.id} node={node} siteCode={siteCode} />
      ))}
    </ul>
  );
}
