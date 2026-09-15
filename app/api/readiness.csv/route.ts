import type { NextRequest } from 'next/server';
import { acquisitionCsvRows, readinessCsvRows, toCsvText } from '@/lib/analytics/readiness';
import { requireAdminApi } from '@/lib/auth/api';
import { csvDownloadHeaders } from '@/lib/csv/download';
import { getSiteReadiness } from '@/lib/data/readiness';
import { getSiteByCode } from '@/lib/data/sites';
import { requestTimeMs } from '@/lib/data/time';
import { formatKstDate } from '@/lib/format';

export const runtime = 'nodejs';

const SITE_CODE_MAX = 64;

/**
 * GET /api/readiness.csv?site=SIM-B[&table=acquisition]
 * 기본은 준비도 매트릭스 셀 CSV, table=acquisition이면 메트릭 확보 순위 CSV. UTF-8 BOM·CRLF (lib/analytics/readiness/csv.ts)
 */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireAdminApi();
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const siteCode = params.get('site') ?? '';
  const table = params.get('table') ?? 'matrix';
  if (siteCode.trim() === '' || siteCode.length > SITE_CODE_MAX || (table !== 'matrix' && table !== 'acquisition')) {
    return Response.json({ error: 'invalid_query', message: 'site(사이트 코드)와 table(matrix | acquisition)을 확인하세요' }, { status: 400 });
  }

  try {
    const site = await getSiteByCode(siteCode);
    if (!site) return Response.json({ error: 'not_found', message: '사이트를 찾을 수 없습니다' }, { status: 404 });
    const nowMs = requestTimeMs();
    const view = await getSiteReadiness(site, nowMs);
    const rows = table === 'acquisition' ? acquisitionCsvRows(view.ranking) : readinessCsvRows(view.rows.flatMap((r) => r.cells));
    const filename = `${table === 'acquisition' ? '메트릭확보순위' : '탐지준비도'}_${site.code}_${formatKstDate(nowMs)}.csv`;
    return new Response(toCsvText(rows), { headers: csvDownloadHeaders(filename) });
  } catch (error) {
    console.error('[api/readiness.csv] 조회 실패:', error instanceof Error ? error.message : error);
    return Response.json({ error: 'internal_error', message: '준비도를 계산하지 못했습니다' }, { status: 500 });
  }
}
