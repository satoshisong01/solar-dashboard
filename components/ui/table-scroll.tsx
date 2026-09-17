'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

type TableScrollProps = Readonly<{
  children: ReactNode;
  label: string;
  /**
   * lg 미만에서 첫 열(사이트 코드·태그 이름 같은 식별 열)을 얼린다.
   * 열이 많아 몇 화면씩 밀어야 하는 표에만 쓴다 — 무엇에 대한 행인지 잃지 않게.
   */
  stickyFirst?: boolean;
}>;

/**
 * 표가 좁은 화면에서 페이지 대신 자기 안에서 가로 스크롤되게 한다.
 * relative: 표 안 sr-only(absolute) 요소가 페이지 폭을 넓히지 않게.
 * 실제로 넘칠 때만 오른쪽 끝 그림자와 안내 문구를 붙인다 — 밀 수 있다는 것이 보이지 않으면 휴대폰에서 나머지 열을 못 찾는다.
 */
export function TableScroll({ children, label, stickyFirst = false }: TableScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const max = node.scrollWidth - node.clientWidth;
      setOverflow(max > 1);
      setAtEnd(max <= 1 || node.scrollLeft >= max - 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const table = node.firstElementChild;
    if (table) observer.observe(table);
    node.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', measure);
    };
  }, []);

  return (
    <div className="relative">
      <div
        ref={ref}
        role="region"
        aria-label={label}
        tabIndex={0}
        className={`relative -mx-4 overflow-x-auto px-4 md:-mx-5 md:px-5 ${stickyFirst ? 'sticky-first-col' : ''}`}
      >
        {children}
      </div>
      {overflow && !atEnd && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -right-4 w-10 bg-linear-to-l from-surface to-transparent md:-right-5 lg:hidden" />
      )}
      {overflow && <p className="mt-1 text-xs text-muted lg:hidden">표를 옆으로 밀면 나머지 열이 나옵니다</p>}
    </div>
  );
}
