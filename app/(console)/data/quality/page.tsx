import type { Metadata } from 'next';
import { PageHeader } from '@/components/console/page-header';
import { DATA_TABS, SectionTabs } from '@/components/console/section-tabs';
import { PointQualityTable, StuckPointTable } from '@/components/data/quality-tables';
import { Panel } from '@/components/ui/panel';
import { requireAdmin } from '@/lib/auth/dal';
import { getPointQuality, getStuckPoints, type QualityScope } from '@/lib/data/data-quality';
import { firstParam, type SearchParamValue } from '@/lib/data/range';
import { DAY_MS, requestTimeMs } from '@/lib/data/time';
import { formatKstDateTime } from '@/lib/format';
import { buttonClass, CHECK_CLASS } from '@/components/ui/form-styles';

export const metadata: Metadata = { title: '데이터 품질' };

const ROW_LIMIT = 200;
/** 수집 API는 5분 넘게 미래인 샘플을 거부한다 */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const STUCK_MINUTE_OPTIONS = [30, 60, 180, 360] as const;
const DEFAULT_STUCK_MINUTES = 60;

const SELECT_CLASS = 'rounded-md border border-rule-strong bg-field px-2 py-1.5 text-sm text-ink';

type QualityPageProps = Readonly<{ searchParams: Promise<Record<string, SearchParamValue>> }>;

function readFilters(query: Readonly<Record<string, SearchParamValue>>) {
  const scope: QualityScope = firstParam(query.scope) === 'any' ? 'any' : 'invalid';
  const minutesParam = Number(firstParam(query.stuck));
  const stuckMinutes = STUCK_MINUTE_OPTIONS.find((option) => option === minutesParam) ?? DEFAULT_STUCK_MINUTES;
  const includeZero = firstParam(query.zero) === '1';
  return { scope, stuckMinutes, includeZero };
}

export default async function DataQualityPage({ searchParams }: QualityPageProps) {
  await requireAdmin();
  const filters = readFilters(await searchParams);
  const nowMs = requestTimeMs();
  const fromMs = nowMs - DAY_MS;
  const toMs = nowMs + FUTURE_TOLERANCE_MS;
  const [quality, stuck] = await Promise.all([
    getPointQuality(fromMs, toMs, filters.scope, ROW_LIMIT),
    getStuckPoints({ fromMs, toMs, minMinutes: filters.stuckMinutes, includeZero: filters.includeZero, limit: ROW_LIMIT }),
  ]);
  const windowText = `최근 24시간 ${formatKstDateTime(fromMs)} ~ ${formatKstDateTime(nowMs)}`;

  return (
    <>
      <PageHeader title="데이터" purpose="수집 상태·데이터 품질 관리, 데이터 계약 협의 지원" />
      <SectionTabs label="데이터 하위 화면" tabs={DATA_TABS} current="/data/quality" />

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-rule bg-surface p-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          품질 비트 표
          <select name="scope" defaultValue={filters.scope} className={SELECT_CLASS}>
            <option value="invalid">유효성 비트가 있는 포인트</option>
            <option value="any">비트가 하나라도 있는 포인트 (지연 도착·재처리 포함)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          고착 의심 기준
          <select name="stuck" defaultValue={filters.stuckMinutes} className={SELECT_CLASS}>
            {STUCK_MINUTE_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                값 변화 없음 {minutes >= 60 ? `${minutes / 60}시간` : `${minutes}분`} 이상
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-2">
          <input type="checkbox" name="zero" value="1" defaultChecked={filters.includeZero} className={CHECK_CLASS} />
          값 0 포함
        </label>
        <button type="submit" className={buttonClass('secondary')}>
          적용
        </button>
      </form>

      <Panel title="포인트별 품질 비트 비율" meta={`${windowText} · ${quality.total}개${quality.total > quality.rows.length ? ` 중 ${quality.rows.length}개` : ''} · 품질 이상 비율 높은 순`}>
        <PointQualityTable rows={quality.rows} />
        <p className="text-xs text-muted">품질 이상은 장치 불량·범위 밖·급변·고착·시계 의심 비트입니다. 지연 도착·재처리는 값의 출처 표시라 이상 비율에 넣지 않습니다.</p>
      </Panel>

      <Panel title="고착 의심" meta={`${windowText} · gauge 메트릭 · ${stuck.length}개${stuck.length >= ROW_LIMIT ? ` (상위 ${ROW_LIMIT}개)` : ''} · 오래 그대로인 순`}>
        <StuckPointTable rows={stuck} />
        <p className="text-xs text-muted">
          구간의 마지막 값이 바뀌지 않고 이어진 길이입니다. {filters.includeZero ? '' : '야간 정지처럼 값이 0인 포인트는 뺐습니다. '}
          설정값(출력 제한 등)은 원래 바뀌지 않을 수 있으니 메트릭 고착 기준과 함께 보세요.
        </p>
      </Panel>
    </>
  );
}
