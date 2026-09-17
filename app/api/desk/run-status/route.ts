import type { NextRequest } from 'next/server';
import { requireAdminApi } from '@/lib/auth/api';
import { getActiveRun, getRunStatus } from '@/lib/data/analysis-runs';

export const runtime = 'nodejs';

const RUN_ID = /^[1-9]\d{0,17}$/;

/**
 * GET /api/desk/run-status?runId=12
 * 분석 데스크의 진행 표시만 쓴다. 실행이 도는 동안에만 몇 초 간격으로 부르고 끝나면 멈춘다 (서버 부하를 줄이려고 폴링을 실행 중으로 한정).
 * runId가 없으면 지금 도는 중인 실행(없으면 null)을 준다.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const runId = request.nextUrl.searchParams.get('runId') ?? '';
  try {
    const run = RUN_ID.test(runId) ? await getRunStatus(runId) : await getActiveRun();
    return Response.json({ run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/desk/run-status] 조회 실패:', error instanceof Error ? error.message : error);
    return Response.json({ error: 'internal_error', message: '분석 실행 상태를 조회하지 못했습니다' }, { status: 500 });
  }
}
