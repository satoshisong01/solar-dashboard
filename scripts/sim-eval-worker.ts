// npm run sim:eval의 자식 프로세스: 사이트 잡을 받아 준비(시뮬레이션·추출)와 평가를 하고 결과를 부모에 보낸다.
// --cache 디렉터리를 주면 준비 결과를 추출기 설정 해시와 함께 저장해 두고, 탐지기 파라미터만 바꿔 다시 평가할 때 재사용한다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashInput } from '../lib/analytics/hash';
import { DEFAULT_ESS_EXTRACTOR_PARAMS } from '../lib/analytics/episodes/ess';
import { DEFAULT_PV_DAY_PARAMS } from '../lib/analytics/episodes/pv';
import { DEFAULT_STACK_EXTRACTOR_PARAMS } from '../lib/analytics/episodes/stack-episodes';
import { EXTRACTOR_VERSIONS } from '../lib/analytics/episodes/types';
import type { WorkerRequest, WorkerResponse } from '../lib/sim/eval/pool';
import { evaluatePreparedJob, PREPARED_JOB_FORMAT, prepareSiteJob, type PreparedJob } from '../lib/sim/eval/replay';

/** 추출기 설정·버전·잡이 같으면 같은 준비 결과 */
const cacheKey = (request: WorkerRequest): string =>
  hashInput({ format: PREPARED_JOB_FORMAT, job: request.job, extractor: EXTRACTOR_VERSIONS, ess: DEFAULT_ESS_EXTRACTOR_PARAMS, pv: DEFAULT_PV_DAY_PARAMS, stack: DEFAULT_STACK_EXTRACTOR_PARAMS }).slice(0, 12);

function loadOrPrepare(request: WorkerRequest): { prepared: PreparedJob; cached: boolean } {
  if (request.cacheDir === null) return { prepared: prepareSiteJob(request.job), cached: false };
  const file = join(request.cacheDir, `${request.job.id}-${cacheKey(request)}.json`);
  if (existsSync(file)) return { prepared: JSON.parse(readFileSync(file, 'utf8')) as PreparedJob, cached: true };
  const prepared = prepareSiteJob(request.job);
  mkdirSync(request.cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(prepared));
  return { prepared, cached: false };
}

process.on('message', (request: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const { prepared, cached } = loadOrPrepare(request);
    response = { kind: 'result', jobId: request.job.id, result: evaluatePreparedJob(prepared), cached };
  } catch (error) {
    response = { kind: 'error', jobId: request.job.id, message: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  process.send?.(response);
});
