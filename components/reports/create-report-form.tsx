'use client';

import { FilePlus2, Info, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { startTransition, useActionState, type FormEvent } from 'react';
import { createReportAction } from '@/app/(console)/reports/actions';
import { FindingSeverityChip, FindingStatusBadge } from '@/components/desk/finding-badges';
import { ActionMessage, buttonClass, fieldError } from '@/components/forms/controls';
import { TABLE_CLASS, TD_CLASS, TH_CLASS, TableScroll } from '@/components/ui/panel';
import type { ReportCandidate } from '@/lib/data/reports';
import { detectorLabel } from '@/lib/desk/labels';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { formatKstDate } from '@/lib/format';
import { CHECK_CLASS } from '@/components/ui/form-styles';

type Props = Readonly<{
  siteId: number;
  siteCode: string;
  periodLabel: string;
  /** 기간 선택 값 그대로 (kind·month·year·quarter·from·to) */
  scope: Readonly<Record<string, string>>;
  candidates: readonly ReportCandidate[];
}>;

/** 2단계: 포함할 발견사항을 고르고 리포트 초안을 만든다. 분석은 실행하지 않는다 */
export function CreateReportForm({ siteId, siteCode, periodLabel, scope, candidates }: Props) {
  const [state, action, pending] = useActionState<ActionState<null>, FormData>(createReportAction, IDLE_STATE);
  // action 속성 대신 직접 제출: 오류가 나도 체크 선택이 초기화되지 않게 한다
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-busy={pending}>
      <input type="hidden" name="siteId" value={siteId} />
      {Object.entries(scope).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="flex items-start gap-2 rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink-2">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {siteCode} · {periodLabel}. 리포트 만들기는 분석을 실행하지 않고, 이미 저장된 발견사항·일 KPI·조치 효과 검증으로 초안을 만듭니다. 최신 결과가 필요하면 분석 데스크에서 먼저 분석을 실행하세요.
      </p>
      {candidates.length === 0 ? (
        <p className="rounded-md border border-dashed border-rule-strong px-4 py-4 text-sm text-muted">
          이 기간에 해당하는 발견사항이 없습니다. 발견사항 없이 KPI·데이터 품질·검증된 조치로만 리포트를 만들 수 있습니다. <Link href="/desk" className="underline">분석 데스크</Link>
        </p>
      ) : (
        <TableScroll label="포함할 발견사항 표">
          <table className={TABLE_CLASS}>
            <caption className="pb-2 text-left text-xs text-muted">기본 선택: 열린 발견사항 중 심각도 2 이상 + 효과 확인된 발견사항</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>포함</th>
                <th scope="col" className={TH_CLASS}>발견사항</th>
                <th scope="col" className={TH_CLASS}>심각도</th>
                <th scope="col" className={TH_CLASS}>상태</th>
                <th scope="col" className={TH_CLASS}>최근 탐지</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id}>
                  <td className={TD_CLASS}>
                    <input type="checkbox" name="findingId" value={c.id} defaultChecked={c.defaultSelected} aria-label={`발견사항 #${c.id} 포함`} className={CHECK_CLASS} />
                  </td>
                  <td className={TD_CLASS}>
                    <span className="block font-medium text-ink">
                      #{c.id} {c.title}
                    </span>
                    <span className="block font-mono text-xs text-muted">
                      {c.assetPath ?? siteCode} · {detectorLabel(c.detectorId)} · 신뢰도 {Math.round(c.confidence * 100)}%
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <FindingSeverityChip severity={c.severity} />
                  </td>
                  <td className={TD_CLASS}>
                    <FindingStatusBadge status={c.status} />
                  </td>
                  <td className={`${TD_CLASS} font-mono text-xs whitespace-nowrap`}>{formatKstDate(c.lastDetectedMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {fieldError(state, 'findingId') && <p className="text-xs text-crit">{fieldError(state, 'findingId')}</p>}
      <label className="inline-flex items-center gap-2 text-sm text-ink max-lg:min-h-11">
        <input type="checkbox" name="includeVerifiedActions" defaultChecked className={CHECK_CLASS} />
        기간 안에 계산된 조치 효과 검증 결과 포함
      </label>
      <div>
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <FilePlus2 aria-hidden="true" className="size-4" />}
          {pending ? '초안 만드는 중…' : '리포트 만들기'}
        </button>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}
