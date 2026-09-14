// 사이트 잡을 자식 프로세스 N개에 나눠 실행한다 (worker_threads는 tsx 로더가 붙지 않아 child_process.fork를 쓴다).
// 자식은 scripts/sim-eval-worker.ts. 한 자식이 잡을 하나씩 받아 결과를 돌려준다.
import { fork, type ChildProcess } from 'node:child_process';
import type { SiteJob } from './jobs';
import type { SiteJobResult } from './types';

export interface WorkerRequest {
  readonly job: SiteJob;
  readonly cacheDir: string | null;
}

export type WorkerResponse =
  | { readonly kind: 'result'; readonly jobId: string; readonly result: SiteJobResult; readonly cached: boolean }
  | { readonly kind: 'error'; readonly jobId: string; readonly message: string };

export interface PoolOptions {
  readonly workerScript: string;
  readonly concurrency: number;
  readonly cacheDir: string | null;
  readonly onResult?: (response: WorkerResponse, done: number, total: number) => void;
}

function runOnWorker(child: ChildProcess, request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolveResponse, reject) => {
    const onMessage = (message: WorkerResponse) => {
      if (message.jobId !== request.job.id) return;
      cleanup();
      resolveResponse(message);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`평가 워커가 잡 ${request.job.id} 처리 중 종료했습니다 (코드 ${code})`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send(request);
  });
}

/** 잡을 동시에 concurrency개씩 실행해 잡 순서대로 결과를 돌려준다. 잡 오류는 error 응답으로 담는다 */
export async function runJobsInPool(jobs: readonly SiteJob[], options: PoolOptions): Promise<WorkerResponse[]> {
  const queue = [...jobs.keys()];
  const responses = new Map<number, WorkerResponse>();
  const workerCount = Math.max(1, Math.min(options.concurrency, jobs.length));
  const spawn = () => fork(options.workerScript, [], { execArgv: process.execArgv, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const worker = async (): Promise<void> => {
    let child = spawn();
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const job = jobs[next] as SiteJob;
      if (!child.connected) child = spawn(); // 앞 잡에서 자식이 죽었으면 새로 띄운다
      const response = await runOnWorker(child, { job, cacheDir: options.cacheDir }).catch((error: unknown): WorkerResponse => ({ kind: 'error', jobId: job.id, message: error instanceof Error ? error.message : String(error) }));
      responses.set(next, response);
      options.onResult?.(response, responses.size, jobs.length);
    }
    if (child.connected) child.disconnect();
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return jobs.map((_, i) => responses.get(i) as WorkerResponse);
}
