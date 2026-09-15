import { describe, expect, it } from 'vitest';
import { FLEET_THRESHOLDS, evaluateCell, summarizeLedgerResidual, worstLevel, type CellSignals } from './fleet-status';

const NOW = Date.parse('2026-09-14T11:30:00Z');
const MINUTE = 60_000;

const healthy: CellSignals = {
  hasAssets: true,
  lastSampleMs: NOW - 2 * MINUTE,
  majorAlarms24h: 0,
  criticalAlarms24h: 0,
  unackedSafety: 0,
  samples24h: 10_000,
  invalidSamples24h: 0,
  openFindings: 0,
  maxFindingSeverity: null,
  safetyFindings: 0,
  ledgerResidual: null,
};

const signals = (patch: Partial<CellSignals>): CellSignals => ({ ...healthy, ...patch });

describe('evaluateCell', () => {
  it('설비가 없으면 해당 없음(na)이고 다른 신호는 보지 않는다', () => {
    expect(evaluateCell(signals({ hasAssets: false, unackedSafety: 3 }), NOW)).toEqual({ level: 'na', reasons: [] });
  });

  it('모든 신호가 정상이면 ok', () => {
    expect(evaluateCell(healthy, NOW)).toEqual({ level: 'ok', reasons: [] });
  });

  it('수신 기록이 전혀 없으면 unknown', () => {
    const result = evaluateCell(signals({ lastSampleMs: null, samples24h: 0 }), NOW);
    expect(result.level).toBe('unknown');
    expect(result.reasons).toEqual(['수신 기록 없음']);
  });

  describe('데이터 신선도', () => {
    it('경계값: 15분까지 ok, 넘으면 warn', () => {
      expect(evaluateCell(signals({ lastSampleMs: NOW - FLEET_THRESHOLDS.staleWarnMs }), NOW).level).toBe('ok');
      const late = evaluateCell(signals({ lastSampleMs: NOW - FLEET_THRESHOLDS.staleWarnMs - 1 }), NOW);
      expect(late.level).toBe('warn');
      expect(late.reasons).toEqual(['수신 지연 15분']);
    });

    it('경계값: 60분까지 warn, 넘으면 crit', () => {
      expect(evaluateCell(signals({ lastSampleMs: NOW - FLEET_THRESHOLDS.staleCritMs }), NOW).level).toBe('warn');
      const lost = evaluateCell(signals({ lastSampleMs: NOW - 3 * 60 * MINUTE }), NOW);
      expect(lost).toEqual({ level: 'crit', reasons: ['수신 끊김 3시간'] });
    });

    it('미래 시각(게이트웨이 시계 오차)은 최신으로 본다', () => {
      expect(evaluateCell(signals({ lastSampleMs: NOW + 10 * MINUTE }), NOW).level).toBe('ok');
    });
  });

  describe('최근 알람 (24시간, 안전 이벤트 제외)', () => {
    it('major는 warn, critical은 crit', () => {
      expect(evaluateCell(signals({ majorAlarms24h: 2 }), NOW)).toEqual({ level: 'warn', reasons: ['주요 알람 2건'] });
      expect(evaluateCell(signals({ criticalAlarms24h: 1 }), NOW)).toEqual({ level: 'crit', reasons: ['심각 알람 1건'] });
    });
  });

  it('미확인 안전 이벤트가 있으면 다른 신호가 정상이어도 crit', () => {
    expect(evaluateCell(signals({ unackedSafety: 1 }), NOW)).toEqual({ level: 'crit', reasons: ['미확인 안전 이벤트 1건'] });
  });

  it('미확인 안전 이벤트는 수신 기록이 없어도 crit으로 올린다', () => {
    const result = evaluateCell(signals({ lastSampleMs: null, samples24h: 0, unackedSafety: 1 }), NOW);
    expect(result.level).toBe('crit');
    expect(result.reasons).toEqual(['수신 기록 없음', '미확인 안전 이벤트 1건']);
  });

  describe('데이터 품질 비트 비율 (24시간)', () => {
    it('경계값: 1% 미만 ok, 1% 이상 warn, 5% 이상 crit', () => {
      expect(evaluateCell(signals({ samples24h: 1000, invalidSamples24h: 9 }), NOW).level).toBe('ok');
      expect(evaluateCell(signals({ samples24h: 1000, invalidSamples24h: 10 }), NOW)).toEqual({
        level: 'warn',
        reasons: ['품질 이상 1.0%'],
      });
      expect(evaluateCell(signals({ samples24h: 1000, invalidSamples24h: 50 }), NOW)).toEqual({
        level: 'crit',
        reasons: ['품질 이상 5.0%'],
      });
    });

    it('24시간 샘플이 없으면 비율을 판정하지 않는다', () => {
      expect(evaluateCell(signals({ samples24h: 0, invalidSamples24h: 0 }), NOW).level).toBe('ok');
    });
  });

  describe('열린 발견사항 최고 심각도 (P2)', () => {
    it('경계값: 심각도 1은 사유만, 2~3은 warn, 4 이상은 crit', () => {
      expect(evaluateCell(signals({ openFindings: 2, maxFindingSeverity: 1 }), NOW)).toEqual({ level: 'ok', reasons: ['열린 발견사항 2건 (최고 심각도 1)'] });
      expect(evaluateCell(signals({ openFindings: 1, maxFindingSeverity: 2 }), NOW)).toEqual({ level: 'warn', reasons: ['열린 발견사항 1건 (최고 심각도 2)'] });
      expect(evaluateCell(signals({ openFindings: 3, maxFindingSeverity: 3 }), NOW).level).toBe('warn');
      expect(evaluateCell(signals({ openFindings: 1, maxFindingSeverity: 4 }), NOW)).toEqual({ level: 'crit', reasons: ['열린 발견사항 1건 (최고 심각도 4)'] });
    });

    it('열린 발견사항이 없으면 판정에 넣지 않고, 설비가 없는 셀은 na 그대로', () => {
      expect(evaluateCell(signals({ openFindings: 0, maxFindingSeverity: null }), NOW)).toEqual({ level: 'ok', reasons: [] });
      expect(evaluateCell(signals({ hasAssets: false, openFindings: 1, maxFindingSeverity: 5 }), NOW).level).toBe('na');
    });
  });

  it('여러 신호 중 가장 나쁜 수준을 쓰고 사유를 모두 남긴다', () => {
    const result = evaluateCell(
      signals({ lastSampleMs: NOW - 20 * MINUTE, majorAlarms24h: 1, samples24h: 100, invalidSamples24h: 6 }),
      NOW,
    );
    expect(result.level).toBe('crit');
    expect(result.reasons).toEqual(['수신 지연 20분', '주요 알람 1건', '품질 이상 6.0%']);
  });
});

describe('worstLevel', () => {
  it('crit > warn > unknown > ok 순으로 고르고 na는 무시한다', () => {
    expect(worstLevel(['ok', 'warn', 'na'])).toBe('warn');
    expect(worstLevel(['unknown', 'ok'])).toBe('unknown');
    expect(worstLevel(['warn', 'crit', 'unknown'])).toBe('crit');
  });

  it('모두 na이거나 비어 있으면 na', () => {
    expect(worstLevel(['na', 'na'])).toBe('na');
    expect(worstLevel([])).toBe('na');
  });
});

describe('P3 수소 도메인 신호', () => {
  it('열린 안전 발견사항은 위험, 사유에 현장 확인 우선', () => {
    const result = evaluateCell(signals({ openFindings: 1, maxFindingSeverity: 4, safetyFindings: 1 }), NOW);
    expect(result).toEqual({ level: 'crit', reasons: ['열린 발견사항 1건 (최고 심각도 4)', '안전 발견사항 1건 (현장 확인 우선)'] });
  });

  it('수소 원장 잔차율: 최근 7일 유효일 중앙값이 기준을 넘으면 주의, 완결성 미달·오래된 날은 빼고 유효일 5일 미만이면 판단하지 않는다', () => {
    const rule = { thresholdPct: 2, minCompleteness: 0.9 };
    const days = ['2026-09-01', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'].map((day, i) => ({ day, residualPct: i === 0 ? -50 : 2.1 + i * 0.05, completeness: i === 2 ? 0.5 : 1 }));
    const residual = summarizeLedgerResidual(days, rule);
    expect(residual).toEqual({ medianPct: 2.33, days: 6, thresholdPct: 2 });
    expect(evaluateCell(signals({ ledgerResidual: residual }), NOW)).toEqual({ level: 'warn', reasons: ['수소 원장 잔차율 중앙값 +2.33% (최근 6일, 기준 ±2%)'] });
    expect(evaluateCell(signals({ ledgerResidual: { medianPct: -1.5, days: 7, thresholdPct: 2 } }), NOW).level).toBe('ok');
    expect(summarizeLedgerResidual(days.slice(5), rule)).toBeNull();
    expect(summarizeLedgerResidual([], rule)).toBeNull();
  });
});
