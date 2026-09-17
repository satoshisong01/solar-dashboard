// 종합 요약 틀 문장 (순수). 숫자는 모두 DigestStats가 센 값이고, 여기서 새로 계산하지 않는다.
// AI가 이 문장을 다시 쓰더라도 담긴 사실은 그대로여야 한다 (lib/llm/digest.ts가 검증한다).
import type { DigestCount, DigestStats, DigestSummary, DigestUrgency } from './types';

/** 문장에 이름을 대는 계통 수 (나머지는 '그 밖 N건'으로 묶는다) */
const NAMED_DOMAINS = 3;

const countOf = (stats: DigestStats, key: DigestUrgency): number => stats.byUrgency.find((row) => row.key === key)?.count ?? 0;

const listText = (counts: readonly DigestCount[]): string => counts.map((row) => `${row.label} ${row.count}건`).join(', ');

function headlineText(stats: DigestStats): string {
  const where = stats.siteLabel === null ? '' : `${stats.siteLabel} 발전소에서 `;
  // 읽어 온 목록이 잘렸으면 '모두'라고 말하지 않는다 — 아래 네 줄이 모두 이 창 안에서 센 값이다
  const scope = stats.truncatedAt === null ? '지금 열려 있는 발견사항은 모두' : `최근 탐지 ${stats.truncatedAt}건 안에서 열려 있는 발견사항은`;
  const first = `${where}${scope} ${stats.total}건입니다.`;
  // 전부 새 건이면 건수를 두 번 쓰지 않는다 ('15건 중 15건'으로 읽히지 않게)
  if (stats.newCount === stats.total && stats.reopenedCount === 0) return `${first} 아직 하나도 분류하지 않았습니다.`;
  const parts = [
    stats.newCount > 0 ? `${stats.newCount}건은 아직 분류하지 않은 새 건` : null,
    stats.reopenedCount > 0 ? `${stats.reopenedCount}건은 조치 뒤 다시 열린 건` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? first : `${first} 그중 ${parts.join('이고, ')}입니다.`;
}

function breakdownText(stats: DigestStats): string | null {
  const [first, ...rest] = stats.byDomain;
  if (first === undefined) return null;
  if (rest.length === 0) return `${stats.total}건 모두 ${first.label} 쪽입니다.`;
  const named = stats.byDomain.slice(0, NAMED_DOMAINS);
  const others = stats.byDomain.slice(NAMED_DOMAINS).reduce((sum, row) => sum + row.count, 0);
  return `계통별로 보면 ${listText(named)}${others > 0 ? `, 그 밖 ${others}건` : ''}입니다.`;
}

function urgencyText(stats: DigestStats): string | null {
  const shown = stats.byUrgency.filter((row) => row.count > 0);
  if (shown.length === 0) return null;
  const first = `급한 정도로 나누면 ${listText(shown)}입니다.`;
  // '가장 급한'이 아니라 '가장 먼저 볼': 목록 맨 위에 오는 순서는 심각도×신뢰도라 심각도만으로 정해지지 않는다
  const worst = stats.top[0];
  return worst === undefined ? first : `${first} 그중 가장 먼저 볼 건은 ${worst.subject}에서 잡혔습니다.`;
}

function nextStepText(stats: DigestStats): string | null {
  const now = countOf(stats, 'now');
  const week = countOf(stats, 'week');
  const watch = countOf(stats, 'watch');
  if (now + week + watch === 0) return null;
  const first = now > 0 ? `바로 확인 ${now}건은 오늘 안에 근거를 열어 확인하세요.` : '오늘 당장 손대야 할 건은 없습니다.';
  const later =
    week > 0 && watch > 0
      ? `이번 주 확인 ${week}건은 이번 주 안에 보고, 지켜보기 ${watch}건은 다음 분석 실행 결과와 견줘 보면 됩니다.`
      : week > 0
        ? `이번 주 확인 ${week}건은 이번 주 안에 보면 됩니다.`
        : watch > 0
          ? `지켜보기 ${watch}건은 다음 분석 실행 결과와 견줘 보면 됩니다.`
          : null;
  return later === null ? first : `${first} ${later}`;
}

/** 집계 → 틀 문장 4줄. AI를 쓰지 않거나 검증에 걸리면 이 문장이 그대로 화면에 나온다 */
export function digestTemplate(stats: DigestStats): DigestSummary {
  return {
    headline: headlineText(stats),
    breakdown: breakdownText(stats),
    urgency: urgencyText(stats),
    nextStep: nextStepText(stats),
  };
}

/** 숫자로 세지 않고, 틀 문장에 있었으면 그대로 남아야 하는 이름 */
export function digestLabels(stats: DigestStats): readonly string[] {
  const names = [stats.siteLabel, ...stats.byDomain.map((row) => row.label), ...stats.top.map((item) => item.subject)];
  return [...new Set(names.filter((name): name is string => name !== null && name !== ''))];
}
