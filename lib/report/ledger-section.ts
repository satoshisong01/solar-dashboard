// templateComposer@1 '에너지·수소 원장' 절 (순수): 팩 energyLedger(기간 합)만 쓴다 — 에너지 흐름 요약 · 수소 원장·잔차율 · 체인 KPI(SEC·계통전력 비율·P2P) · PV 미활용 분해 · 원장 품질.
// 모든 숫자는 팩 경로 토큰이다. 할당 버전·계산 버전은 이름 토큰(숫자 검사에서 뺀다).
import type { DraftBlock, DraftSection } from './composer';
import type { EvidencePack } from './pack-types';
import type { PackEnergyLedger } from './pack-types-p3';
import { joinPresent, seq, when, type Piece, type Scope } from './messages/scope';

const block = (id: string, piece: Piece | string): DraftBlock => {
  const p = typeof piece === 'string' ? { text: piece, tokens: [] } : piece;
  return { id, text: p.text, citations: ['ledger'], numberTokens: p.tokens };
};

const SUPPLY = [
  ['pvKwh', '태양광'],
  ['essDischargeKwh', 'ESS 방전'],
  ['fcKwh', '연료전지'],
  ['gridImportKwh', '계통 수전'],
] as const;

const DEMAND = [
  ['siteAuxKwh', '보조부하'],
  ['essChargeKwh', 'ESS 충전'],
  ['electrolyzerKwh', '전해조'],
  ['compressorKwh', '압축기'],
  ['gridExportKwh', '계통 송전'],
] as const;

type EnergyKey = keyof PackEnergyLedger['energy'];

function energyBlock(ls: Scope, ledger: PackEnergyLedger): DraftBlock {
  const parts = (items: readonly (readonly [EnergyKey, string])[]) => joinPresent(items.map(([key, label]) => (ledger.energy[key] > 0 ? seq(`${label} `, ls.num(`energy.${key}`), ' kWh') : null)), ' · ');
  return block(
    'ledger.energy',
    seq(
      '체인 원장 ',
      ls.num('days'),
      '일(',
      ls.date('firstDay'),
      ' ~ ',
      ls.date('lastDay'),
      ') 전력 흐름 — 공급: ',
      parts(SUPPLY),
      ', 수요: ',
      parts(DEMAND),
      when(ledger.energy.unmeteredKwh > 0, () => seq(', 계측 불일치 ', ls.num('energy.unmeteredKwh'), ' kWh')),
      '. ',
      ls.label('allocVersion'),
      ' 비례 할당 회계 흐름이며 실제 전기적 경로나 청정수소 인증 공식 산정이 아닙니다.',
    ),
  );
}

function hydrogenBlock(ls: Scope, ledger: PackEnergyLedger): DraftBlock {
  if (ledger.hydrogen === null) return block('ledger.hydrogen', '기간에 수소 원장 값(생산·연료전지 소비·잔차)이 모두 있는 날이 없습니다.');
  const hs = ls.at('hydrogen');
  return block(
    'ledger.hydrogen',
    seq(
      '수소 원장(',
      hs.num('daysUsed'),
      '일 합): 생산 ',
      hs.num('producedKg', 1),
      ' kg − 연료전지 소비 ',
      hs.num('fcConsumedKg', 1),
      ' kg − 저장 증감 ',
      hs.signed('storedDeltaKg', 1),
      ' kg − 배기 추정 ',
      hs.num('ventedEstKg', 2),
      ' kg = 잔차 ',
      hs.signed('residualKg', 2),
      ' kg',
      when(hs.has('residualPct'), () => seq('(잔차율 ', hs.signed('residualPct', 2), '%)')),
      '.',
      when(ledger.lowH2CompletenessDays > 0, () => seq(' 수소 원장 완결성 기준 미만인 날 ', ls.num('lowH2CompletenessDays'), '일은 물질수지 탐지에서 빠집니다.')),
    ),
  );
}

function kpiBlock(ls: Scope): DraftBlock {
  const ks = ls.at('kpis');
  const parts = joinPresent(
    [
      ks.has('elzSecKwhPerKg') ? seq('전해조 비에너지 ', ks.num('elzSecKwhPerKg', 1), ' kWh/kg') : null,
      ks.has('renewableSharePct') && ks.has('gridSharePct') ? seq('전해조 입력 전력 재생 비율 ', ks.num('renewableSharePct', 1), '%·계통전력 비율 ', ks.num('gridSharePct', 1), '%') : null,
      ks.has('fcKgPerMwh') ? seq('연료전지 수소 원단위 ', ks.num('fcKgPerMwh', 1), ' kg/MWh') : null,
      ks.has('p2pEfficiencyPct') ? seq('P2P 효율 ', ks.num('p2pEfficiencyPct', 1), '%') : null,
    ],
    ', ',
  );
  return block('ledger.kpi', parts.text === '' ? '기간 체인 KPI(비에너지·계통전력 비율·P2P)를 계산할 생산·소비가 없습니다.' : seq('기간 합 체인 KPI: ', parts, '.'));
}

function pvLossBlock(ls: Scope, ledger: PackEnergyLedger): DraftBlock | null {
  if (ledger.pvLoss === null) return null;
  const items = ledger.pvLoss.items.flatMap((item, i) =>
    Math.abs(item.kwh) >= 1 ? [seq(ls.label(`pvLoss.items[${i}].label`), ' ', ls.signed(`pvLoss.items[${i}].kwh`, 0), ' kWh', when(ls.has(`pvLoss.items[${i}].pctOfExpected`), () => seq('(', ls.signed(`pvLoss.items[${i}].pctOfExpected`, 2), '%)')))] : [],
  );
  return block(
    'ledger.pv_loss',
    seq('PV 미활용 원인 분해(', ls.num('pvLoss.daysWithBreakdown'), '일, 기대 발전 ', ls.num('pvLoss.expectedKwh'), ' kWh·실제 ', ls.num('pvLoss.actualKwh'), ' kWh): ', items.length === 0 ? '뚜렷한 미활용 원인이 없습니다' : joinPresent(items, ' · '), '. 괄호는 기대 발전 대비 비율입니다.'),
  );
}

export function ledgerSection(pack: EvidencePack, s: Scope): DraftSection {
  const ledger = pack.energyLedger ?? null;
  if (ledger === null) return { kind: 'ledger', title: '에너지·수소 원장', blocks: [{ id: 'ledger.none', text: '이 기간에 저장된 체인 원장이 없습니다. 분석을 실행하면 끝난 날의 원장이 채워집니다.', citations: ['stats'], numberTokens: [] }] };
  const ls = s.at('energyLedger');
  const quality = ls.has('unmeteredRatioPct') ? block('ledger.quality', seq('기간 계측 불일치율 ', ls.num('unmeteredRatioPct', 2), '%입니다(할당에 들어가지 않은 kWh ÷ 공급 합).')) : null;
  return {
    kind: 'ledger',
    title: '에너지·수소 원장',
    blocks: [energyBlock(ls, ledger), hydrogenBlock(ls, ledger), kpiBlock(ls), ...[pvLossBlock(ls, ledger), quality].filter((b): b is DraftBlock => b !== null)],
  };
}
