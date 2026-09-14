// 사이트 설비 목록(부모 id) → 트리. 순수 모듈 (서버·클라이언트 공용).

export interface FlatAsset {
  readonly id: number;
  readonly parentId: number | null;
  readonly code: string;
}

export type AssetNode<T extends FlatAsset> = T & { readonly children: readonly AssetNode<T>[] };

/**
 * 부모가 목록에 없으면 루트로 둔다 (압축기·검지기처럼 사이트 바로 아래 설비).
 * 형제는 code 순으로 정렬한다. 잘못된 순환 참조가 있어도 각 설비는 한 번만 넣는다.
 */
export function buildAssetTree<T extends FlatAsset>(assets: readonly T[]): AssetNode<T>[] {
  const ids = new Set(assets.map((asset) => asset.id));
  const childrenOf = new Map<number | null, T[]>();
  for (const asset of [...assets].sort((a, b) => a.code.localeCompare(b.code))) {
    const key = asset.parentId !== null && ids.has(asset.parentId) && asset.parentId !== asset.id ? asset.parentId : null;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), asset]);
  }

  const visited = new Set<number>();
  const build = (asset: T): AssetNode<T> => {
    visited.add(asset.id);
    const children = (childrenOf.get(asset.id) ?? []).filter((child) => !visited.has(child.id)).map(build);
    return { ...asset, children };
  };
  return (childrenOf.get(null) ?? []).map(build);
}

/** 트리를 깊이 우선으로 펼친 설비 수 */
export function countNodes<T extends FlatAsset>(nodes: readonly AssetNode<T>[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}
