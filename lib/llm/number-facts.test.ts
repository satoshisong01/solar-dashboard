// 숫자와 라벨의 짝: 엔진 문장에서 짝을 뽑고, 바꿔 붙인 답만 골라 잡는가.
import { describe, expect, it } from 'vitest';
import { mismatchedFacts, numberFacts } from './number-facts';

const BREAKDOWN = '계통별로 보면 배터리 4건, 전해조 1건, 데이터 품질 1건입니다.';
const URGENCY = '급한 정도로 나누면 바로 확인 3건, 이번 주 확인 1건, 지켜보기 2건입니다.';
const BASIS = '충전이 끝난 순간에 잰 값으로 예전 20번, 최근 30번을 비교했습니다.';
const LABELS = ['배터리', '전해조', '데이터 품질', '랙 1(RACK01)'];

const pairsOf = (text: string, labels: readonly string[] = LABELS): [string, string][] => numberFacts(text, labels).map((fact) => [fact.value, fact.label]);
const mismatched = (candidate: string, engine: string, labels: readonly string[] = LABELS): string[] => mismatchedFacts(candidate, numberFacts(engine, labels), labels).map((fact) => fact.label);

describe('numberFacts', () => {
  it('숫자마다 앞에 있는 이름을 짝으로 잡는다', () => {
    expect(pairsOf(BREAKDOWN)).toEqual([
      ['4', '배터리'],
      ['1', '전해조'],
      ['1', '품질'],
    ]);
  });

  it('같은 말이 여러 번 나오면 옆 낱말을 붙여 가른다', () => {
    expect(pairsOf(URGENCY)).toEqual([
      ['3', '바로 확인'],
      ['1', '주 확인'],
      ['2', '지켜보기'],
    ]);
  });

  it('숫자 뒤에 있는 말도 짝이 된다', () => {
    expect(pairsOf('그중 5건은 아직 분류하지 않은 새 건이고, 1건은 조치 뒤 다시 열린 건입니다.')).toEqual([
      ['5', '분류하지'],
      ['1', '조치'],
    ]);
  });

  it('단위·지시어는 짝으로 쓰지 않는다', () => {
    expect(pairsOf(BREAKDOWN).map(([, label]) => label)).not.toContain('건');
    expect(pairsOf('지금 열려 있는 발견사항은 모두 6건입니다.')).toEqual([['6', '발견사항']]);
  });

  it('설비 이름 속 숫자는 짝을 만들지 않는다', () => {
    expect(pairsOf('그중 가장 먼저 볼 건은 랙 1(RACK01)에서 잡혔습니다.')).toEqual([]);
  });
});

describe('mismatchedFacts', () => {
  it('건수를 서로 바꿔 붙이면 잡는다', () => {
    expect(mismatched('계통별로 보면 배터리 1건, 전해조 4건, 데이터 품질 1건입니다.', BREAKDOWN)).toEqual(['배터리', '전해조']);
    expect(mismatched('급한 정도로 나누면 바로 확인 1건, 이번 주 확인 3건, 지켜보기 2건입니다.', URGENCY)).toEqual(['바로 확인', '주 확인']);
    expect(mismatched('예전 30번, 최근 20번을 견줬습니다.', BASIS, [])).toEqual(['예전', '최근']);
  });

  it('라벨과 숫자가 함께 움직이면 통과시킨다', () => {
    expect(mismatched('계통별로 보면 전해조 1건, 데이터 품질 1건, 배터리 4건입니다.', BREAKDOWN)).toEqual([]);
    expect(mismatched('최근 30번과 예전 20번을 견줬습니다.', BASIS, [])).toEqual([]);
  });

  it('말을 바꿔 써도 숫자 짝이 맞으면 통과시킨다', () => {
    expect(mismatched('계통별로 보면 배터리 쪽이 4건으로 가장 많고, 전해조 1건, 데이터 품질 1건입니다.', BREAKDOWN)).toEqual([]);
  });

  it('표시 반올림은 같은 값으로 본다', () => {
    expect(mismatched('예전 20번, 최근 30.0번을 비교했습니다.', BASIS, [])).toEqual([]);
  });

  it('라벨이 사라졌거나 라벨 옆에 숫자가 없으면 판단하지 않는다', () => {
    expect(mismatched('계통별로 나누면 4건, 1건, 1건입니다.', BREAKDOWN)).toEqual([]);
    expect(mismatched('배터리·전해조·데이터 품질에서 잡혔습니다.', BREAKDOWN)).toEqual([]);
  });
});
