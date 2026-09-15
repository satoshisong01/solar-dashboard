import { describe, expect, it } from 'vitest';
import { safetyBannerTone, safetyFindingsBanner, type SafetyFindingRow } from './safety-banner';

const row = (patch: Partial<SafetyFindingRow> & Pick<SafetyFindingRow, 'id'>): SafetyFindingRow => ({
  siteCode: 'SIM-B',
  assetPath: 'SIM-B/H2BANK1/TANK3',
  detectorId: 'tank.static_leak',
  category: 'safety',
  severity: 4,
  status: 'new',
  title: '저장용기 누설 의심',
  lastDetectedMs: 1_000,
  ...patch,
});

describe('안전 배너 규칙', () => {
  it('열린 안전 발견사항만: 안전 카테고리·심각도 4 이상, 기각·효과 확인은 빼고 조치 완료·리포트 반영은 남긴다', () => {
    const banner = safetyFindingsBanner([
      row({ id: '1' }),
      row({ id: '2', status: 'dismissed' }),
      row({ id: '3', status: 'verified' }),
      row({ id: '4', status: 'in_report', lastDetectedMs: 3_000 }),
      row({ id: '5', category: 'performance', severity: 4 }),
      row({ id: '6', severity: 3 }),
      row({ id: '7', status: 'action_taken', severity: 5, lastDetectedMs: 500 }),
      row({ id: '8', status: 'unknown_status' }),
    ]);
    expect(banner.count).toBe(3);
    expect(banner.latest.map((r) => r.id)).toEqual(['7', '4', '1']);
  });

  it('최대 3건만 보여 주고 건수는 모두 센다', () => {
    const banner = safetyFindingsBanner(Array.from({ length: 5 }, (_, i) => row({ id: String(i + 1), lastDetectedMs: i })));
    expect(banner.count).toBe(5);
    expect(banner.latest.map((r) => r.id)).toEqual(['5', '4', '3']);
  });

  it('배너 구분: 안전 이벤트(수집 즉시 경로)와 안전 발견사항(분석 결과)', () => {
    expect(safetyBannerTone(0, 0)).toBe('clear');
    expect(safetyBannerTone(2, 0)).toBe('events');
    expect(safetyBannerTone(0, 1)).toBe('findings');
    expect(safetyBannerTone(1, 1)).toBe('both');
  });
});
