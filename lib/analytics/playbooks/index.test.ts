import { describe, expect, it } from 'vitest';
import { DETECTORS, P2_DETECTORS } from '../detectors';
import { PLAYBOOKS, playbookFor } from './index';

describe('PLAYBOOKS', () => {
  it('탐지기 17종의 고장모드마다 플레이북이 하나씩 있고 카테고리가 같다', () => {
    expect(Object.keys(PLAYBOOKS)).toHaveLength(17);
    for (const detector of DETECTORS) {
      const playbook = playbookFor(detector.failureMode);
      expect(playbook.failureMode).toBe(detector.failureMode);
      expect(playbook.category).toBe(detector.category);
    }
  });

  it('원인 후보·점검·조치·오탐 함정·출처가 비어 있지 않고 원인 id가 겹치지 않는다', () => {
    for (const playbook of Object.values(PLAYBOOKS)) {
      expect(playbook.causes.length).toBeGreaterThan(0);
      expect(new Set(playbook.causes.map((c) => c.id)).size).toBe(playbook.causes.length);
      expect(playbook.inspections.length).toBeGreaterThan(0);
      expect(playbook.actions.length).toBeGreaterThan(0);
      expect(playbook.falsePositiveTraps.length).toBeGreaterThan(0);
      expect(playbook.sources.every((s) => s.startsWith('research-'))).toBe(true);
    }
  });

  it('안전 카테고리 플레이북은 현장 안전책임자 판단과 콘솔이 안전설비를 대체하지 않는다는 원칙을 담는다', () => {
    const safety = Object.values(PLAYBOOKS).filter((playbook) => playbook.category === 'safety');
    expect(safety.map((playbook) => playbook.failureMode).sort()).toEqual(['h2.storage_leak', 'o2.purity_drift']);
    for (const playbook of safety) {
      const text = playbook.actions.join(' ');
      expect(text).toContain('현장 안전책임자');
      expect(text).toContain('대체하지 않습니다');
    }
  });

  it('탐지기 id·버전은 DB 제약 형식이고 서로 겹치지 않는다', () => {
    const ids = P2_DETECTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(6);
    ids.forEach((id) => expect(id).toMatch(/^[a-z][a-z0-9]*\.[a-z0-9_]+$/));
    P2_DETECTORS.forEach((d) => expect(d.version).toBe('1'));
  });
});
