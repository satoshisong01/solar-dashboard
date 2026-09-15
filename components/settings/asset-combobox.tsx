'use client';

import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { CONTROL_CLASS } from '@/components/ui/form-styles';

export interface ComboAsset {
  readonly id: number;
  readonly siteCode: string;
  readonly code: string;
  readonly name: string;
}

type Props = Readonly<{
  name: string;
  label: string;
  assets: readonly ComboAsset[];
  defaultAssetId: number | null;
  error?: string;
  onSelect?: (assetId: number | null) => void;
}>;

const MAX_OPTIONS = 50;
const textOf = (a: ComboAsset): string => `${a.siteCode} · ${a.code} · ${a.name}`;

/** 설비 검색 콤보 (WAI-ARIA combobox + listbox). 고른 설비 id를 hidden 입력으로 제출한다 */
export function AssetCombobox({ name, label, assets, defaultAssetId, error, onSelect }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const initial = assets.find((a) => a.id === defaultAssetId) ?? null;
  const [selected, setSelected] = useState<ComboAsset | null>(initial);
  const [query, setQuery] = useState(initial ? textOf(initial) : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = selected && query === textOf(selected) ? assets : assets.filter((a) => terms.every((t) => textOf(a).toLowerCase().includes(t)));
    return filtered.slice(0, MAX_OPTIONS);
  }, [assets, query, selected]);

  const choose = (asset: ComboAsset) => {
    setSelected(asset);
    setQuery(textOf(asset));
    setOpen(false);
    onSelect?.(asset.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      const asset = matches[active];
      if (asset) choose(asset);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${matches[active].id}` : undefined}
        aria-invalid={Boolean(error)}
        autoComplete="off"
        placeholder="사이트·경로·이름으로 검색"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
          setOpen(true);
          setActive(0);
          onSelect?.(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={CONTROL_CLASS}
      />
      <input type="hidden" name={name} value={selected?.id ?? ''} />
      {open && (
        <ul id={listId} role="listbox" aria-label={`${label} 후보`} className="absolute top-full z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-rule-strong bg-surface py-1 shadow-lg">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">일치하는 설비가 없습니다</li>
          ) : (
            matches.map((asset, i) => (
              <li
                key={asset.id}
                id={`${listId}-${asset.id}`}
                role="option"
                aria-selected={selected?.id === asset.id}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(asset);
                }}
                className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? 'bg-sunken text-ink' : 'text-ink-2'}`}
              >
                <span className="font-mono">{asset.siteCode} · {asset.code}</span> <span className="text-xs text-muted">{asset.name} (#{asset.id})</span>
              </li>
            ))
          )}
        </ul>
      )}
      {error && <p className="text-xs text-crit">{error}</p>}
    </div>
  );
}
