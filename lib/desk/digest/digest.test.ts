import { describe, expect, it } from 'vitest';
import { digestRow as row, DIGEST_ROWS as ROWS } from './test-fixtures';
import { buildDigestStats, digestFingerprint, openFindingsFor } from './stats';
import { digestLabels, digestTemplate } from './template';

describe('openFindingsFor', () => {
  it('닫힌 건(기각·효과 확인)은 빼고 심각도×신뢰도 순으로 세운다', () => {
    expect(openFindingsFor(ROWS, null).map((r) => r.id)).toEqual(['1', '7', '4', '2', '5', '3']);
  });

  it('사이트 필터가 있으면 그 사이트만 센다', () => {
    expect(openFindingsFor(ROWS, 'SIM-B').map((r) => r.id)).toEqual(['7']);
  });
});

describe('buildDigestStats', () => {
  const stats = buildDigestStats(openFindingsFor(ROWS, null), null);

  it('열린 건만 세고 상태별 건수를 나눈다', () => {
    expect(stats.total).toBe(6);
    expect(stats.newCount).toBe(5);
    expect(stats.reopenedCount).toBe(1);
  });

  it('계통별·급함별·사이트별로 묶는다', () => {
    expect(stats.byDomain.map((d) => [d.label, d.count])).toEqual([
      ['배터리', 4],
      ['전해조', 1],
      ['데이터 품질', 1],
    ]);
    expect(stats.byUrgency.map((u) => [u.key, u.count])).toEqual([
      ['now', 3],
      ['week', 1],
      ['watch', 2],
    ]);
    expect(stats.bySite.map((s) => [s.key, s.count])).toEqual([
      ['SIM-A', 5],
      ['SIM-B', 1],
    ]);
  });

  it('상세 목록의 건수 합은 전체 건수와 같다', () => {
    const listed = stats.groups.flatMap((group) => group.urgencies.flatMap((urgency) => urgency.items));
    expect(listed).toHaveLength(stats.total);
    expect(new Set(listed.map((item) => item.id)).size).toBe(stats.total);
  });

  it('사이트 필터를 걸면 그 사이트 이름을 문장 주어로 쓴다', () => {
    expect(buildDigestStats(openFindingsFor(ROWS, 'SIM-B'), 'SIM-B').siteLabel).toBe('새만금');
    expect(stats.siteLabel).toBeNull();
  });
});

describe('digestTemplate', () => {
  const stats = buildDigestStats(openFindingsFor(ROWS, null), null);
  const summary = digestTemplate(stats);

  it('엔진이 센 값만 문장에 나온다', () => {
    expect(summary.headline).toContain('모두 6건');
    expect(summary.breakdown).toBe('계통별로 보면 배터리 4건, 전해조 1건, 데이터 품질 1건입니다.');
    expect(summary.urgency).toContain('바로 확인 3건, 이번 주 확인 1건, 지켜보기 2건');
    expect(summary.nextStep).toContain('바로 확인 3건');
  });

  it('전부 새 건이면 건수를 두 번 쓰지 않는다', () => {
    const allNew = buildDigestStats(openFindingsFor([row({ id: '1' }), row({ id: '2' })], null), null);
    expect(digestTemplate(allNew).headline).toBe('지금 열려 있는 발견사항은 모두 2건입니다. 아직 하나도 분류하지 않았습니다.');
  });

  it('읽어 온 목록이 잘렸으면 "모두 N건"이라고 하지 않고 센 창을 밝힌다', () => {
    const cut = buildDigestStats(openFindingsFor(ROWS, null), null, 500);
    expect(cut.truncatedAt).toBe(500);
    expect(digestTemplate(cut).headline).toContain('최근 탐지 500건 안에서 열려 있는 발견사항은 6건입니다.');
    expect(digestTemplate(cut).headline).not.toContain('모두');
  });

  it('계통이 하나뿐이면 나열하지 않는다', () => {
    const oneDomain = buildDigestStats(openFindingsFor([row({ id: '1' }), row({ id: '2' })], null), null);
    expect(digestTemplate(oneDomain).breakdown).toBe('2건 모두 배터리 쪽입니다.');
  });

  it('검증에 쓸 이름은 사이트·계통·가장 먼저 볼 건의 주어다', () => {
    const labels = digestLabels(stats);
    expect(labels).toContain('배터리');
    expect(labels).toContain('전해조');
    expect(labels).toContain('랙 1(RACK01)');
  });
});

describe('digestFingerprint', () => {
  const open = openFindingsFor(ROWS, null);

  it('같은 묶음이면 순서가 달라도 같은 지문', () => {
    expect(digestFingerprint([...open].reverse(), null)).toBe(digestFingerprint(open, null));
  });

  it('상태·심각도가 바뀌거나 범위가 다르면 다른 지문', () => {
    const changed = open.map((r) => (r.id === '1' ? { ...r, status: 'triaged' as const } : r));
    expect(digestFingerprint(changed, null)).not.toBe(digestFingerprint(open, null));
    expect(digestFingerprint(open, 'SIM-A')).not.toBe(digestFingerprint(open, null));
  });
});
