// templateComposer@1 (설계 §5.4): EvidencePack → ReportDraft. 탐지기별 한국어 메시지 템플릿(messages/)과 플레이북으로 문장을 만든다.
// 섹션: 요약 / 이번 달·분기 할 일 3개 / 발견사항 / 데이터 품질 요청 / 검증된 조치 효과 / KPI / 안전 고정 문구.
// 모든 숫자는 팩 경로 토큰이라 validateDraft가 팩 값과 대조한다.
import { verdictLabel } from '@/lib/desk/labels';
import { SAFETY_NOTICE, type DraftBlock, type DraftSection, type ReportComposer, type ReportDraft } from './composer';
import { ENERGY_KEYS, ENERGY_LABELS, KPI_TEXT_KEYS, kpiDisplay } from './kpi-labels';
import { adviceMessage, findingMessage, scopeOf, type Scope } from './messages';
import { joinPresent, seq, when, type Piece } from './messages/scope';
import type { EvidencePack, PackFinding } from './pack-types';

export const TEMPLATE_COMPOSER_ID = 'templateComposer@1';

const block = (id: string, piece: Piece | string, citations: readonly string[]): DraftBlock => {
  const p = typeof piece === 'string' ? { text: piece, tokens: [] } : piece;
  return { id, text: p.text, citations: [...citations], numberTokens: p.tokens };
};

const unitSuffix = (unit: string): string => (unit === '' ? '' : unit === '%' ? '%' : ` ${unit}`);

function summarySection(pack: EvidencePack, s: Scope): DraftSection {
  const overview = seq(
    s.label('site.code'),
    ' ',
    s.date('period.from'),
    ' ~ ',
    s.date('period.lastDay'),
    ': 발견사항 ',
    s.num('stats.findingCount'),
    '건(심각도 ',
    s.num('stats.severeThreshold'),
    ' 이상 ',
    s.num('stats.severeCount'),
    '건, 판정 보류 ',
    s.num('stats.holdCount'),
    '건), 조치 효과 검증 ',
    s.num('stats.verifiedActionCount'),
    '건(개선 확인 ',
    s.num('stats.improvedCount'),
    '건).',
  );
  const energyParts = ENERGY_KEYS.flatMap((key) => (s.has(`energySummary.${key}`) ? [seq(`${ENERGY_LABELS[key].label} `, s.num(`energySummary.${key}`, key === 'h2Kg' ? 1 : 0), ` ${ENERGY_LABELS[key].unit}`)] : []));
  const energy = energyParts.length === 0 ? '기간 발전·수소 계측값이 없습니다.' : seq('기간 계측: ', joinPresent(energyParts, ' · '), '.');
  return { kind: 'summary', title: '요약', blocks: [block('summary.overview', overview, ['stats']), block('summary.energy', energy, ['energy'])] };
}

const TODO_TITLES = { month: '이번 달 할 일', quarter: '이번 분기 할 일', custom: '이번 기간 할 일' } as const;

function todoSection(pack: EvidencePack, s: Scope): DraftSection {
  const blocks = pack.todo.flatMap((todo, i): DraftBlock[] => {
    const f = pack.findings[todo.findingIndex];
    if (!f) return [];
    const fs = s.at(`findings[${todo.findingIndex}]`);
    const effect = when(fs.has('effect.value'), () => seq(' ', fs.signed('effect.value', 1), unitSuffix(f.effect.unit)));
    const piece = seq(s.num(`todo[${i}].rank`), '. [', fs.label('assetPath'), '] ', s.label(`todo[${i}].action`), ' — ', fs.label('detectorLabel'), effect, ' (심각도 ', fs.num('severity'), ', 신뢰도 ', fs.pct('confidence'), '%)');
    return [block(`todo.${todo.rank}`, piece, [`finding:${f.id}`])];
  });
  return { kind: 'todo', title: TODO_TITLES[pack.period.kind], blocks: blocks.length > 0 ? blocks : [block('todo.none', '우선 조치할 발견사항이 없습니다.', ['stats'])] };
}

function findingBlocks(pack: EvidencePack, s: Scope, f: PackFinding, index: number, idPrefix: string): DraftBlock[] {
  const fs = s.at(`findings[${index}]`);
  const citations = [`finding:${f.id}`, ...(f.evidenceId ? [`evidence:${f.evidenceId}`] : [])];
  const advice = f.judgement === 'hold' ? null : adviceMessage(fs, f);
  return [block(`${idPrefix}.${f.id}.message`, findingMessage(fs, f), citations), ...(advice ? [block(`${idPrefix}.${f.id}.advice`, advice, [`finding:${f.id}`])] : [])];
}

function findingsSection(pack: EvidencePack, s: Scope): DraftSection {
  const blocks = pack.findings.flatMap((f, index) => (f.category === 'data_quality' ? [] : findingBlocks(pack, s, f, index, 'finding')));
  return { kind: 'findings', title: '발견사항', blocks: blocks.length > 0 ? blocks : [block('findings.none', '이번 리포트에 포함한 발견사항이 없습니다.', ['stats'])] };
}

function dataQualitySection(pack: EvidencePack, s: Scope): DraftSection {
  const findings = pack.findings.flatMap((f, index) => (f.category === 'data_quality' ? findingBlocks(pack, s, f, index, 'dq') : []));
  const low = pack.dataQuality.lowCompleteness.map((item, i) => {
    const ls = s.at(`dataQuality.lowCompleteness[${i}]`);
    const piece = seq('[', ls.label('assetPath'), '] ', ls.label('label'), ' 데이터 완결성 ', ls.num('completenessPct', 1), '%(', ls.num('days'), '일) — 기준 ', s.num('dataQuality.completenessThresholdPct'), '%에 못 미칩니다. 통신·계측 경로 점검을 요청합니다.');
    return block(`dq.completeness.${i + 1}`, piece, [`kpi:${item.key}`]);
  });
  const blocks = [...findings, ...low];
  const none = block('dq.none', seq('데이터 품질 발견사항과 완결성 기준(', s.num('dataQuality.completenessThresholdPct'), '%)에 못 미친 지표가 없습니다.'), ['data_quality']);
  return { kind: 'data_quality', title: '데이터 품질 요청', blocks: blocks.length > 0 ? blocks : [none] };
}

function verifiedActionsSection(pack: EvidencePack, s: Scope): DraftSection {
  const blocks = pack.verifiedActions.map((action, i) => {
    const as = s.at(`verifiedActions[${i}]`);
    const digits = action.unit === 'V' ? 4 : 1;
    const result =
      action.verdict === 'insufficient_data' || !as.has('effect')
        ? seq(' 전후 비교 표본이 부족해 판정하지 못했습니다(전 ', as.num('beforeN'), '회·후 ', as.num('afterN'), '회).')
        : seq(
            ' ',
            as.signed('effect', digits),
            unitSuffix(action.unit),
            '(',
            when(as.has('ciLow') && as.has('ciHigh'), () => seq('95% CI ', as.signed('ciLow', digits), ' ~ ', as.signed('ciHigh', digits), ', ')),
            '전 ',
            as.num('beforeN'),
            '회·후 ',
            as.num('afterN'),
            `회 비교) → ${verdictLabel(action.verdict)}.`,
          );
    const piece = seq('[', as.label('assetPath'), '] 조치 "', as.label('actionType'), '"(수행 ', as.date('performedAt'), '): ', as.label('metricLabel'), result);
    // 연결한 발견사항은 팩에 포함했을 때만 인용한다 (고르지 않은 발견사항은 근거 id가 팩에 없다)
    const linked = action.findingId !== null && pack.findings.some((f) => f.id === action.findingId) ? [`finding:${action.findingId}`] : [];
    return block(`action.${action.verificationId}`, piece, [`verification:${action.verificationId}`, ...linked]);
  });
  const none = pack.selection.includeVerifiedActions ? '이번 기간에 계산된 조치 효과 검증이 없습니다.' : '이 리포트에는 조치 효과 검증을 포함하지 않았습니다.';
  return { kind: 'verified_actions', title: '검증된 조치 효과', blocks: blocks.length > 0 ? blocks : [block('actions.none', none, ['stats'])] };
}

function kpiSection(pack: EvidencePack, s: Scope): DraftSection {
  const order = (key: string) => KPI_TEXT_KEYS.indexOf(key);
  const textKpis = pack.kpis.map((kpi, i) => ({ kpi, i })).filter(({ kpi }) => order(kpi.key) >= 0 && kpi.mean !== null).sort((a, b) => order(a.kpi.key) - order(b.kpi.key));
  const kpiBlocks = textKpis.flatMap(({ kpi, i }): DraftBlock[] => {
    const ks = s.at(`kpis[${i}]`);
    const digits = kpiDisplay(kpi.key).digits;
    const unit = unitSuffix(kpi.unit);
    const body =
      kpi.total !== null
        ? seq(' 합계 ', ks.num('total', digits), unit, '(', ks.num('days'), '일, 일평균 ', ks.num('mean', digits), unit, ')')
        : kpi.scope === 'site'
          ? seq(' 평균 ', ks.num('mean', digits), unit, '(', ks.num('days'), '일)')
          : seq(' 평균 ', ks.num('mean', digits), unit, ', 설비별 ', ks.num('min', digits), '~', ks.num('max', digits), unit, '(', ks.num('assetCount'), '대, 최대 ', ks.num('days'), '일)');
    const dq = when(ks.has('completenessPct'), () => seq(', 데이터 완결성 ', ks.num('completenessPct', 1), '%'));
    return [block(`kpi.${kpi.key}`, seq(ks.label('label'), body, dq, '.'), [`kpi:${kpi.key}`])];
  });
  const revenue = pack.revenueSummary.map((item, i) => {
    const rs = s.at(`revenueSummary[${i}]`);
    return block(`kpi.market.${item.key}`, seq(rs.label('label'), ' 기간 평균 ', rs.num('mean', 1), ` ${item.unit}(`, rs.num('days'), '일 입력, ', rs.num('min', 1), '~', rs.num('max', 1), ').'), [`market:${item.key}`]);
  });
  const blocks = [...kpiBlocks, ...revenue];
  return { kind: 'kpi', title: 'KPI', blocks: blocks.length > 0 ? blocks : [block('kpi.none', '기간 KPI 계산 결과가 없습니다. 분석을 실행하면 일 KPI가 채워집니다.', ['stats'])] };
}

export const templateComposer: ReportComposer = {
  id: TEMPLATE_COMPOSER_ID,
  compose(pack: EvidencePack): ReportDraft {
    const s = scopeOf(pack);
    return {
      composerId: TEMPLATE_COMPOSER_ID,
      packHash: pack.provenance.packHash,
      title: `${pack.site.name} 코칭 리포트 · ${pack.period.label}`,
      sections: [
        summarySection(pack, s),
        todoSection(pack, s),
        findingsSection(pack, s),
        dataQualitySection(pack, s),
        verifiedActionsSection(pack, s),
        kpiSection(pack, s),
        { kind: 'safety', title: '안전 안내', blocks: [block('safety.notice', SAFETY_NOTICE, [])] },
      ],
    };
  },
};
