'use client';

import { Info, LoaderCircle, Play } from 'lucide-react';
import { startTransition, useActionState, useEffect, useState, type FormEvent } from 'react';
import { runAnalysisAction, type RunResultData } from '@/app/(console)/desk/actions';
import { RunStatusPanel, useRunWatch } from '@/components/desk/run-status';
import { ActionMessage, buttonClass, CONTROL_CLASS, fieldError } from '@/components/forms/controls';
import type { RunFormOptions, RunStatusView } from '@/lib/data/analysis-runs';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';
import { ANALYSIS_PERIOD_DAYS } from '@/lib/forms/limits';

const PERIOD_OPTIONS = [...ANALYSIS_PERIOD_DAYS.map((days) => ({ value: String(days), label: `최근 ${days}일` })), { value: 'custom', label: '사용자 지정' }];

type RunPanelProps = Readonly<{ options: RunFormOptions; activeRun: RunStatusView | null }>;

/**
 * 분석 실행 폼: 사이트(여러 개)·설비(선택)·기간.
 * 실행 버튼은 실행 행만 만들고 곧바로 돌아온다 (계산은 서버가 응답 뒤에 잇는다).
 * 그 뒤의 진행 상황·결과 요약·'이어서 실행'은 아래 RunStatusPanel이 맡는다.
 */
export function RunPanel({ options, activeRun }: RunPanelProps) {
  const [state, action, pending] = useActionState<ActionState<RunResultData>, FormData>(runAnalysisAction, IDLE_STATE);
  const watch = useRunWatch(activeRun);
  const [siteIds, setSiteIds] = useState<readonly number[]>(options.sites.map((site) => site.id));
  const [period, setPeriod] = useState('30');
  const assets = options.assets.filter((asset) => siteIds.includes(asset.siteId));
  const toggleSite = (id: number, checked: boolean) => setSiteIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)));
  // action 속성 대신 직접 제출: React가 제출 뒤 폼을 초기화하면 선택(사이트·기간)이 화면 상태와 어긋나므로 초기화하지 않는다
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  };

  const startedRunId = state.status === 'success' ? state.data.runId : null;
  const startWatch = watch.watch;
  useEffect(() => {
    if (startedRunId !== null) startWatch(startedRunId);
  }, [startedRunId, startWatch]);

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-busy={pending}>
        <p className="flex items-start gap-2 rounded-md border border-rule bg-sunken px-3 py-2 text-sm text-ink-2">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          분석은 발견사항만 저장하고 리포트나 파일을 만들지 않습니다. 리포트가 필요하면 코칭 리포트 화면에서 &lsquo;리포트 만들기&rsquo;를 누르세요.
        </p>
        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <legend className="text-xs font-medium text-ink-2">사이트</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {options.sites.map((site) => (
              <label key={site.id} className="inline-flex items-center gap-1.5 text-sm text-ink">
                <input type="checkbox" name="siteId" value={site.id} checked={siteIds.includes(site.id)} onChange={(event) => toggleSite(site.id, event.target.checked)} className="accent-accent" />
                <span className="font-medium">{site.code}</span>
                <span className="text-xs text-muted">{site.name}</span>
              </label>
            ))}
          </div>
          {fieldError(state, 'siteIds') && <p className="text-xs text-crit">{fieldError(state, 'siteIds')}</p>}
        </fieldset>

        <details className="rounded-md border border-rule px-3 py-2">
          <summary className="cursor-pointer text-sm text-ink-2">설비 고르기 (선택 · 비워 두면 고른 사이트의 모든 설비와 데이터 품질)</summary>
          <fieldset className="mt-2 grid gap-1.5 sm:grid-cols-2" disabled={pending}>
            <legend className="sr-only">설비</legend>
            {assets.length === 0 ? (
              <p className="text-sm text-muted">사이트를 먼저 고르세요.</p>
            ) : (
              assets.map((asset) => (
                <label key={asset.id} className="inline-flex items-center gap-1.5 text-sm text-ink">
                  <input type="checkbox" name="assetId" value={asset.id} className="accent-accent" />
                  <span className="font-mono text-xs">{options.sites.find((s) => s.id === asset.siteId)?.code}/{asset.code}</span>
                  <span className="text-xs text-muted">{asset.name}</span>
                </label>
              ))
            )}
          </fieldset>
          {fieldError(state, 'assetIds') && <p className="text-xs text-crit">{fieldError(state, 'assetIds')}</p>}
        </details>

        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <legend className="text-xs font-medium text-ink-2">기간</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PERIOD_OPTIONS.map((option) => (
              <label key={option.value} className="inline-flex items-center gap-1.5 text-sm text-ink">
                <input type="radio" name="period" value={option.value} checked={period === option.value} onChange={() => setPeriod(option.value)} className="accent-accent" />
                {option.label}
              </label>
            ))}
          </div>
          {period === 'custom' && (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-xs text-ink-2">
                시작 (KST)
                <input type="datetime-local" name="from" required className={CONTROL_CLASS} aria-invalid={Boolean(fieldError(state, 'from'))} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-2">
                끝 (KST, 지금보다 늦으면 지금까지)
                <input type="datetime-local" name="to" required className={CONTROL_CLASS} aria-invalid={Boolean(fieldError(state, 'to'))} />
              </label>
            </div>
          )}
          {[fieldError(state, 'period'), fieldError(state, 'from'), fieldError(state, 'to')].filter(Boolean).map((message) => (
            <p key={message} className="text-xs text-crit">
              {message}
            </p>
          ))}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending || watch.running || siteIds.length === 0} className={buttonClass('primary')}>
            {pending ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Play aria-hidden="true" className="size-4" />}
            {pending ? '시작하는 중…' : '분석 실행'}
          </button>
          {watch.running && <p className="text-sm text-ink-2">진행 중인 분석이 끝나야 다시 실행할 수 있습니다.</p>}
        </div>
        <ActionMessage state={state} />
      </form>
      <RunStatusPanel {...watch} />
    </div>
  );
}
