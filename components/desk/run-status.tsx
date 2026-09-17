'use client';

import { LoaderCircle, Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useCallback, useEffect, useState } from 'react';
import { resumeAnalysisAction, type RunResultData } from '@/app/(console)/desk/actions';
import { buttonClass } from '@/components/ui/form-styles';
import type { RunStatusView } from '@/lib/data/analysis-runs';
import { detectorLabel } from '@/lib/desk/labels';
import { formatElapsedMs, runStatusLabel, type RunSummary } from '@/lib/desk/run-summary';
import { IDLE_STATE, type ActionState } from '@/lib/forms/action-state';

/** 실행이 도는 동안에만 이 간격으로 상태를 묻고, 끝나면 멈춘다 (서버 부하를 줄이려고 폴링을 실행 중으로 한정) */
const POLL_MS = 3_000;
const TICK_MS = 1_000;

const STATUS_TONE: Readonly<Record<string, string>> = { succeeded: 'text-ok', partial: 'text-warn', failed: 'text-crit' };

async function fetchRun(runId: string): Promise<RunStatusView | null> {
  const response = await fetch(`/api/desk/run-status?runId=${runId}`, { cache: 'no-store' });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const run = (body as Readonly<{ run?: RunStatusView | null }>).run ?? null;
  return run !== null && typeof run.id === 'string' ? run : null;
}

export interface RunWatch {
  /** 지켜보는 실행. 막 시작해 아직 한 번도 읽지 못했으면 null */
  readonly run: RunStatusView | null;
  readonly running: boolean;
  readonly watch: (runId: string) => void;
}

/**
 * 분석 실행 하나를 지켜본다. 실행 중이면 몇 초 간격으로 상태를 읽고, 끝나면 폴링을 멈추고 화면을 새로 고친다
 * (발견사항 인박스·실행 이력은 서버가 그리므로 router.refresh가 필요하다).
 */
export function useRunWatch(initial: RunStatusView | null): RunWatch {
  const router = useRouter();
  const [run, setRun] = useState<RunStatusView | null>(initial);
  const [runId, setRunId] = useState<string | null>(initial !== null && initial.status === 'running' ? initial.id : null);

  useEffect(() => {
    if (runId === null) return;
    let stopped = false;
    const poll = async () => {
      const next = await fetchRun(runId).catch(() => null);
      if (stopped || next === null) return;
      setRun(next);
      if (next.status !== 'running') {
        setRunId(null);
        router.refresh();
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, router]);

  const watch = useCallback((id: string) => {
    setRun(null);
    setRunId(id);
  }, []);

  return { run, running: runId !== null, watch };
}

/** 실행 중 경과 시간 [ms]. 실행 중이 아니면 0 */
function useElapsedMs(running: boolean, startedMs: number | null): number {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return running && startedMs !== null && now !== null ? Math.max(0, now - startedMs) : 0;
}

function RunResult({ summary }: Readonly<{ summary: RunSummary }>) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-ink sm:grid-cols-4">
      <div>
        <dt className="text-xs text-ink-2">새 발견사항</dt>
        <dd className="font-mono tabular-nums">{summary.created}건{summary.recurrences > 0 ? ` (재발 ${summary.recurrences})` : ''}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-2">갱신</dt>
        <dd className="font-mono tabular-nums">{summary.updated}건{summary.worsened > 0 ? ` (악화 ${summary.worsened})` : ''}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-2">판정 불가 탐지기</dt>
        <dd className="font-mono tabular-nums">{summary.insufficient}건</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-2">소요 시간</dt>
        <dd className="font-mono tabular-nums">{formatElapsedMs(summary.elapsedMs)}</dd>
      </div>
      {summary.insufficientDetectors.length > 0 && <div className="col-span-full text-xs text-ink-2">표본 부족: {summary.insufficientDetectors.map(detectorLabel).join(', ')}</div>}
      <div className="col-span-full">
        <a href="#inbox" className="text-sm font-medium underline">
          인박스에서 결과 보기
        </a>
      </div>
    </dl>
  );
}

const BOX_CLASS = 'flex flex-col gap-2 rounded-md border border-rule bg-sunken px-3 py-2';

function RunningLine({ run, elapsedMs }: Readonly<{ run: RunStatusView | null; elapsedMs: number }>) {
  const parts = [run === null ? null : run.siteCodes.join(', '), run?.progressText ?? '준비 중', `${formatElapsedMs(elapsedMs)} 경과`].filter((part): part is string => part !== null);
  return (
    <p role="status" className={`${BOX_CLASS} flex-row flex-wrap items-center gap-x-2 text-sm text-ink-2`}>
      <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
      <span className="font-medium text-ink">분석 실행{run === null ? '' : ` #${run.id}`} 진행 중</span>
      <span>{parts.join(' · ')}</span>
      <span className="text-xs text-muted">다른 화면으로 옮겨도 계속 진행됩니다.</span>
    </p>
  );
}

type FinishedProps = Readonly<{ run: RunStatusView; state: ActionState<RunResultData>; resume: (formData: FormData) => void; pending: boolean }>;

function FinishedLine({ run, state, resume, pending }: FinishedProps) {
  return (
    <div role="status" className={BOX_CLASS}>
      <p className="text-sm text-ink-2">
        <span className={`font-medium ${STATUS_TONE[run.status] ?? 'text-ink'}`}>
          분석 실행 #{run.id} {runStatusLabel(run.status)}
        </span>
        {` · ${run.siteCodes.join(', ')}`}
        {run.finishedMs !== null && ` · ${formatElapsedMs(run.finishedMs - run.startedMs)}`}
        {run.error !== null && <span className="block text-crit">{run.error}</span>}
      </p>
      {run.status !== 'failed' && <RunResult summary={run.summary} />}
      {run.resumeSiteCodes.length > 0 && (
        <form action={resume} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="runId" value={run.id} />
          <button type="submit" disabled={pending} className={buttonClass('secondary')}>
            {pending ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Play aria-hidden="true" className="size-4" />}
            이어서 실행
          </button>
          <span className="text-xs text-ink-2">시간 예산 안에 끝내지 못한 사이트: {run.resumeSiteCodes.join(', ')}</span>
        </form>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-xs text-crit">
          {state.message}
        </p>
      )}
    </div>
  );
}

/** 분석 실행의 진행 상황과 끝난 뒤의 결과 요약. 시간 예산을 넘겨 남은 사이트가 있으면 '이어서 실행'을 보여 준다 */
export function RunStatusPanel({ run, running, watch }: RunWatch) {
  const [state, resume, pending] = useActionState(resumeAnalysisAction, IDLE_STATE);
  const elapsedMs = useElapsedMs(running, run?.startedMs ?? null);

  useEffect(() => {
    if (state.status === 'success') watch(state.data.runId);
  }, [state, watch]);

  if (running) return <RunningLine run={run} elapsedMs={elapsedMs} />;
  return run === null ? null : <FinishedLine run={run} state={state} resume={resume} pending={pending} />;
}
