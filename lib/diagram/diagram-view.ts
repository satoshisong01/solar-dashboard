// 공정도 화면이 그리는 것(설비 상자 값·계장 태그 값·강조)을 만드는 순수 변환. 'server-only' 금지 — DB를 모른다.
//
// 규칙 (docs/renewal/pid-gapyeong-plan.md §7.3·§7.4):
//   - 값은 계측 포인트의 최근 원시값만 쓴다. 파생값(UA·SEC·회수율)은 공정도에 올리지 않는다
//     — 계측값과 계산값을 같은 모양으로 그리면 안 되기 때문이다.
//   - 값이 없으면 숫자를 지어내지 않고 '데이터 없음'으로 둔다.
//   - 흐름선은 물질만 나타내고 상태는 설비 상자 테두리·배지로만 나타낸다.
//   - 상태 어휘는 지도·플릿과 같은 것을 쓴다 (바로 확인 · 주의 · 정상 · 수신 없음).
import { INVALID_QUALITY_MASK } from '@/lib/data/quality';
import { MAP_LEVEL_LABELS, mapLevelOf, type MapLevel } from '@/lib/data/map-status';
import { SAFETY_FINDING_MIN_SEVERITY } from '@/lib/desk/safety';
import { formatNumber } from '@/lib/format';
import {
  NODES,
  PIPES,
  REQUIRED_CLASS_KEY,
  TAGS,
  type NodeDef,
  type PipeDef,
  type ReadoutDef,
  type TagDef,
} from './gapyeong-layout';

/** '수신 없음' 판정 기준: 플릿 매트릭스의 수신 끊김과 같은 60분 */
export const DIAGRAM_SILENCE_MS = 60 * 60_000;
/** period_s가 없는 포인트에 쓰는 기본 주기 [s] */
const DEFAULT_PERIOD_S = 300;
/** 지연·결측 판정 배수 (plan §7.3) */
const LATE_PERIODS = 3;
const MISSING_PERIODS = 10;

export interface DiagramAssetInput {
  readonly id: number;
  /** 사이트 안 설비 코드 (예: ELZ1/WTU1) */
  readonly code: string;
  readonly name: string;
  readonly classKey: string;
  readonly className: string;
  readonly nameplate: Readonly<Record<string, unknown>>;
}

export interface DiagramPointInput {
  readonly id: number;
  readonly assetCode: string;
  readonly metricKey: string;
  readonly qualifier: string;
  readonly unit: string;
  readonly valueKind: string;
  readonly periodS: number | null;
  readonly instrumentTag: string | null;
  /** 가장 최근 원시 샘플. 수신 기록이 없으면 null */
  readonly tsMs: number | null;
  readonly value: number | null;
  readonly quality: number;
}

export interface DiagramFindingInput {
  readonly id: string;
  /** 사이트 단위 발견사항이면 null */
  readonly assetCode: string | null;
  readonly severity: number;
  readonly category: string;
  readonly title: string;
}

export interface DiagramInput {
  readonly siteCode: string;
  readonly assets: readonly DiagramAssetInput[];
  readonly points: readonly DiagramPointInput[];
  readonly findings: readonly DiagramFindingInput[];
  readonly nowMs: number;
}

/** 해당 없음(설비가 없다)까지 포함한 상자 상태 */
export type DiagramLevel = MapLevel | 'absent';

export const DIAGRAM_LEVEL_LABELS: Readonly<Record<DiagramLevel, string>> = { ...MAP_LEVEL_LABELS, absent: '해당 없음' };

/** 값 상태: 정상 · 지연 · 결측 · 품질 이상 · 연결된 포인트 없음 */
export type ValueState = 'ok' | 'late' | 'missing' | 'invalid' | 'unmapped';

export const VALUE_STATE_LABELS: Readonly<Record<ValueState, string>> = {
  ok: '정상',
  late: '수집 지연',
  missing: '데이터 없음',
  invalid: '품질 이상',
  unmapped: '포인트 없음',
};

export interface DiagramValue {
  readonly label: string;
  readonly state: ValueState;
  /** 화면에 그대로 적는 문자열 ('28.4 bar' 또는 '데이터 없음') */
  readonly text: string;
  readonly value: number | null;
  readonly unit: string;
  readonly tsMs: number | null;
  /** 이 값을 만든 포인트 (합·평균이면 여럿) */
  readonly pointIds: readonly number[];
}

export interface DiagramAssetRef {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly className: string;
}

export interface DiagramNodeView {
  readonly def: NodeDef;
  readonly asset: DiagramAssetRef | null;
  /** 명판에서 읽은 용량 문자열 (값이 없는 항목은 빠진다) */
  readonly capacity: readonly string[];
  readonly readouts: readonly DiagramValue[];
  readonly level: DiagramLevel;
  readonly openFindingCount: number;
  readonly worstSeverity: number | null;
  readonly hasSafetyFinding: boolean;
  readonly worstFindingId: string | null;
  /** 상자를 눌렀을 때 갈 곳: 열린 발견사항이 있으면 그 발견사항, 없으면 설비 상세 */
  readonly href: string | null;
  readonly lastSampleMs: number | null;
  readonly pointCount: number;
}

export type TagBinding = 'tag' | 'metric' | 'none';

export interface DiagramTagView {
  readonly def: TagDef;
  readonly value: DiagramValue;
  /** 계장 태그로 찾았는지(tag), 메트릭 후보로 찾았는지(metric), 못 찾았는지(none) */
  readonly binding: TagBinding;
  /** 실제로 읽은 포인트 (예: 'H2BUF1 / h2.pressure@buffer') */
  readonly pointLabel: string | null;
}

export interface OffDiagramFinding {
  readonly id: string;
  readonly assetCode: string | null;
  readonly severity: number;
  readonly title: string;
}

export interface DiagramView {
  readonly siteCode: string;
  /** 이 사이트에 이 공정도를 그릴 수 있는가 (수전해 설비가 있어야 한다) */
  readonly available: boolean;
  readonly nodes: readonly DiagramNodeView[];
  readonly tags: readonly DiagramTagView[];
  readonly pipes: readonly PipeDef[];
  /** 공정도가 읽은 값 중 가장 최근 수신 시각 */
  readonly lastSampleMs: number | null;
  /** 도면 상자에 걸리지 않는 열린 발견사항 (사이트 단위·도면에 없는 설비) */
  readonly offDiagramFindings: readonly OffDiagramFinding[];
}

interface SourceRef {
  readonly metricKey: string;
  readonly qualifier: string | null;
}

/** 'metricKey' 또는 'metricKey@qualifier' */
export function parseSource(source: string): SourceRef {
  const at = source.indexOf('@');
  return at < 0 ? { metricKey: source, qualifier: null } : { metricKey: source.slice(0, at), qualifier: source.slice(at + 1) };
}

/** 단위별 소수 자릿수. 없으면 1자리 */
const UNIT_DIGITS: Readonly<Record<string, number>> = {
  bar: 2,
  '%': 1,
  '°C': 1,
  'kg/h': 1,
  'm³/h': 2,
  'µS/cm': 3,
  kW: 0,
  kWh: 0,
  kg: 1,
  V: 0,
  'Nm³/h': 0,
};

export const digitsForUnit = (unit: string): number => UNIT_DIGITS[unit] ?? 1;

const isPrefix = (assetCode: string, nodeCode: string): boolean => assetCode === nodeCode || assetCode.startsWith(`${nodeCode}/`);

/** 설비 코드 → 이 설비를 품는 상자 id. 가장 깊은(코드가 긴) 상자가 이긴다 — FC1/HX1은 fc가 아니라 hx에 속한다 */
function ownerOf(assetCode: string, nodeCodes: readonly (readonly [string, string])[]): string | null {
  let bestId: string | null = null;
  let bestLen = -1;
  for (const [nodeId, nodeCode] of nodeCodes) {
    if (isPrefix(assetCode, nodeCode) && nodeCode.length > bestLen) {
      bestId = nodeId;
      bestLen = nodeCode.length;
    }
  }
  return bestId;
}

function stateOf(point: DiagramPointInput, nowMs: number): ValueState {
  if (point.tsMs === null || point.value === null) return 'missing';
  if ((point.quality & INVALID_QUALITY_MASK) !== 0) return 'invalid';
  const periodMs = (point.periodS ?? DEFAULT_PERIOD_S) * 1_000;
  const ageMs = nowMs - point.tsMs;
  if (ageMs > periodMs * MISSING_PERIODS) return 'missing';
  if (ageMs > periodMs * LATE_PERIODS) return 'late';
  return 'ok';
}

const STATE_RANK: Readonly<Record<ValueState, number>> = { unmapped: 0, missing: 1, invalid: 2, late: 3, ok: 4 };
const worstState = (states: readonly ValueState[]): ValueState =>
  states.reduce((worst, state) => (STATE_RANK[state] < STATE_RANK[worst] ? state : worst), 'ok' as ValueState);

/** 같은 후보에 포인트가 여러 개면 설비 코드 → 한정자 순으로 고른다 (같은 입력이면 항상 같은 포인트) */
const byPointOrder = (a: DiagramPointInput, b: DiagramPointInput): number =>
  a.assetCode.localeCompare(b.assetCode) || a.qualifier.localeCompare(b.qualifier) || a.id - b.id;

function matchPoints(points: readonly DiagramPointInput[], sources: readonly string[]): readonly DiagramPointInput[] {
  for (const source of sources) {
    const ref = parseSource(source);
    const found = points
      .filter((point) => point.metricKey === ref.metricKey && (ref.qualifier === null || point.qualifier === ref.qualifier))
      .sort(byPointOrder);
    if (found.length > 0) return found;
  }
  return [];
}

const emptyValue = (label: string): DiagramValue => ({
  label,
  state: 'unmapped',
  text: VALUE_STATE_LABELS.unmapped,
  value: null,
  unit: '',
  tsMs: null,
  pointIds: [],
});

/** 포인트 묶음 → 화면 값. 합·평균은 같은 단위의 포인트끼리만 한다 */
export function readValue(label: string, found: readonly DiagramPointInput[], agg: ReadoutDef['agg'], nowMs: number): DiagramValue {
  if (found.length === 0) return emptyValue(label);
  const used = agg === 'first' ? found.slice(0, 1) : found;
  const states = used.map((point) => stateOf(point, nowMs));
  const state = worstState(states);
  const unit = used[0]?.unit ?? '';
  const pointIds = used.map((point) => point.id);
  const tsList = used.flatMap((point) => (point.tsMs === null ? [] : [point.tsMs]));
  const tsMs = tsList.length === 0 ? null : Math.min(...tsList);
  if (state === 'missing' || state === 'invalid') {
    return { label, state, text: VALUE_STATE_LABELS[state], value: null, unit, tsMs, pointIds };
  }
  const values = used.flatMap((point) => (point.value === null ? [] : [point.value]));
  const total = values.reduce((sum, value) => sum + value, 0);
  const value = agg === 'avg' ? total / values.length : agg === 'sum' ? total : (values[0] as number);
  return { label, state, text: `${formatNumber(value, digitsForUnit(unit))} ${unit}`.trim(), value, unit, tsMs, pointIds };
}

/** 명판 값 → '2,500 kW'. 값이 없거나(미확인) 숫자가 아니면 빠진다. 명판은 반올림하지 않는다 (44.9 kg/h를 45로 바꾸지 않는다) */
export function readCapacity(nameplate: Readonly<Record<string, unknown>>, key: string, unit: string): string | null {
  const raw = nameplate[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return `${formatNumber(raw, 3)} ${unit}`;
  if (typeof raw === 'string' && raw !== '') return `${raw} ${unit}`;
  return null;
}

function nodeLevel(
  asset: DiagramAssetRef | null,
  findings: readonly DiagramFindingInput[],
  lastSampleMs: number | null,
  nowMs: number,
): { readonly level: DiagramLevel; readonly hasSafety: boolean; readonly worst: number | null } {
  const hasSafety = findings.some((finding) => finding.category === 'safety' && finding.severity >= SAFETY_FINDING_MIN_SEVERITY);
  const worst = findings.length === 0 ? null : Math.max(...findings.map((finding) => finding.severity));
  if (asset === null) return { level: 'absent', hasSafety: false, worst: null };
  const level = mapLevelOf(
    { openFindingCount: findings.length, worstSeverity: worst, hasSafetyFinding: hasSafety, lastSeenMs: lastSampleMs },
    nowMs,
    DIAGRAM_SILENCE_MS,
  );
  return { level, hasSafety, worst };
}

/** 심각도 높은 순 → 안전 먼저 → id 순 (같은 입력이면 항상 같은 순서) */
const byFindingOrder = (a: DiagramFindingInput, b: DiagramFindingInput): number =>
  b.severity - a.severity || Number(b.category === 'safety') - Number(a.category === 'safety') || a.id.localeCompare(b.id);

export function buildDiagram(input: DiagramInput): DiagramView {
  const { siteCode, assets, points, findings, nowMs } = input;
  const available = assets.some((asset) => asset.classKey === REQUIRED_CLASS_KEY);

  // 상자 ↔ 설비: 종류가 같은 설비가 여럿이면 코드가 짧은(위쪽) 것을 쓴다
  const nodeAssets = new Map<string, DiagramAssetInput>();
  for (const node of NODES) {
    const found = assets.filter((asset) => asset.classKey === node.classKey).sort((a, b) => a.code.localeCompare(b.code))[0];
    if (found) nodeAssets.set(node.id, found);
  }
  const nodeCodes = [...nodeAssets].map(([nodeId, asset]) => [nodeId, asset.code] as const);
  const ownerCache = new Map<string, string | null>();
  const ownerFor = (assetCode: string): string | null => {
    const cached = ownerCache.get(assetCode);
    if (cached !== undefined) return cached;
    const owner = ownerOf(assetCode, nodeCodes);
    ownerCache.set(assetCode, owner);
    return owner;
  };

  const nodes = NODES.map((def): DiagramNodeView => {
    const found = nodeAssets.get(def.id);
    const asset: DiagramAssetRef | null = found ? { id: found.id, code: found.code, name: found.name, className: found.className } : null;
    const own = points.filter((point) => ownerFor(point.assetCode) === def.id);
    const ownFindings = findings.filter((finding) => finding.assetCode !== null && ownerFor(finding.assetCode) === def.id).sort(byFindingOrder);
    const readouts = def.readouts.map((readout) => readValue(readout.label, matchPoints(own, readout.sources), readout.agg, nowMs));
    const samples = own.flatMap((point) => (point.tsMs === null ? [] : [point.tsMs]));
    const lastSampleMs = samples.length === 0 ? null : Math.max(...samples);
    const { level, hasSafety, worst } = nodeLevel(asset, ownFindings, lastSampleMs, nowMs);
    const worstFindingId = ownFindings[0]?.id ?? null;
    return {
      def,
      asset,
      capacity: found ? def.capacity.flatMap((cap) => readCapacity(found.nameplate, cap.key, cap.unit) ?? []) : [],
      readouts,
      level,
      openFindingCount: ownFindings.length,
      worstSeverity: worst,
      hasSafetyFinding: hasSafety,
      worstFindingId,
      href:
        worstFindingId !== null
          ? `/desk/${worstFindingId}`
          : asset
            ? `/sites/${encodeURIComponent(siteCode)}/assets/${asset.id}`
            : null,
      lastSampleMs,
      pointCount: own.length,
    };
  });

  const drawn = new Set(nodes.flatMap((node) => (node.asset === null ? [] : [node.def.id])));
  const tags = TAGS.flatMap((def): DiagramTagView[] => {
    if (!drawn.has(def.nodeId)) return [];
    const byTag = points.filter((point) => point.instrumentTag === def.tag).sort(byPointOrder);
    const own = points.filter((point) => ownerFor(point.assetCode) === def.nodeId);
    const found = byTag.length > 0 ? byTag.slice(0, 1) : matchPoints(own, def.sources).slice(0, 1);
    const binding: TagBinding = byTag.length > 0 ? 'tag' : found.length > 0 ? 'metric' : 'none';
    const point = found[0];
    return [
      {
        def,
        value: readValue(def.tag, found, 'first', nowMs),
        binding,
        pointLabel: point ? `${point.assetCode} / ${point.metricKey}${point.qualifier === '' ? '' : `@${point.qualifier}`}` : null,
      },
    ];
  });

  const pipes = PIPES.filter((pipe) => pipeNodeIds(pipe).every((nodeId) => drawn.has(nodeId)));
  const allTs = [...nodes.flatMap((node) => (node.lastSampleMs === null ? [] : [node.lastSampleMs]))];
  const offDiagramFindings = findings
    .filter((finding) => finding.assetCode === null || ownerFor(finding.assetCode) === null)
    .sort(byFindingOrder)
    .map((finding) => ({ id: finding.id, assetCode: finding.assetCode, severity: finding.severity, title: finding.title }));

  return {
    siteCode,
    available,
    nodes,
    tags,
    pipes,
    lastSampleMs: allTs.length === 0 ? null : Math.max(...allTs),
    offDiagramFindings,
  };
}

const NODE_IDS: ReadonlySet<string> = new Set(NODES.map((node) => node.id));

/** 흐름선이 이어 주는 상자 id. 선 id가 `from.to` 형식이고, 도면 바깥 끝(전력계통)은 상자가 아니다 */
export function pipeNodeIds(pipe: PipeDef): readonly string[] {
  return pipe.id.split('.').filter((part) => NODE_IDS.has(part));
}
