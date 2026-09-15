import { ShieldAlert } from 'lucide-react';
import { SAFETY_FINDING_NOTICE } from '@/lib/desk/safety';

/** 안전 발견사항 워크스페이스 고정 배너: 분석 결과이므로 현장 판단·가스 검지기 확인이 먼저다 (닫기 없음) */
export function SafetyFindingBanner() {
  return (
    <section aria-labelledby="safety-finding-title" className="flex flex-col gap-2 rounded-lg border-2 border-crit bg-crit-fill p-4 md:p-5">
      <h2 id="safety-finding-title" className="flex items-center gap-2 text-base font-semibold text-crit">
        <ShieldAlert aria-hidden="true" className="size-5 shrink-0" />
        안전 발견사항 — 현장 안전책임자 판단·가스 검지기 확인이 우선입니다
      </h2>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
        <li>가스 검지기 경보·기록과 현장 누설 점검(휴대용 검지기·발포액)을 먼저 확인하세요.</li>
        <li>운전 정지·격리 여부는 현장 안전책임자가 제조사 절차와 현장 안전설비에 따라 판단합니다. 이 화면의 수치는 분석 추정값입니다.</li>
      </ul>
      <p className="text-sm font-medium text-crit">{SAFETY_FINDING_NOTICE}</p>
    </section>
  );
}
