import { CircleQuestionMark } from 'lucide-react';
import Link from 'next/link';

/** 용어 옆 물음표: 용어집(/help)의 해당 항목으로 간다 */
export function TermLink({ termId, term }: Readonly<{ termId: string; term: string }>) {
  return (
    <Link href={`/help#${termId}`} aria-label={`${term} 뜻 보기`} title={`${term} 뜻 보기`} className="inline-flex align-middle text-muted hover:text-accent">
      <CircleQuestionMark aria-hidden="true" className="size-3.5" />
    </Link>
  );
}
