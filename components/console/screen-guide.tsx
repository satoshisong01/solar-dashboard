'use client';

import { Info, X } from 'lucide-react';
import { useState } from 'react';

/** 화면 상단 한 줄 안내. 끄고 켤 수 있고 설정에 저장하지 않는다 (화면을 다시 열면 다시 보인다) */
export function ScreenGuide({ text }: Readonly<{ text: string }>) {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center self-start text-xs text-muted underline max-lg:min-h-11 hover:text-ink-2">
        이 화면 안내 보기
      </button>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-hydrogen-fill/40 px-3 py-2">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 text-sm text-pretty text-ink-2">{text}</p>
      <button type="button" onClick={() => setOpen(false)} aria-label="이 화면 안내 숨기기" className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-muted max-lg:size-11 hover:bg-sunken hover:text-ink-2">
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
