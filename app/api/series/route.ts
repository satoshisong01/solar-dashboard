import type { NextRequest } from 'next/server';
import { requireAdminApi } from '@/lib/auth/api';
import { getSeries } from '@/lib/data/series';
import { parseSeriesQuery } from '@/lib/data/series-query';

export const runtime = 'nodejs';

/**
 * GET /api/series?pointIds=1,2&from=ISO&to=ISO&maxPoints=600
 * 응답: { source: 'raw' | '1h', bucketSeconds, fromMs, toMs, series: [{ pointId, rows: [[tsMs, min, avg, max], ...] }] }
 */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const parsed = parseSeriesQuery(request.nextUrl.searchParams);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_query', message: parsed.error }, { status: 400 });
  }

  try {
    const payload = await getSeries(parsed.data);
    return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/series] 조회 실패:', error instanceof Error ? error.message : error);
    return Response.json({ error: 'internal_error', message: '시계열을 조회하지 못했습니다' }, { status: 500 });
  }
}
