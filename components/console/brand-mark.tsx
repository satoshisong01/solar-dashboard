/** 태양광(앰버)과 수소(틸)가 겹치는 장식용 심볼. 이름은 호출부에서 텍스트로 쓴다. */
export function BrandMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
      <circle cx="12" cy="16" r="9" strokeWidth="2" className="fill-solar-fill stroke-solar-edge" />
      <circle cx="20" cy="16" r="9" strokeWidth="2" fillOpacity="0.8" className="fill-hydrogen-fill stroke-hydrogen-edge" />
    </svg>
  );
}
