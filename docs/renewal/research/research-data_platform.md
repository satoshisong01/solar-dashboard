# 원시데이터 중심 O&M 인텔리전스 플랫폼 아키텍처 리서치 보고서

> 대상: solar-dashboard(Next.js 16 / Vercel / AWS RDS PostgreSQL) → 태양광·ESS·수전해·수소저장·연료전지 연계형 O&M 콘솔
> 작성 기준일: 2026-09-14. 코드는 수정하지 않았음. 아래 SQL/TS는 모두 **설계 스케치**이며 검증 전 코드임.

---

## 0. 한눈에 보는 결론

| # | 결정 | 한 줄 근거 |
|---|---|---|
| 1 | 수집은 **게이트웨이 → HTTPS 배치 POST(`om.ingest.v1` 봉투, gzip, HMAC 서명)**, 기본 5분 flush | 데이터 계약이 미정이어도 `src`(게이트웨이 원본 태그) 기반으로 받고 매핑은 서버에서 나중에 할 수 있음 |
| 2 | **Bronze(원본 gzip 보존) → Silver(long-format `measurement`) → Gold(롤업·에피소드·KPI·Finding)** 3층 구조 | 매핑·로직이 바뀌어도 bronze를 다시 처리(replay)할 수 있음 |
| 3 | 멱등성은 **3중**: `(gateway_id, batch_id)` 유니크 + `(point_id, ts)` PK `ON CONFLICT DO NOTHING` + 모든 잡을 upsert로 작성 | Vercel Cron 자체가 "중복 호출·누락 가능"을 공식 문서로 명시함 |
| 4 | 자산은 **site → system → asset → component → point** 한 테이블(`om.asset`, level 컬럼) + **메트릭 카탈로그(`om.metric_def`)** | 메트릭 추가 = INSERT 1줄이고 DDL은 필요 없음. 범위는 OPC UA의 EURange/InstrumentRange 개념을 차용 |
| 5 | 시계열은 **선언적 월 파티셔닝 + 자체 plpgsql 파티션 관리 함수**. pg_partman/pg_cron은 선택사항으로 둠 | RDS에서 둘 다 지원되지만 rds_superuser·파라미터 그룹 변경·재부팅이 필요하고, 로컬 Docker 공식 이미지에는 포함되지 않음 |
| 6 | 인덱스는 **PK B-tree `(point_id, ts)` + 파티션별 BRIN `(ts timestamptz_minmax_multi_ops)`** | 중복 제거와 포인트별 조회는 B-tree가 맡고, 전체 포인트 시간 슬라이스 조회는 BRIN(용량 극소)이 맡음 |
| 7 | 롤업은 **dirty-bucket 큐(gen 카운터)** 로 증분 갱신함. 닫힌 시간 버킷만 계산 | 지연 도착 데이터를 자연스럽게 반영하고 동시성에서도 유실되지 않음(4.3절 분석) |
| 8 | 마이그레이션은 **node-pg-migrate(순수 .sql 파일, advisory lock, 단일 트랜잭션)**, 쿼리는 **Kysely + kysely-codegen** | 파티션·BRIN opclass·부분 유니크 인덱스 등 SQL-first DDL이 많음. Drizzle은 파티션 DDL 미지원(이슈 #2854 open) |
| 9 | 분석 엔진은 **TypeScript 순수 함수**(시계 주입, 시드 RNG)로 짠다. 무거운 집계는 SQL, 통계는 gold 데이터 위에서 TS | 테스트 가능성과 Vercel Active CPU 비용을 동시에 챙김 |
| 10 | 핵심 탐지 방식은 **"에피소드 추출 → 조건 bin 매칭 기준선 → Theil–Sen/CUSUM → Finding(dedup_key, 근거 스냅샷)"** | 사용자가 든 예시(8h→7.5h 충전)를 정량 판정할 수 있는 일반형 |
| 11 | **Vercel Hobby는 상업적 이용 불가 + Cron 하루 1회**라서 회사 콘솔이면 **Pro 전환이 사실상 필요**함 | 공식 문서 기준. Pro는 Cron 분 단위, 함수 최대 800s |
| 12 | LLM seam은 **`ReportComposer` 인터페이스 + `EvidencePack` 스키마**. 템플릿 구현체를 먼저 만들고, LLM 구현체는 검증기(수치·인용 대조)를 통과할 때만 채택 | LLM에는 원시데이터가 아니라 계산 끝난 근거만 넘김 |
| 13 | 시뮬레이터는 **물리 근사 모델 + 고장/데이터 품질 시나리오 주입 + ground truth 테이블 + 평가 지표(재현율·오탐·탐지지연·크기오차)** | "최소 탐지 가능 크기 곡선"까지 뽑아 운영 기대치를 정할 수 있음 |

```mermaid
flowchart LR
  GW[사이트 게이트웨이\nModbus/SunSpec/IEC61850/OPC UA 수집] -->|HTTPS POST gzip+HMAC\nom.ingest.v1| ING[/api/ingest/v1\nVercel Function/]
  ING --> BR[(bronze\ningest_batch\n원본 gzip)]
  ING --> SV[(silver\nmeasurement\n월 파티션)]
  ING --> DQ1[rollup_dirty 큐]
  CRON[Vercel Cron\n5분/매시/매일] --> RU[롤업·DQ 잡]
  DQ1 --> RU --> G1[(gold\nm_1m/m_1h/m_1d)]
  CRON --> EP[에피소드·KPI 잡] --> G2[(episode\nkpi_daily)]
  CRON --> DET[탐지기 실행] --> F[(finding\n+evidence)]
  F --> PACK[EvidencePack] --> COMP{ReportComposer}
  COMP -->|template@1| RPT[(report draft)]
  COMP -.->|llm 나중에| RPT
  SIM[시뮬레이터\n+ground truth] -->|같은 봉투로 POST| ING
```

---

## 1. 수집 계약 (Ingest Envelope)

### 1.1 설계 원칙
1. **데이터 계약이 없어도 받는다.** 게이트웨이는 자기 태그명(`src`)과 단위(`unit`)만 보내면 되고, 서버의 `om.point.source_key`가 이를 표준 메트릭에 매핑함. 매핑되지 않은 태그는 `om.unmapped_source`에 자동 등록되고 원본은 bronze에 남음. 나중에 매핑하면 bronze를 replay해서 백필함.
2. **시계열은 series 인코딩**(포인트당 배열)으로 받음. 샘플마다 객체를 쓰는 것보다 페이로드가 수 배 작음.
3. **전송 계층과 무관하게** 설계함. 같은 봉투를 나중에 MQTT/AWS IoT Core/SQS로 옮겨도 서버 정규화 함수는 그대로 씀.

### 1.2 봉투 스키마 v1 (예시)
```json
{
  "schema": "om.ingest.v1",
  "gateway": "GW-JEJU01-A",
  "batch_id": "01923f6e-7c1a-7b1e-9a4e-2f1c3d5e7a90",
  "seq": 182340,
  "sent_at": "2026-09-14T03:05:00.120Z",
  "clock": { "ntp_synced": true, "ntp_offset_ms": -12 },
  "buffer": { "pending_batches": 0, "oldest_pending_ts": null },
  "series": [
    { "src": "PCS1/AC_P", "unit": "W",  "t0": 1757818800000, "dt": 60000, "v": [512300, 515100, null, 509800], "q": [0,0,1,0] },
    { "src": "BMS1/RACK03/SOC", "unit": "%", "ts": [1757818805000, 1757818866000], "v": [81.2, 81.4] },
    { "src": "ELZ1/STACK1/V", "unit": "V", "t0": 1757818800000, "dt": 10000, "v": [412.1, 412.3, 412.0] }
  ],
  "events": [
    { "src": "PCS1/FAULT", "ts": 1757818930000, "code": "E023", "severity": "major", "text": "DC overvoltage" }
  ],
  "meta": { "fw": "1.4.2", "collector": "modbus-sunspec" }
}
```
- `batch_id`: 게이트웨이가 만드는 **UUIDv7**(시간 정렬 가능). 재전송할 때도 **같은 값**을 씀.
- `seq`: 게이트웨이 단조 증가 카운터. 서버는 누락 배치(gap)를 감지하는 데만 쓰고 순서를 강제하지 않음.
- `t0+dt`(정주기) 또는 `ts[]`(비정주기) 중 하나. 결측은 `null`. `q`는 장비 품질코드(0=정상).
- `events`: 알람·고장코드 같은 이산 이벤트. 별도 테이블 `om.event_log`로 들어감.

### 1.3 인증: 게이트웨이별 키 + HMAC-SHA256 (Stripe 웹훅 방식 차용)
헤더:
```
X-OM-Key-Id: gk_jeju01a_2026q3
X-OM-Timestamp: 1757819100            (unix seconds)
X-OM-Signature: v1=<hex(HMAC_SHA256(secret, keyId + "." + timestamp + "." + sha256hex(rawBody)))>
Content-Encoding: gzip
Content-Type: application/json
```
- 서명 대상은 **압축된 원본 바이트의 해시**임. 그래서 **검증을 먼저 하고 압축은 나중에 푼다**(압축 폭탄 방어 순서).
- 허용 오차 **±300초**(Stripe 라이브러리 기본값 5분과 동일). 벗어나면 401을 주고 `X-OM-Server-Time` 헤더로 서버 시각을 알려 게이트웨이가 재동기화하게 함.
- 비교는 `timingSafeEqual`로 함. 키 회전을 위해 게이트웨이당 **활성 키 2개**를 허용함(`om.gateway_key`).
- HMAC을 검증하려면 서버가 비밀 원문을 알아야 함. 그래서 `secret_enc`(앱 마스터키 `INGEST_KEY_ENC_KEY`로 AES-256-GCM 암호화)로 저장함. 더 단순한 대안은 "Bearer API 키(SHA-256 해시 저장) + TLS"이지만 본문 무결성과 재전송 방지가 약함. 재전송 자체는 batch_id 멱등성으로 무해하게 처리됨.

```ts
// lib/ingest/signature.ts (스케치)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_S = 300;

export function signingString(keyId: string, ts: string, rawBody: Uint8Array): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${keyId}.${ts}.${bodyHash}`;
}

export function computeSignature(secret: Uint8Array, keyId: string, ts: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(signingString(keyId, ts, rawBody)).digest('hex');
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

export function verify(
  h: { keyId?: string | null; ts?: string | null; sig?: string | null },
  secrets: readonly Uint8Array[],            // 활성 키 1~2개
  rawBody: Uint8Array,
  nowS: number,
): VerifyResult {
  if (!h.keyId || !h.ts || !h.sig?.startsWith('v1=')) return { ok: false, reason: 'missing_headers' };
  const tsNum = Number(h.ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowS - tsNum) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: 'stale_timestamp' };
  const given = Buffer.from(h.sig.slice(3), 'hex');
  const match = secrets.some((s) => {
    const expected = Buffer.from(computeSignature(s, h.keyId!, h.ts!, rawBody), 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  return match ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
```

### 1.4 멱등성: 3단계
| 층 | 메커니즘 | 동작 |
|---|---|---|
| 배치 | `UNIQUE (gateway_id, batch_id)` + `body_sha256` | 같은 id·같은 해시면 **200 `{status:"duplicate"}`**, 같은 id·다른 해시면 **409** |
| 샘플 | `PRIMARY KEY (point_id, ts)` + `ON CONFLICT DO NOTHING` | 부분 재전송이나 batch_id를 새로 만든 재전송도 흡수함. 첫 값이 이김. 정정 데이터는 별도 `revision` 경로(추후)로 받음 |
| 파생 | 롤업·에피소드·KPI·Finding 모두 **자연키 upsert** | 잡을 두 번 돌려도 결과가 같음 |

### 1.5 지연 도착(late data)과 시계 오차
- 서버는 `received_at`을 기록하고 `skew_ms = received_at − sent_at`을 계산해 게이트웨이별 이동 중앙값을 `om.gateway.clock_offset_ms`에 저장함.
- **수용 창**: `now − raw_retention ≤ ts ≤ received_at + 5분`.
  - 미래 시각(>+5분)이면 샘플을 거부하고 `n_rejected`에 집계, DQ Finding "게이트웨이 시계 오차"를 올림.
  - 보존기간보다 오래되면 silver에 넣지 않고 bronze에만 남기며 `status='partial'`.
- **자동 보정은 하지 않음.** 게이트웨이가 `clock.ntp_synced=false`이거나 |skew|가 120초를 넘으면 샘플 `quality`에 `CLOCK_SUSPECT` 비트를 세우고, 분석 단계에서 제외하거나 가중치를 낮춤. 원시 ts를 몰래 고치면 나중에 원인 추적이 불가능해짐.
- 도착 지연이 1시간을 넘는 샘플은 `LATE` 비트를 세움(모니터링용). 해당 버킷은 dirty 큐로 재계산되고, 분석 워터마크를 되감음(5.3절).
- 오프라인 복구 시 게이트웨이는 **오래된 배치부터 순차 전송**하고, 429/503이면 `Retry-After`만큼 기다린 뒤 지수 백오프함.

### 1.6 배치 크기와 전송 빈도
- Vercel Functions 요청 본문 한도는 **4.5MB**(초과 시 413 `FUNCTION_PAYLOAD_TOO_LARGE`). 권장 상한은 **압축 후 1MB 이하 또는 샘플 5,000개 이하**. 서버는 압축 해제 후 20MB를 넘으면 거부함(`zlib.gunzipSync(buf, { maxOutputLength })`).
- 빈도별 호출 수(30개 사이트, 게이트웨이 1대씩):

| flush 주기 | 배치당 샘플(500포인트@1분) | 월 호출 수 | 비고 |
|---|---|---|---|
| 1분 | 500 | ~1,296,000 | Hobby 포함량(월 100만 호출) 초과 |
| **5분(권장 기본)** | 2,500 | ~259,200 | 원본 JSON 약 110KB, gzip 약 10~20KB 추정 |
| 15분 | 7,500 | ~86,400 | 실시간성 낮음 |

- 응답 코드 계약: `200`(수용·중복 포함, 본문에 `accepted/duplicate/rejected/unmapped` 카운트), `400`(스키마 오류, 재시도 금지), `401`(인증/시계), `409`(batch_id 재사용 충돌), `413`(분할 후 재전송), `429/503`(재시도).

```ts
// lib/ingest/envelope.ts (zod 4 스케치)
import { z } from 'zod';

const Series = z.object({
  src: z.string().min(1).max(200),
  unit: z.string().max(32).optional(),
  t0: z.number().int().optional(),
  dt: z.number().int().positive().optional(),
  ts: z.array(z.number().int()).max(20_000).optional(),
  v: z.array(z.number().finite().nullable()).max(20_000),
  q: z.array(z.number().int().min(0).max(65535)).optional(),
}).refine((s) => (s.ts ? s.ts.length === s.v.length : s.t0 !== undefined && s.dt !== undefined),
          { message: 'ts[] 또는 t0+dt 중 하나가 필요하고 길이가 v와 같아야 함' })
  .refine((s) => !s.q || s.q.length === s.v.length, { message: 'q 길이 불일치' });

export const IngestEnvelopeV1 = z.object({
  schema: z.literal('om.ingest.v1'),
  gateway: z.string().min(1).max(64),
  batch_id: z.uuid(),
  seq: z.number().int().nonnegative().optional(),
  sent_at: z.iso.datetime(),
  clock: z.object({ ntp_synced: z.boolean(), ntp_offset_ms: z.number().optional() }).optional(),
  series: z.array(Series).max(5_000),
  events: z.array(z.object({
    src: z.string().max(200), ts: z.number().int(), code: z.string().max(64),
    severity: z.enum(['info', 'minor', 'major', 'critical']).optional(), text: z.string().max(500).optional(),
  })).max(5_000).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type IngestEnvelopeV1 = z.infer<typeof IngestEnvelopeV1>;
```

```ts
// lib/ingest/normalize.ts: 순수 함수. DB나 시계에 의존하지 않음
export const Q = { DEVICE_BAD: 1, HARD_RANGE: 2, SPIKE: 4, FLATLINE: 8, CLOCK_SUSPECT: 16, LATE: 32, UNIT_CONVERTED: 64 } as const;

export interface PointBinding {
  pointId: number; metricUnit: string; scale: number; offset: number;
  hardMin: number | null; hardMax: number | null;
}
export interface NormalizedRows {
  pointIds: number[]; ts: Date[]; values: number[]; quality: number[];
  unmapped: ReadonlyArray<{ src: string; unit?: string; count: number }>;
  rejected: ReadonlyArray<{ src: string; reason: 'future_ts' | 'too_old' | 'non_finite'; count: number }>;
}

export function normalizeEnvelope(
  env: IngestEnvelopeV1,
  bindings: ReadonlyMap<string, PointBinding>,   // key = src
  ctx: { receivedAtMs: number; minTsMs: number; clockSuspect: boolean },
): NormalizedRows {
  // 1) series를 (ts, v, q)로 전개  2) 매핑이 없으면 unmapped 집계
  // 3) scale/offset 단위 변환  4) 수용 창 밖이면 rejected
  // 5) hard 범위 이탈이면 값은 보존하고 Q.HARD_RANGE 비트
  // 6) 같은 (pointId, ts) 중복은 첫 값만 남김
  // 반환 배열은 새로 생성함(입력 불변)
  throw new Error('sketch');
}
```

### 1.7 Bronze / Silver / Gold 정의
| 층 | 테이블 | 내용 | 보존 |
|---|---|---|---|
| Bronze | `om.ingest_batch` | 요청 원본 gzip 바이트, 헤더 요약, 해시, 처리 통계·상태 | 90일(권장), 필요 시 S3로 이관 |
| Silver | `om.measurement`, `om.event_log` | 정규화된 long-format 값 + 품질 비트 | 원시 3~6개월(3.5절) |
| Gold | `om.m_1m`(부분), `om.m_1h`, `om.m_1d`, `om.episode`, `om.kpi_daily`, `om.finding*`, `om.report` | 집계, 운전 에피소드 특징값, 일 KPI, 발견사항, 리포트 | 영구 |

**중요한 설계 포인트**: 장기 "조건 맞춘 과거 대비" 비교는 원시가 아니라 **에피소드 특징값(gold, 영구 보존)** 으로 함. 그래서 원시 보존기간을 짧게 잡아도 수년 단위 비교가 가능함. 단, 탐지 로직을 바꿔 과거 재추출이 필요할 때를 대비해 원시 파티션을 삭제 전에 S3로 아카이브하는 옵션을 권장함.

```sql
-- bronze: 행 수가 적어(월 ~26만) 파티션 없이 시작. 보존은 일일 DELETE(청크 단위)로 처리
CREATE TABLE om.ingest_batch (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_id    smallint    NOT NULL REFERENCES om.gateway(id),
  batch_id      uuid        NOT NULL,
  gw_seq        bigint,
  sent_at       timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  skew_ms       integer,
  key_id        text        NOT NULL,
  body_sha256   bytea       NOT NULL,
  body_gzip     bytea       NOT NULL,
  n_samples     integer, n_accepted integer, n_duplicate integer, n_rejected integer, n_unmapped integer,
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','normalized','partial','failed')),
  error         text,
  UNIQUE (gateway_id, batch_id)
);
CREATE INDEX ingest_batch_received_brin ON om.ingest_batch USING brin (received_at);
```

---

## 2. 자산 모델과 메트릭 카탈로그

### 2.1 계층 매핑 (표준에서 차용할 것)
| 본 설계 레벨 | ISA-95(IEC 62264) | ISO 14224 분류 | Project Haystack | Brick | 예시 |
|---|---|---|---|---|---|
| (enterprise) | Enterprise | L1~L2 | - | - | 회사 |
| **site** | Site | L3 Installation | `site` | Location(Site) | 제주1 발전소 |
| **system** | Area / Work Center | L5 Section/System | `equip`(상위) | Equipment 묶음 | ESS#1, 수전해 플랜트, 수소저장 |
| **asset** | Work Unit | L6 Equipment Unit | `equip` + `equipRef` | Equipment | PCS#2, 배터리랙#3, 전해조#1, 연료전지#1 |
| **component** | (ISA-88 Equipment Module) | L7 Subunit / L8 Maintainable Item | `equip`(하위) | Equipment `hasPart` | 냉각팬, 셀스택, 공기 블로워, 밸브 |
| **point** | (Control Module / 태그) | - | `point` + `sensor/cmd/sp`, `his`, `unit`, `kind` | Point `isPointOf` | 스택전압, 셀최고온도 |

차용 포인트:
- **ISO 14224**: 레벨 6~8(장비단위/하위단위/정비가능품목)이 "부품 단위 코칭"과 정확히 맞음. 고장모드 코드 체계를 `failure_mode` 어휘의 참고로 쓰면 정비 이력 분석(MTBF 등)으로 확장하기 쉬움.
- **IEC 61850-7-420 논리노드 명칭**을 `asset_class.iec61850_ln`에 참조로 둠: `ZINV`(인버터), `ZBAT`(배터리), `ZBTC`(배터리 충전기), `DPVM`(PV 모듈 정격), 연료전지 `DFCL`(컨트롤러)·`DSTK`(스택)·`DFPM`(연료처리모듈). 측정 데이터 객체 명명은 `MMXU`의 `TotW`, `Hz`, `PhV`, `A` 스타일을 참고함.
- **SunSpec 모델**: 1(Common), 101~103/111~113(인버터), 160(MPPT), 701~(DER, IEEE 1547-2018), 802(Battery Base), 803(Lithium-ion Bank). 게이트웨이가 SunSpec Modbus를 쓰면 `metric_def.aliases.sunspec`(예: `"802.SoC"`)로 **자동 매핑 후보를 제안**할 수 있음.
- **OPC UA AnalogItemType**: `EURange`(정상 운전 범위), `InstrumentRange`(계측기가 낼 수 있는 범위), `EngineeringUnits`(UNECE Rec.20 단위코드). 본 설계의 `expected_min/max`와 `hard_min/max`가 이 두 개념에 그대로 대응함.
- **Haystack/Brick**: 마커 태그(`tags text[]`)와 관계(hasPart/isPointOf/feeds)만 가볍게 차용함. 온톨로지(RDF) 도입은 과함.
- **수소 설비**: 표준 데이터 모델이 아직 성숙하지 않음. VDMA/H2 Giga eModule에서 전해조 모듈의 OPC UA + MTP(Module Type Package) 통합이 진행 중이므로 벤더 태그를 수용하는 유연 카탈로그가 현실적임.

### 2.2 명명 규칙
- **asset_class 키**: `<domain>.<equipment>[.<part>]` 소문자·점 구분. 예: `pv.array`, `pv.string`, `pv.inverter`, `pv.inverter.fan`, `ess.pcs`, `ess.battery.rack`, `ess.battery.module`, `h2.electrolyzer`, `h2.electrolyzer.stack`, `h2.compressor`, `h2.tank`, `h2.fuelcell`, `h2.fuelcell.stack`, `h2.fuelcell.blower`, `met.station`.
- **metric 키**: `<phenomenon>.<quantity>[.<qualifier>]`. 예: `elec.ac.power.active`, `elec.dc.voltage`, `elec.dc.current`, `elec.energy.export`(counter), `batt.soc`, `batt.soh.reported`, `temp.cell.max`, `temp.heatsink`, `irr.poa`, `h2.flow.mass`, `h2.pressure`, `stack.voltage`, `cell.voltage.avg`, `air.flow`, `vib.rms`, `state.operating`(enum).
- **point 고유성**: `(asset_id, metric_key, qualifier)`. qualifier는 `phase_a`, `string_07`, `cell_max` 등.
- **자산 코드 경로**: `KR-JEJU01/ESS1/RACK03` 형태 materialized path. 리포트 가독성과 LLM 근거 팩에서 그대로 쓸 수 있음.
- **단위**: 카탈로그는 정규 단위(UCUM 표기 권장: `V`, `A`, `kW`, `kW.h`, `%`, `Cel`, `bar`, `kg/h`) 하나만 갖고, 포인트별 `source_unit + scale/offset`으로 변환함.

### 2.3 스키마 스케치
```sql
CREATE SCHEMA IF NOT EXISTS om;

CREATE TABLE om.site (
  id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text NOT NULL UNIQUE,                 -- 'KR-JEJU01'
  name       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'Asia/Seoul',
  lat        double precision, lon double precision,
  attributes jsonb NOT NULL DEFAULT '{}'          -- 계통연계용량, 출력제어 대상 여부 등
);

CREATE TABLE om.asset_class (
  key            text PRIMARY KEY,               -- 'ess.battery.rack'
  level          text NOT NULL CHECK (level IN ('system','asset','component')),
  parent_key     text REFERENCES om.asset_class(key),
  iec61850_ln    text,                            -- 'ZBAT'
  iso14224_hint  text,
  default_tags   text[] NOT NULL DEFAULT '{}',
  nameplate_schema jsonb NOT NULL DEFAULT '{}',   -- 클래스별 필수 명판값 JSON Schema (rated_kw, capacity_ah ...)
  description    text
);

CREATE TABLE om.asset (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id         smallint NOT NULL REFERENCES om.site(id),
  parent_id       integer REFERENCES om.asset(id),
  level           text NOT NULL CHECK (level IN ('system','asset','component')),
  class_key       text NOT NULL REFERENCES om.asset_class(key),
  code            text NOT NULL,                  -- 'ESS1.RACK03'
  path            text NOT NULL,                  -- 'KR-JEJU01/ESS1/RACK03'
  name            text NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  nameplate       jsonb  NOT NULL DEFAULT '{}',   -- {"capacity_ah":280,"cells_series":240,"manufacturer":"..","model":".."}
  criticality     smallint NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 5),
  peer_group      text,                            -- 동종 비교 그룹 키 (같은 모델·같은 사이트)
  commissioned_at date,
  decommissioned_at date,
  UNIQUE (site_id, code)
);
CREATE INDEX asset_parent_idx ON om.asset (parent_id);
CREATE INDEX asset_tags_gin   ON om.asset USING gin (tags);

CREATE TABLE om.metric_def (
  key               text PRIMARY KEY,
  quantity          text NOT NULL,                 -- 'voltage','power','soc'
  unit              text NOT NULL,                 -- 정규 단위
  value_kind        text NOT NULL CHECK (value_kind IN ('gauge','counter','state','bool')),
  rollup            text NOT NULL CHECK (rollup IN ('twa','mean','sum','delta','integral','last','max','min','state_duration')),
  hard_min double precision, hard_max double precision,          -- ≈ OPC UA InstrumentRange
  expected_min double precision, expected_max double precision,  -- ≈ OPC UA EURange
  max_rate_per_s    double precision,              -- 스파이크(변화율) 한계
  flatline_tol      double precision,              -- 고착 판정 허용 변동
  flatline_max_s    integer,                       -- 이 시간 이상 변동 없으면 고착 의심
  nominal_period_s  integer NOT NULL DEFAULT 60,
  aliases           jsonb NOT NULL DEFAULT '{}',   -- {"sunspec":"802.SoC","iec61850":"ZBAT...","haystack":["battery","soc","sensor"]}
  description       text
);

CREATE TABLE om.gateway (
  id               smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id          smallint NOT NULL REFERENCES om.site(id),
  code             text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_seen_at     timestamptz,
  last_seq         bigint,
  clock_offset_ms  integer
);

CREATE TABLE om.gateway_key (
  key_id      text PRIMARY KEY,
  gateway_id  smallint NOT NULL REFERENCES om.gateway(id),
  secret_enc  bytea NOT NULL,                      -- AES-256-GCM(iv||tag||ciphertext)
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE TABLE om.point (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id      integer  NOT NULL REFERENCES om.asset(id),
  metric_key    text     NOT NULL REFERENCES om.metric_def(key),
  qualifier     text     NOT NULL DEFAULT '',
  gateway_id    smallint REFERENCES om.gateway(id),
  source_key    text,
  source_unit   text,
  scale         double precision NOT NULL DEFAULT 1,
  value_offset  double precision NOT NULL DEFAULT 0,
  period_s      integer,                           -- NULL이면 metric_def.nominal_period_s
  expected_min  double precision, expected_max double precision,   -- 포인트별 오버라이드
  enabled       boolean NOT NULL DEFAULT true,
  valid_from    timestamptz NOT NULL DEFAULT '-infinity',          -- 센서 교체·재매핑 이력
  UNIQUE (asset_id, metric_key, qualifier),
  UNIQUE (gateway_id, source_key)
);

CREATE TABLE om.unmapped_source (
  gateway_id    smallint NOT NULL REFERENCES om.gateway(id),
  source_key    text NOT NULL,
  unit          text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  sample_count  bigint NOT NULL DEFAULT 0,
  suggestion    jsonb,                             -- 별칭 사전 기반 매핑 후보
  PRIMARY KEY (gateway_id, source_key)
);
```

### 2.4 "스키마 변경 없이 메트릭 추가" 운영 절차
1. 게이트웨이가 새 태그를 보내기 시작하면 `unmapped_source`에 자동으로 쌓이고 콘솔에 "미매핑 태그"로 뜸.
2. 관리자가 `metric_def`(없으면 1행 INSERT)와 `point`(자산·메트릭·source_key·단위 변환)를 등록함.
3. 백필 잡이 `ingest_batch`에서 해당 게이트웨이의 `first_seen_at` 이후 배치를 **replay**함. `ON CONFLICT DO NOTHING` 덕분에 안전함.
4. 탐지기는 `requiredMetrics`를 선언하고, 자산에 그 포인트가 있을 때만 활성화됨. 코드 배포 없이도 데이터가 들어오면 기존 탐지기가 자동으로 붙음.

---

## 3. RDS PostgreSQL(TimescaleDB 없음) 시계열 저장

### 3.1 용량 추정 (분석 추정치, 로컬에서 실측 필요)
가정: `measurement(ts timestamptz, value float8, point_id int4, quality int2)` → 튜플 헤더 24B + 데이터 24B(정렬) + 라인 포인터 4B ≈ **52B/행**(페이지당 ~157행). PK B-tree `(point_id, ts)` 엔트리 약 28B, 리프 채움 90%. WAL·백업·복제·bloat는 제외.

| 시나리오 | 샘플/일 | 힙+PK GB/일 | GB/월 | GB/년 |
|---|---|---|---|---|
| A: 30사이트 × 500포인트 × 1분 | 21.6M | ~1.7 | ~50 | ~610 |
| B: 30 × (200포인트@1분 + 300포인트@5분) | 11.2M | ~0.87 | ~26 | ~320 |
| C: 30 × 2,000포인트 × 1분(셀 단위 데이터 포함 확장) | 86.4M | ~6.7 | ~200 | ~2,450 |
| 1h 롤업(A 기준, ~100B/행 + PK) | 360k | ~0.044 | ~1.3 | ~16 |
| 1d 롤업 | 15k | - | - | ~0.7 |
| bronze gzip(5분 배치 ~15KB 가정) | 8,640 배치 | ~0.13 | ~3.9 | 90일 보존 ≈ 12 |

- `batch_id int4` 계보 컬럼을 추가하면 정렬 때문에 행당 +8B(약 +15%)가 됨. "잘못된 배치 되돌리기"가 필요하면 추가하고, 아니면 bronze 해시로 대체함.
- **시나리오 C(셀 전압 수천 포인트)는 RDS 단일 인스턴스의 경계선**임. 셀 단위는 원시로 저장하지 말고 게이트웨이/수집 단계에서 `max/min/avg/spread` 통계 포인트로 축약하는 것을 권장함. 필요하면 이상 발생 전후 구간만 고해상도로 보냄.
- 쓰기 부하는 A 기준 평균 250행/초로 PostgreSQL에 가벼움. 병목은 **스토리지 비용과 vacuum/백업 시간**임.
- 검증 액션: 로컬 Docker에서 100만 행을 넣고 `pg_total_relation_size`로 행당 바이트를 실측한 뒤 표를 보정. (이번 조사 시점에는 Docker 데몬이 꺼져 있어 실측하지 못함.)

### 3.2 파티셔닝
- **원시 `measurement`: 월 파티션(UTC 기준 경계)**. A 기준 파티션당 ~50GB. 보존은 파티션 DROP 한 번으로 끝남.
- **`m_1m`**(1분 미만 주기 포인트만): 월 파티션, 13개월 보존. **`m_1h`**: 연 파티션. **`m_1d`**: 파티션 없음.
- 파티션 관리 도구:

| 옵션 | RDS | 로컬 Docker | 판단 |
|---|---|---|---|
| **자체 plpgsql 함수 + 일일 잡 호출** | O | O | **권장.** 확장·권한·재부팅이 필요 없고 두 환경이 완전히 동일함 |
| pg_partman + pg_cron | 지원(PG 12.5+). 단 `rds_superuser`, pg_cron은 `shared_preload_libraries` 파라미터 그룹 변경 + **인스턴스 재시작** 필요 | 공식 `postgres` 이미지에 없음 → 커스텀 이미지 필요 | 기존 운영 RDS를 재부팅할 수 있고 파티션 테이블이 많아질 때 고려 |

```sql
-- 원시 테이블
CREATE TABLE om.measurement (
  ts        timestamptz      NOT NULL,
  value     double precision NOT NULL,
  point_id  integer          NOT NULL,
  quality   smallint         NOT NULL DEFAULT 0,
  PRIMARY KEY (point_id, ts)
) PARTITION BY RANGE (ts);
-- FK(point)는 의도적으로 생략: 하루 수천만 건 삽입의 FK 검사 비용을 피하고 정합성은 수집기 매핑이 보장

-- 안전망: 파티션이 없을 때 삽입 실패 대신 default로 받고 알람(비어있지 않으면 경고)
CREATE TABLE om.measurement_default PARTITION OF om.measurement DEFAULT;

CREATE OR REPLACE FUNCTION om.ensure_monthly_partitions(
  p_schema text, p_table text, p_months_back int DEFAULT 1, p_months_ahead int DEFAULT 3)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_month  timestamp;
  v_name   text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_made   integer := 0;
BEGIN
  FOR i IN -p_months_back .. p_months_ahead LOOP
    v_month := date_trunc('month', (now() AT TIME ZONE 'UTC')) + make_interval(months => i);
    v_name  := format('%s_p%s', p_table, to_char(v_month, 'YYYYMM'));
    v_from  := v_month AT TIME ZONE 'UTC';
    v_to    := (v_month + interval '1 month') AT TIME ZONE 'UTC';
    IF to_regclass(format('%I.%I', p_schema, v_name)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
                     p_schema, v_name, p_schema, p_table, v_from, v_to);
      -- 파티션별 BRIN (부모에 만들어도 전파되지만, pages_per_range 등 튜닝을 명시)
      EXECUTE format('CREATE INDEX %I ON %I.%I USING brin (ts timestamptz_minmax_multi_ops) WITH (pages_per_range = 64, autosummarize = on)',
                     v_name || '_ts_brin', p_schema, v_name);
      v_made := v_made + 1;
    END IF;
  END LOOP;
  RETURN v_made;
END $$;

-- 보존: 명명 규칙(_pYYYYMM) 기반. 락 대기 폭주를 막기 위해 lock_timeout과 함께 호출
CREATE OR REPLACE FUNCTION om.drop_monthly_partitions_before(
  p_schema text, p_table text, p_keep_months int)
RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff text := to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_keep_months), 'YYYYMM');
  r record;
  v_dropped text[] := '{}';
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c  ON c.oid = i.inhrelid
    JOIN pg_class pc ON pc.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = pc.relnamespace
    WHERE n.nspname = p_schema AND pc.relname = p_table
      AND c.relname ~ ('^' || p_table || '_p[0-9]{6}$')
      AND right(c.relname, 6) < v_cutoff
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', p_schema, p_table, p_schema, r.relname);
    EXECUTE format('DROP TABLE %I.%I', p_schema, r.relname);   -- RDS면 DROP 전에 aws_s3 내보내기 옵션
    v_dropped := v_dropped || r.relname;
  END LOOP;
  RETURN v_dropped;
END $$;
-- 호출 예: SET lock_timeout = '5s'; SELECT om.drop_monthly_partitions_before('om','measurement', 6);
```
주의: `DETACH PARTITION CONCURRENTLY`는 트랜잭션 블록 안에서 쓸 수 없어서 함수 안에서는 일반 DETACH를 씀. 부모에 짧게 강한 락이 걸리므로 `lock_timeout`을 걸고 새벽에 실행함.

### 3.3 인덱스: BRIN vs B-tree
| 인덱스 | 용도 | 비고 |
|---|---|---|
| **PK B-tree `(point_id, ts)`** | 멱등 삽입(ON CONFLICT), 포인트별 구간 조회, 롤업 계산 | 필수. 용량은 힙의 약 60% |
| **BRIN `(ts timestamptz_minmax_multi_ops)`** | "사이트 전체 포인트의 특정 시간대" 스캔, DQ 일괄 스윕, 내보내기 | 수백 KB 수준. 지연 도착과 게이트웨이 교차 삽입 때문에 물리 순서 상관이 완벽하지 않으므로 PG14+ **minmax-multi** 사용. `autosummarize=on`이 아니면 새 블록 범위가 요약되지 않아 항상 스캔됨 |
| ts 단독 B-tree | 사용 안 함 | PK와 중복이고 용량이 2배가 됨 |

BRIN은 물리 저장 순서와 컬럼 값의 상관이 높을 때(대략 0.9 이상 이상적) 효과적이고, 삽입 순서가 흐트러지면 급격히 비효율적이 됨. 파티션별로 `pg_stats.correlation`을 모니터링함.

### 3.4 롤업 갱신 전략: dirty-bucket 큐 + gen 카운터
**왜 이 방식인가**: "마지막 처리 시각" 워터마크만 쓰면 늦게 도착한 데이터가 누락됨. Materialized view 전체 REFRESH는 너무 비쌈. 그래서 삽입 트랜잭션 안에서 **영향받은 (point, hour)만 dirty로 표시**하고, 잡이 **닫힌 버킷**만 재계산함.

```sql
CREATE TABLE om.rollup_dirty (
  point_id   integer     NOT NULL,
  bucket     timestamptz NOT NULL,     -- date_bin('1 hour', ts, '2000-01-01')
  gen        bigint      NOT NULL DEFAULT 1,
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, bucket)
);

CREATE TABLE om.m_1h (
  point_id  integer     NOT NULL,
  bucket    timestamptz NOT NULL,
  n         integer NOT NULL,           -- 전체 샘플
  n_good    integer NOT NULL,           -- 품질 통과 샘플
  v_min double precision, v_max double precision, v_avg double precision,
  v_first double precision, v_last double precision, v_sum double precision,
  v_std double precision,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, bucket)
) PARTITION BY RANGE (bucket);
```

**수집 트랜잭션**(한 SQL 문, data-modifying CTE):
```sql
WITH ins AS (
  INSERT INTO om.measurement (point_id, ts, value, quality)
  SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::float8[], $4::int2[])
  ON CONFLICT (point_id, ts) DO NOTHING
  RETURNING point_id, ts
), dirty AS (
  INSERT INTO om.rollup_dirty AS d (point_id, bucket)
  SELECT DISTINCT point_id, date_bin('1 hour', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') FROM ins
  ON CONFLICT (point_id, bucket) DO UPDATE SET gen = d.gen + 1, touched_at = now()
)
SELECT count(*)::int AS inserted FROM ins;
```
- `RETURNING` 기반이라 **중복 재전송은 dirty를 만들지 않음.**
- `unnest` 배열 바인딩이라 파라미터 개수 한도(65,535)와 무관함.

**롤업 잡**(닫힌 버킷만, 한 문장으로 계산과 삭제):
```sql
WITH picked AS (
  SELECT point_id, bucket, gen
  FROM om.rollup_dirty
  WHERE bucket + interval '1 hour' <= now() - interval '5 minutes'   -- 닫힌 시간만
  ORDER BY bucket
  LIMIT $1
), agg AS (
  SELECT p.point_id, p.bucket,
         count(m.*)                                        AS n,
         count(m.*) FILTER (WHERE (m.quality & 31) = 0)     AS n_good,
         min(m.value) FILTER (WHERE (m.quality & 31) = 0)   AS v_min,
         max(m.value) FILTER (WHERE (m.quality & 31) = 0)   AS v_max,
         avg(m.value) FILTER (WHERE (m.quality & 31) = 0)   AS v_avg,
         (array_agg(m.value ORDER BY m.ts)      FILTER (WHERE (m.quality & 31) = 0))[1] AS v_first,
         (array_agg(m.value ORDER BY m.ts DESC) FILTER (WHERE (m.quality & 31) = 0))[1] AS v_last,
         sum(m.value)    FILTER (WHERE (m.quality & 31) = 0) AS v_sum,
         stddev_samp(m.value) FILTER (WHERE (m.quality & 31) = 0) AS v_std
  FROM picked p
  JOIN om.measurement m
    ON m.point_id = p.point_id AND m.ts >= p.bucket AND m.ts < p.bucket + interval '1 hour'
  GROUP BY p.point_id, p.bucket
), up AS (
  INSERT INTO om.m_1h AS r (point_id, bucket, n, n_good, v_min, v_max, v_avg, v_first, v_last, v_sum, v_std, computed_at)
  SELECT point_id, bucket, n, n_good, v_min, v_max, v_avg, v_first, v_last, v_sum, v_std, now() FROM agg
  ON CONFLICT (point_id, bucket) DO UPDATE SET
    n = EXCLUDED.n, n_good = EXCLUDED.n_good, v_min = EXCLUDED.v_min, v_max = EXCLUDED.v_max,
    v_avg = EXCLUDED.v_avg, v_first = EXCLUDED.v_first, v_last = EXCLUDED.v_last,
    v_sum = EXCLUDED.v_sum, v_std = EXCLUDED.v_std, computed_at = now()
), day_dirty AS (
  INSERT INTO om.rollup_dirty_day (point_id, day)
  SELECT DISTINCT p.point_id, (p.bucket AT TIME ZONE 'Asia/Seoul')::date FROM picked p
  ON CONFLICT DO NOTHING
)
DELETE FROM om.rollup_dirty d
USING picked p
WHERE d.point_id = p.point_id AND d.bucket = p.bucket AND d.gen = p.gen;
```
**동시성 정합성 분석**(READ COMMITTED):
- 잡이 스냅샷을 잡은 뒤 커밋된 수집이 같은 버킷 dirty를 `gen+1`로 올리면, 잡의 DELETE가 행 재검사(EvalPlanQual)에서 `gen` 불일치를 발견해 **삭제하지 않음** → 다음 주기에 재계산됨.
- 수집이 아직 커밋 전이고 dirty 행을 잠그고 있으면 DELETE는 대기하고, 커밋 후 재검사에서 불일치 → 유지됨.
- 잡이 먼저 삭제를 커밋하면 이후 수집은 새 dirty 행을 INSERT함 → 재계산됨.
- 결과적으로 **어떤 순서로 겹쳐도 새 데이터가 롤업에서 영구 누락되지 않음**. 잡 동시 실행은 5.3절 lease로 막음. 막지 못해도 upsert라 결과는 같음.

집계 의미론은 `metric_def.rollup`을 따름:
- `twa`(시간가중 평균: 비정주기 게이지): `lead()`로 구간 길이 가중 계산
- `delta`(누적 kWh 카운터): `last − first`, 역행하면 리셋으로 처리
- `integral`(kW → kWh): 사다리꼴 적분
- `state_duration`(운전모드별 체류시간): `jsonb` 확장 컬럼
- 1일 롤업은 `m_1h`에서 계산함. 사이트 타임존(Asia/Seoul, DST 없음)이라 24개 시간 버킷이 그대로 하루임.
- `m_1m`은 **주기 60초 미만 포인트에만** 둠. 1분 주기 원시는 그 자체가 1분 해상도이므로 중복 저장하지 않음.

### 3.5 보존 정책(권장 기본값, 비용 확정 후 조정)
| 데이터 | 보존 | 방법 |
|---|---|---|
| bronze `ingest_batch` | 90일 | 일일 청크 DELETE (`WHERE received_at < now()-'90 days' LIMIT 5000` 반복) |
| 원시 `measurement` | **6개월**(스토리지가 부족하면 3개월) | 월 파티션 DROP, 선택적으로 `aws_s3` 확장으로 S3에 내보낸 뒤 DROP |
| `event_log` | 5년 | 월 파티션 |
| `m_1m` | 13개월 | 월 파티션 |
| `m_1h`, `m_1d`, `episode`, `kpi_daily`, `finding*`, `report` | 영구 | - |
| `rollup_dirty`, `job_run` | 30일 | DELETE |

### 3.6 마이그레이션 도구
| 도구 | 파티션/BRIN/plpgsql | 로컬↔RDS 동일성 | 잠금/트랜잭션 | 판단 |
|---|---|---|---|---|
| **node-pg-migrate 9.x** | 순수 `.sql` 파일 지원(`migration-file-language sql`) | 동일(`DATABASE_URL`) | **advisory lock 기본**, 기본 `single-transaction` | **권장**: PostgreSQL 전용이고 SQL-first |
| Kysely Migrator 0.29 | TS 파일 안 `sql` 태그로 가능 | 동일 | DB 레벨 락으로 동시 실행 직렬화 | 대안: 쿼리빌더와 도구 하나로 통일하고 싶을 때 |
| Drizzle Kit 0.31 | 파티션 DDL 스키마 정의 **미지원**(GitHub #2854 open). 생성된 SQL을 수동 편집해야 함 | 동일 | - | 비권장: 스키마 diff가 수기 DDL과 충돌 |
| 순수 SQL + 자체 러너 | 완전 | 동일 | 직접 구현 | 가능하지만 이력·락·체크섬을 재발명해야 함 |

권고 조합: **node-pg-migrate(.sql 파일) + Kysely(쿼리) + kysely-codegen(DB → TS 타입 생성)**. 기존 코드의 `any` 남발을 스키마 기반 타입으로 치환할 수 있음.
- 운영 RDS 적용은 **Vercel 빌드에서 하지 않음.** 로컬이나 CI에서 `DATABASE_URL`로 실행함.
- 기존 `lib/db.ts`의 `ssl.rejectUnauthorized:false`는 RDS CA 번들 검증으로 바꾸는 것을 권장함.
- 로컬 Docker 이미지 메이저 버전은 **RDS와 반드시 일치**시켜야 함(PG 18은 RDS 18.1+에서 지원, 내장 `uuidv7()` 사용 가능).
- `CREATE INDEX CONCURRENTLY`는 트랜잭션 밖에서만 가능함. 파티션 부모에는 어차피 쓸 수 없으므로 파티션 생성 시 인덱스를 함께 만드는 패턴이 맞음.

---

## 4. 분석 파이프라인

### 4.1 단계 DAG와 원칙
```
ingest ─▶ [DQ 인라인: 범위/시계] ─▶ rollup_dirty
            │
            ▼ (5분)                    (매시)                         (매일 02:17 KST)
      DQ 시간버킷 검사 ─▶ m_1h/m_1m ─▶ 에피소드 추출(자산별 워터마크) ─▶ kpi_daily ─▶ 탐지기 ─▶ finding upsert
                                                                                      └─▶ 조치 효과 검증
                                                                     (매주) EvidencePack ─▶ ReportComposer ─▶ report draft
```
- **SQL은 집합 연산**(롤업·일 KPI의 합/평균), **TS 순수 함수는 판단 로직**(에피소드 상태기계, 통계, 탐지 규칙)을 맡음.
- 모든 순수 함수는 `now`/`rng`를 인자로 받음. `Date.now()`나 `Math.random()`을 직접 부르지 않아야 시뮬레이터로 시간 여행 재생이 가능함.
- 탐지기·추출기는 `id@version`을 결과에 기록함. 로직을 바꾸면 버전을 올리고 재계산 범위를 명시함.
- 권장 디렉터리: `lib/analytics/stats/*`, `lib/analytics/dq/*`, `lib/analytics/episodes/*`, `lib/analytics/detectors/<domain>/*`, `lib/pipeline/*`(DB I/O 오케스트레이션), `lib/report/*`, `lib/sim/*`.

### 4.2 데이터 품질(DQ) 검사
| 검사 | 규칙 | 파라미터 출처 | 처리 |
|---|---|---|---|
| 결측/완결성 | `n / (3600 / period_s)` 시간당 비율, 게이트웨이 `seq` 공백 | point.period_s | `dq_hourly.completeness`, 80% 미만 버킷은 분석 가중치를 낮춤 |
| 범위(hard) | `value ∉ [hard_min, hard_max]` | metric_def/point | 수집 시 `HARD_RANGE` 비트(값은 보존) |
| 범위(soft) | `expected` 범위 이탈이 지속 | metric_def/point | 운전 이상 후보(탐지기 입력) |
| 고착(flatline) | 연속 구간 `max−min ≤ flatline_tol` 이고 지속 ≥ `flatline_max_s` | metric_def | **맥락 제외 필수**: 야간 PV 전력 0, 만충 대기 SOC 100%, 휴지 탱크 압력. 물리적으로 연동된 신호(일사량↔인버터 출력, 전류↔온도)가 변하는데 이 신호만 멈추면 "센서 고착" |
| 스파이크 | Hampel: `|x − med_w| > 3 × 1.4826 × MAD_w` 또는 `|Δx/Δt| > max_rate_per_s` | metric_def | `SPIKE` 구간 기록 |
| 단위 변경 | 일 중앙값 비율이 ~1000배(W↔kW) 또는 ~100배로 점프 | - | DQ Finding(설정 변경 의심) |
| 시계 | 미래 ts, 역행, |skew|>120s, NTP 미동기 | gateway | `CLOCK_SUSPECT`, DQ Finding |
| 게이트웨이 단절 | `last_seen_at` > flush 주기 × 3 | gateway | 가용성 Finding |

DQ 결과 자체도 **코칭 항목**임(센서 교정·통신 품질 개선 권고). 원시 행 UPDATE는 비싸므로, 사후 검출(고착·스파이크)은 `om.dq_interval(point_id, tstzrange, issue, detector_version)`에 구간으로 저장하고 롤업·분석에서 제외 조인함.

```ts
// lib/analytics/stats/robust.ts
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = xs.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mad(xs: readonly number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}
/** Iglewicz & Hoaglin 수정 z-score. |M| > 3.5면 이상치 후보 (NIST 핸드북) */
export function modifiedZ(x: number, med: number, madValue: number, madFloor = 0): number {
  const d = Math.max(madValue, madFloor);
  return d === 0 ? 0 : (0.6745 * (x - med)) / d;
}

// lib/analytics/dq/hampel.ts
export function hampelFlags(v: readonly number[], half = 5, nSigma = 3, scaleFloor = 0): boolean[] {
  return v.map((x, i) => {
    const w = v.slice(Math.max(0, i - half), Math.min(v.length, i + half + 1));
    const med = median(w);
    const s = Math.max(1.4826 * mad(w, med), scaleFloor);
    return s > 0 && Math.abs(x - med) > nSigma * s;
  });
}

// lib/analytics/dq/flatline.ts
export interface Interval { readonly start: number; readonly end: number }   // epoch s
export function flatlineIntervals(
  t: readonly number[], v: readonly number[], tol: number, minDurationS: number,
  isExpectedConstant: (i: number) => boolean = () => false,   // 야간/대기 등 맥락
): Interval[] {
  const out: Interval[] = [];
  let startIdx = 0, lo = v[0], hi = v[0];
  for (let i = 1; i <= v.length; i++) {
    const ended = i === v.length || isExpectedConstant(i) ||
      Math.max(hi, v[i]) - Math.min(lo, v[i]) > tol;
    if (ended) {
      if (t[i - 1] - t[startIdx] >= minDurationS && !isExpectedConstant(startIdx)) out.push({ start: t[startIdx], end: t[i - 1] });
      if (i < v.length) { startIdx = i; lo = v[i]; hi = v[i]; }
    } else { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  }
  return out;
}
```

### 4.3 이벤트(에피소드) 추출
원시 곡선을 **운전 단위 사건**으로 잘라 특징값을 영구 저장함. 조건 매칭 비교의 기본 단위임.

| 에피소드 kind | 시작/종료 조건(히스테리시스) | 주요 특징값 |
|---|---|---|
| `ess.charge` / `ess.discharge` | 전류 부호·크기가 임계를 넘어 ≥10분 지속, 공백 ≤3분 | SOC 시작/끝, Ah·Wh 적산, 평균 I/V, 셀온도 평균/최대, CC구간 Ah, CV구간 시간, 종료 셀전압 편차 |
| `pv.daylight` / `pv.clear_day` | 일출~일몰, 청천지수 기준 | 발전량, PR, 클리핑 시간, 출력제어 시간 |
| `inv.derating` | 온도 기인 출력 제한 플래그/패턴 | 지속시간, 방열판 온도 |
| `el.steady_run` | 전류 ±2%, 스택온도 ±2°C로 ≥30분 | 전류밀도, 셀당 전압, kWh/kg, 누적 운전시간 |
| `fc.steady_run` | 출력 ±3%로 ≥20분 | 셀 평균전압@전류, 블로워 전력/유량, 효율 |
| `comp.cycle` | 기동→정지 | 토출압/온도, kWh/kg, 사이클 시간 |
| `tank.idle_hold` | 입·출 유량 ≈ 0 으로 ≥6시간 | 압력·온도 시계열 요약, 온도보정 질량 기울기 |

```sql
CREATE TABLE om.episode (
  asset_id          integer     NOT NULL REFERENCES om.asset(id),
  kind              text        NOT NULL,
  start_ts          timestamptz NOT NULL,
  end_ts            timestamptz NOT NULL,
  extractor_version text        NOT NULL,
  features          jsonb       NOT NULL,   -- {"soc_start":6.2,"soc_end":99.1,"ah_in":402.7,"i_mean":50.1,"t_cell_mean":24.8,"cc_ah":371.0,"cv_s":3420}
  conditions        jsonb       NOT NULL,   -- {"i_bin":"45-55A","t_bin":"20-30C","soc_window":"<10→>95"}
  dq                jsonb       NOT NULL,   -- {"completeness":0.99,"flags":0}
  PRIMARY KEY (asset_id, kind, start_ts)
);
CREATE INDEX episode_kind_time ON om.episode (kind, start_ts);
```

```ts
// lib/analytics/episodes/ess-charge.ts
export interface BattSample { readonly t: number; readonly i: number; readonly v: number; readonly soc: number; readonly tempC: number }
export interface ChargeCfg { readonly iOn: number; readonly iOff: number; readonly minDurationS: number; readonly maxGapS: number; readonly vCv: number }
export interface ChargeEpisode {
  readonly start: number; readonly end: number; readonly socStart: number; readonly socEnd: number;
  readonly ahIn: number; readonly whIn: number; readonly iMean: number; readonly tMean: number;
  readonly ccAh: number; readonly cvSeconds: number;
}

export function extractChargeEpisodes(s: readonly BattSample[], cfg: ChargeCfg): ChargeEpisode[] {
  const segments: BattSample[][] = [];
  let cur: BattSample[] = [];
  for (const x of s) {
    const prev = cur.at(-1);
    if (prev && x.t - prev.t > cfg.maxGapS) { segments.push(cur); cur = []; }
    const charging = cur.length > 0 ? x.i > cfg.iOff : x.i > cfg.iOn;   // 히스테리시스
    if (charging) cur = [...cur, x];
    else if (cur.length > 0) { segments.push(cur); cur = []; }
  }
  if (cur.length > 0) segments.push(cur);
  return segments
    .filter((seg) => seg.length > 1 && seg.at(-1)!.t - seg[0].t >= cfg.minDurationS)
    .map((seg) => summarizeCharge(seg, cfg));
}

function summarizeCharge(seg: readonly BattSample[], cfg: ChargeCfg): ChargeEpisode {
  let ah = 0, wh = 0, ccAh = 0, cvS = 0;
  for (let k = 1; k < seg.length; k++) {
    const dt = seg[k].t - seg[k - 1].t;
    const iAvg = (seg[k].i + seg[k - 1].i) / 2;              // 사다리꼴 적분
    const pAvg = (seg[k].i * seg[k].v + seg[k - 1].i * seg[k - 1].v) / 2;
    ah += (iAvg * dt) / 3600; wh += (pAvg * dt) / 3600;
    if (seg[k].v < cfg.vCv) ccAh += (iAvg * dt) / 3600; else cvS += dt;
  }
  const dur = seg.at(-1)!.t - seg[0].t;
  return {
    start: seg[0].t, end: seg.at(-1)!.t, socStart: seg[0].soc, socEnd: seg.at(-1)!.soc,
    ahIn: ah, whIn: wh, iMean: dur > 0 ? (ah * 3600) / dur : 0,
    tMean: seg.reduce((a, x) => a + x.tempC, 0) / seg.length, ccAh, cvSeconds: cvS,
  };
}
```
(스케치에서는 가독성을 위해 스프레드를 썼음. 실제로는 인덱스 구간 `[startIdx, endIdx]`로 잘라 복사를 피하는 편이 좋음.)

### 4.4 조건 매칭 기준선: 사용자 예시의 정량화
**질문**: "같은 전압·전류 조건에서 0→100% 충전이 8h였는데 지금 7h30m이다."

1. `ess.charge` 에피소드 중 **조건이 같은 것만** 고름.
   - SOC 창: 시작 ≤10%, 끝 ≥95%
   - 평균 전류 bin: 예) 45–55A
   - 셀 평균온도 bin: 15–25°C / 25–35°C (저온에서는 가용용량이 일시적으로 줄므로 반드시 분리)
   - DQ 완결성 ≥95%
2. **지표는 시간보다 Ah 적산을 우선**함. 시간은 전류·시작 SOC 차이에 민감하므로 `ah_in / ΔSOC`(SOC 1%p당 Ah, 곧 유효용량 추정)를 씀.
   - 예: 50A×8h = 400Ah → 50A×7.5h = 375Ah → 비율 0.9375 → **유효용량 −6.25%**
3. **SOC 자체의 함정**: BMS가 내부 용량 추정을 갱신하면 SOC 0→100%의 의미가 바뀜. 그래서 **전압 기준 창(CC 구간 V1→V2 사이 Ah)** 을 BMS 독립 교차검증으로 함께 봄. 내부저항이 커지면 CV 진입이 빨라지고(CC Ah 감소, CV 시간 증가) 이 패턴으로 **용량 감소와 저항 증가를 구분**함.
4. 기준 기간은 `commissioning + 30일 ~ + 120일`(초기 안정화 후) 또는 **작년 같은 계절**, 비교 기간은 최근 30일.
5. bin별 중앙값 비율을 **표본 수로 가중 결합**하고 **부트스트랩 95% CI**를 계산함. 최소 표본 기준(bin당 ≥5, 전체 ≥15) 미달이면 `insufficient_data`.
6. 에피소드별 유효용량을 운전일수 축에 놓고 **Theil–Sen 기울기(%/월)** 로 추세를 보고, SOH 80% 도달 예상일을 **CI와 함께** 제시함(단순 선형 외삽이라는 한계를 명시).
7. BMS가 보고하는 SOH(`batt.soh.reported`)와 분석 추정치의 괴리가 크면 별도 Finding("BMS SOH 추정 신뢰성")을 올림.

```ts
// lib/analytics/baseline/matched.ts
export interface MatchedRatio {
  readonly kind: 'ok' | 'insufficient';
  readonly ratio?: number;                    // current / reference (가중)
  readonly ci?: readonly [number, number];
  readonly bins: ReadonlyArray<{ bin: string; nRef: number; nCur: number; refMedian: number; curMedian: number }>;
}

export function matchedRatio<E>(
  reference: readonly E[], current: readonly E[],
  binOf: (e: E) => string | null, metricOf: (e: E) => number,
  opt: { minPerBin: number; minTotal: number; iterations: number; rng: () => number },
): MatchedRatio {
  const groupVals = (xs: readonly E[]) => {
    const m = new Map<string, number[]>();
    for (const e of xs) {
      const b = binOf(e);
      if (b !== null && Number.isFinite(metricOf(e))) m.set(b, [...(m.get(b) ?? []), metricOf(e)]);
    }
    return m;
  };
  const ref = groupVals(reference), cur = groupVals(current);
  const bins = [...cur.keys()]
    .filter((b) => (ref.get(b)?.length ?? 0) >= opt.minPerBin && cur.get(b)!.length >= opt.minPerBin)
    .map((b) => ({ bin: b, r: ref.get(b)!, c: cur.get(b)! }));
  const total = bins.reduce((a, x) => a + x.c.length, 0);
  if (bins.length === 0 || total < opt.minTotal) return { kind: 'insufficient', bins: [] };

  const pooled = (pick: (xs: number[]) => number[]) => {
    let num = 0, den = 0;
    for (const { r, c } of bins) { const w = c.length; num += w * (median(pick(c)) / median(pick(r))); den += w; }
    return num / den;
  };
  // pick은 bin별로 새 배열을 만들어 쓰므로 원본은 변하지 않음(부트스트랩 재표본)
  const resample = (xs: number[]) => xs.map(() => xs[Math.floor(opt.rng() * xs.length)]);
  const boots = Array.from({ length: opt.iterations }, () => pooled(resample)).toSorted((a, b) => a - b);
  const q = (p: number) => boots[Math.min(boots.length - 1, Math.floor(p * boots.length))];
  return {
    kind: 'ok', ratio: pooled((xs) => xs), ci: [q(0.025), q(0.975)],
    bins: bins.map(({ bin, r, c }) => ({ bin, nRef: r.length, nCur: c.length, refMedian: median(r), curMedian: median(c) })),
  };
}
```
(참고: 위 `resample`은 기준과 현재를 같은 난수 흐름으로 각각 재표본함. 구현 시 bin별로 `pick`이 r과 c에 따로 적용되는지 단위 테스트로 고정할 것.)

### 4.5 추세·변화점·로버스트 통계·동종 비교·기상 정규화
**Theil–Sen 기울기 + Mann–Kendall**
- 모든 점 쌍 기울기의 중앙값이라 이상치에 강함. CI는 Sen(1968) 방식을 씀.
- 일 단위 KPI 2년치(n≈730, 쌍 ~26.6만)는 브라우저가 아닌 서버 TS에서 충분히 계산 가능함.
- x축은 목적에 맞춤: 달력일(열화), **누적 운전시간**(전해조·연료전지 μV/h).
```ts
export type Trend =
  | { kind: 'insufficient'; n: number }
  | { kind: 'ok'; n: number; slope: number; intercept: number; ciLow: number; ciHigh: number };

export function theilSen(x: readonly number[], y: readonly number[], z = 1.96): Trend {
  const n = x.length;
  if (n < 10) return { kind: 'insufficient', n };
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = x[j] - x[i];
      if (dx !== 0) slopes.push((y[j] - y[i]) / dx);
    }
  const s = slopes.toSorted((a, b) => a - b);
  const N = s.length;
  const slope = median(s);
  const c = z * Math.sqrt((n * (n - 1) * (2 * n + 1)) / 18);   // 동점 보정은 생략
  const lo = s[Math.max(0, Math.floor((N - c) / 2))];
  const hi = s[Math.min(N - 1, Math.ceil((N + c) / 2))];
  const intercept = median(y.map((yi, i) => yi - slope * x[i]));
  return { kind: 'ok', n, slope, intercept, ciLow: lo, ciHigh: hi };
}
```
- 계절성: 1년 이상 데이터가 쌓이면 **Year-on-Year 차분**(NREL RdTools의 PV 열화율 권장 방식: 1년 간격 쌍의 변화율 분포 중앙값 + 부트스트랩)을 씀. 1년 미만이면 기상 정규화된 지표에 Theil–Sen을 적용함.

**변화점: CUSUM / EWMA** (기준선 대비 표준화 잔차 `z_t`에 적용)
- 표 CUSUM(NIST): `S_hi = max(0, S_hi + z − k)`, `S_lo = max(0, S_lo − z − k)`. **k = 0.5**(1σ 변화 탐지), **h = 4~5**.
- EWMA: `E_t = λ·z_t + (1−λ)·E_{t−1}`, **λ = 0.2~0.3**, 한계 ±L·σ_EWMA(L≈3).
- 역할 분담: CUSUM은 "언제부터 바뀌었나"(변화 시작일을 근거에 기록), EWMA는 점진 변화 감시, Theil–Sen은 크기와 속도.
```ts
export function tabularCusum(z: readonly number[], k = 0.5, h = 5) {
  let hi = 0, lo = 0, lastZeroHi = 0, lastZeroLo = 0;
  for (let i = 0; i < z.length; i++) {
    hi = Math.max(0, hi + z[i] - k); if (hi === 0) lastZeroHi = i + 1;
    lo = Math.max(0, lo - z[i] - k); if (lo === 0) lastZeroLo = i + 1;
    if (hi > h) return { alarmAt: i, direction: 'up' as const, changeStart: lastZeroHi };
    if (lo > h) return { alarmAt: i, direction: 'down' as const, changeStart: lastZeroLo };
  }
  return { alarmAt: null, direction: null, changeStart: null };
}
```

**동종 설비 비교(peer)**
- 같은 사이트·같은 모델(`asset.peer_group`)은 **같은 날씨**를 겪음 → 기상 정규화가 자동으로 됨(가장 강력하고 센서 요구가 적음).
- 인버터 i의 15분 비율 `r_i = (P_i / kWp_i) / median_j(P_j / kWp_j)`를 구함. 조건은 사이트 출력이 정격의 20% 이상, 출력제어·클리핑 구간 제외.
- 일 중앙값 → 수정 z-score → **7일 중 5일 이상 z < −3.5**이면 Finding.
- 동종이 3~4대뿐이면 MAD가 불안정함 → `madFloor = 중앙값의 1%` 같은 하한을 둠. 2대 이하이면 peer 방식을 끄고 자기 기준선 방식을 씀.

**기상 정규화(PV) 선택지와 신뢰도**
| 방식 | 필요 데이터 | 신뢰도 |
|---|---|---|
| POA 일사계 + 모듈온도 → 온도보정 PR(IEC 61724-1 개념) | 현장 센서(Class A: 샘플링 ≤3s, 기록 ≤1분) | 높음 |
| 사이트 내 동종 비교 | 인버터 출력만 | 높음(상대 이상) |
| 위성/수치예보 일사량(예: 기상청 ASOS 일사, Open-Meteo 등, 상업 이용 조건 확인 필요) | 외부 API | 중간 |
| OpenWeather 운량/날씨 코드(현재 코드베이스) | 기존 | 낮음: "청천일 필터" 용도로만 |
- 한국 특화 음성 대조군: **출력제어(제주 등)** 는 고장이 아닌데 발전량을 떨어뜨림 → 출력제어 신호나 설정값 포인트를 수집해 해당 구간을 반드시 제외함(열린 질문 참조).
- 오염(soiling): 강우(≥5mm/일) 또는 세정 이벤트 사이 구간의 정규화 발전지수에 Theil–Sen 기울기(%/일)를 적용함. RdTools의 SRR(stochastic rate and recovery) 개념, 즉 "선형 하락 후 급회복"을 단순화한 버전임. 세정 조치 후 회복량은 조치 효과 검증과 연결함.
- 모델 기반 기준선(회귀)을 쓸 경우 ASHRAE Guideline 14 적합도 기준(시간 단위 CV(RMSE) ≤30%, |NMBE| ≤10%)을 충족할 때만 기준선으로 인정하고 신뢰도에 반영함.

### 4.6 설비별 탐지기 카탈로그(1차 범위 제안)
| 도메인 | 탐지기 id | 핵심 지표 / 방법 | 비고 |
|---|---|---|---|
| PV | `pv.soiling_rate` | 강우 구간 사이 정규화 발전지수의 Theil–Sen | 세정 권고 + 세정 효과 검증 |
| PV | `pv.string_underperf` | 스트링 전류 peer 수정 z | 음영·단선·모듈 불량 |
| PV | `pv.degradation_yoy` | YoY 열화율(1년 이상 데이터) | 기대 수준(연 0.5% 안팎)과 비교 |
| 인버터 | `inv.efficiency_drop` | η = P_ac/P_dc, 부하 bin × 방열판온도 bin 매칭 비율 | 열화·IGBT |
| 인버터 | `inv.thermal_derating_increase` | derating 에피소드 시간/일, 방열판-외기 온도차 추세 | 팬·필터 막힘 코칭 |
| ESS | `ess.capacity_fade` | 4.4절 매칭 비율 + Theil–Sen | 사용자 예시 |
| ESS | `ess.resistance_growth` | 전류 스텝 ΔV/ΔI, CV 진입 SOC 앞당겨짐 | |
| ESS | `ess.cell_imbalance` | 셀전압 spread(max−min) 추세·CUSUM | 밸런싱 점검 |
| ESS | `ess.rte_drop` | 왕복효율, C-rate·온도 매칭 | |
| 전해조 | `el.stack_voltage_rise` | 셀당 전압@기준 전류밀도·온도 bin, x=운전시간 → μV/h | 참고: DOE PEM 목표 열화율은 μV/h 한 자릿수(2.3~4.8 μV/h 범위 언급)이므로 사이트 초기 기울기 대비 배수로 판정 |
| 전해조 | `el.specific_energy_rise` | kWh/kg @ 부하 bin | |
| 전해조 | `el.faradaic_eff_drop` | 측정 H₂ 유량 / (N·I/(2F)) | 크로스오버·누설 의심 |
| 압축기 | `comp.specific_energy_rise` | kWh/kg @ 압력비 bin, 사이클 빈도 | 밸브·실링 |
| 탱크 | `tank.microleak` | `tank.idle_hold` 중 온도보정 질량 m = P·V·M/(Z(P,T)·R·T)의 Theil–Sen 기울기, CI 상한 < −임계 | **안전 카테고리, 심각도 ≥4 고정**. Z는 NIST 수소 밀도 상관식 등으로 계산 |
| 연료전지 | `fc.voltage_decay` | 셀 평균전압@기준 전류, x=운전시간 | |
| 연료전지 | `fc.blower_wear` | 기준기간 P = f(Q) 적합 후 잔차 증가(동일 유량에 전력↑), 진동 RMS | 친화법칙(P∝Q³) 형태로 정규화 |
| 연계 | `h2chain.mass_balance_gap` | 생산 kg(유량계) − 저장증가 − 연료전지 소모 = 미계측 손실 % | **연계형 사업 고유 KPI**(누설·계측 오차) |
| 연계 | `h2chain.p2p_efficiency` | FC 출력 kWh / 전해조 입력 kWh 추세 | 경영 요약 |
| 공통 | `dq.*` | 4.2절 | 센서·통신 코칭 |

```ts
// lib/analytics/detectors/types.ts
export type Severity = 1 | 2 | 3 | 4 | 5;
export interface DetectContext { readonly now: Date; readonly rng: () => number; readonly asset: AssetInfo; readonly params: Readonly<Record<string, number>> }
export interface CandidateFinding {
  readonly detectorId: string; readonly detectorVersion: string;
  readonly assetId: number; readonly failureMode: string;         // 'capacity_fade'
  readonly category: 'performance' | 'degradation' | 'data_quality' | 'safety' | 'availability';
  readonly severity: Severity; readonly confidence: number;       // 0..1
  readonly title: string;                                         // 템플릿 키 + 파라미터로 렌더링
  readonly effect: { metric: string; value: number; unit: string; ci?: readonly [number, number]; baseline?: number };
  readonly window: { start: string; end: string };
  readonly evidence: EvidenceSnapshot;                            // 4.7절
}
export interface Detector<I> {
  readonly id: string; readonly version: string;
  readonly appliesTo: readonly string[];                          // asset_class keys
  readonly requires: { metrics?: readonly string[]; episodes?: readonly string[]; kpis?: readonly string[] };
  load(assetId: number, ctx: DetectContext): Promise<I>;          // I/O (pipeline 레이어)
  detect(input: I, ctx: DetectContext): readonly CandidateFinding[]; // 순수
}
```

### 4.7 Finding 데이터 모델
```sql
CREATE TABLE om.finding (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id             smallint NOT NULL REFERENCES om.site(id),
  asset_id            integer  NOT NULL REFERENCES om.asset(id),
  detector_id         text     NOT NULL,
  detector_version    text     NOT NULL,
  failure_mode        text     NOT NULL,
  category            text     NOT NULL CHECK (category IN ('performance','degradation','data_quality','safety','availability')),
  dedup_key           text     NOT NULL,          -- detector_id|asset_id|failure_mode (윈도우는 넣지 않음)
  severity            smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  confidence          real     NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status              text     NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','triaged','in_report','action_taken','verified','dismissed','reopened')),
  title               text     NOT NULL,
  effect              jsonb    NOT NULL,
  window_start        timestamptz, window_end timestamptz,
  first_detected_at   timestamptz NOT NULL,
  last_detected_at    timestamptz NOT NULL,
  detection_count     integer  NOT NULL DEFAULT 1,
  latest_evidence_id  bigint,
  previous_finding_id bigint REFERENCES om.finding(id),   -- 재발 연결
  suppressed_until    timestamptz,                        -- dismissed(수용위험) 시 재알림 억제
  dismiss_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- "열린" 발견사항은 dedup_key당 하나
CREATE UNIQUE INDEX finding_open_dedup ON om.finding (dedup_key) WHERE status NOT IN ('verified','dismissed');
CREATE INDEX finding_site_status ON om.finding (site_id, status, severity DESC);

CREATE TABLE om.finding_evidence (            -- 탐지 실행마다 append-only 스냅샷
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id  bigint NOT NULL REFERENCES om.finding(id),
  job_run_id  bigint,
  computed_at timestamptz NOT NULL,
  input_hash  bytea NOT NULL,                 -- 입력 데이터 해시(재현성)
  snapshot    jsonb NOT NULL
);

CREATE TABLE om.finding_transition (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id bigint NOT NULL REFERENCES om.finding(id),
  from_status text, to_status text NOT NULL,
  actor text NOT NULL,                        -- 'system' | admin user id
  note text, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE om.maintenance_action (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id        integer NOT NULL REFERENCES om.asset(id),
  finding_id      bigint REFERENCES om.finding(id),
  action_type     text NOT NULL,              -- 'cleaning','fan_replacement','cell_balancing','stack_replacement',...
  performed_at    timestamptz NOT NULL,
  performed_by    text,
  notes           text,
  expected_effect jsonb                        -- {"metric":"pv.pi","direction":"up","min_delta":0.03}
);

CREATE TABLE om.action_verification (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_id     bigint NOT NULL REFERENCES om.maintenance_action(id),
  method        text NOT NULL,                 -- 'matched_before_after@1'
  before_window tstzrange NOT NULL,
  after_window  tstzrange NOT NULL,
  before_stats  jsonb NOT NULL, after_stats jsonb NOT NULL,
  effect        real, ci_low real, ci_high real,
  verdict       text NOT NULL CHECK (verdict IN ('improved','no_change','worse','insufficient_data')),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, method)
);
```

탐지 결과 upsert(중복 억제):
```sql
INSERT INTO om.finding (site_id, asset_id, detector_id, detector_version, failure_mode, category, dedup_key,
                        severity, confidence, title, effect, window_start, window_end, first_detected_at, last_detected_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
ON CONFLICT (dedup_key) WHERE status NOT IN ('verified','dismissed')
DO UPDATE SET
  last_detected_at = EXCLUDED.last_detected_at,
  detection_count  = om.finding.detection_count + 1,
  severity         = GREATEST(om.finding.severity, EXCLUDED.severity),
  confidence       = EXCLUDED.confidence,
  effect           = EXCLUDED.effect,
  window_end       = EXCLUDED.window_end,
  detector_version = EXCLUDED.detector_version,
  updated_at       = now()
RETURNING id, (xmax = 0) AS inserted;
```
- **dismissed + suppressed_until > now**인 같은 dedup_key가 있으면, TS에서 **악화 조건**(효과 크기가 기각 당시보다 X% 이상 커짐)일 때만 새 Finding을 만들고 `previous_finding_id`로 연결함.
- verified 이후 같은 문제가 재발하면 새 Finding을 만들고 `previous_finding_id`로 연결함. 재발률 자체가 코칭 지표가 됨.
- 탐지기가 N일 연속 미발화면 상태는 유지하고 `stale` 표시만 함. 자동 종료는 하지 않음(사람의 확인 없이 닫지 않음).

상태 전이(TS 단일 소스, DB CHECK와 병행):
```ts
export type FindingStatus = 'new' | 'triaged' | 'in_report' | 'action_taken' | 'verified' | 'dismissed' | 'reopened';
export const FINDING_TRANSITIONS = {
  new:          ['triaged', 'dismissed'],
  triaged:      ['in_report', 'dismissed'],
  in_report:    ['action_taken', 'dismissed'],
  action_taken: ['verified', 'reopened'],   // verified는 system(검증 잡)만 가능
  reopened:     ['triaged', 'dismissed'],
  dismissed:    ['reopened'],               // 같은 dedup_key의 열린 Finding이 없을 때만
  verified:     [],
} as const satisfies Record<FindingStatus, readonly FindingStatus[]>;

export function canTransition(from: FindingStatus, to: FindingStatus, actor: 'system' | 'admin'): boolean {
  if (to === 'verified' && actor !== 'system') return false;
  return (FINDING_TRANSITIONS[from] as readonly FindingStatus[]).includes(to);
}
```

근거 스냅샷(evidence) 형태(재현 가능, 차트 가능, LLM 입력 가능):
```ts
export interface EvidenceSnapshot {
  readonly method: string;                     // 'matched_ratio+theil_sen@1'
  readonly params: Readonly<Record<string, number | string>>;
  readonly referenceWindow?: { start: string; end: string };
  readonly currentWindow: { start: string; end: string };
  readonly stats: {
    readonly n: number; readonly nReference?: number;
    readonly effect: number; readonly ci?: readonly [number, number];
    readonly trend?: { slopePerMonth: number; ciLow: number; ciHigh: number };
    readonly changeStart?: string;             // CUSUM
  };
  readonly bins?: ReadonlyArray<{ bin: string; nRef: number; nCur: number; refMedian: number; curMedian: number }>;
  readonly dq: { completeness: number; excludedHours: number };
  readonly series?: ReadonlyArray<{ t: string; v: number }>;   // 차트용, 최대 ~120점으로 다운샘플
  readonly episodeRefs?: ReadonlyArray<{ kind: string; start: string }>;
  readonly inputHash: string;
}
```

**조치 후 효과 검증(before/after)**
- before 창: `[조치−30일, 조치−1일]`, after 창: `[조치+안정화(설비별 1~7일), +30일]`
- **같은 조건 bin 매칭**(4.4절 함수 재사용). PV 세정이면 기상 정규화된 발전지수, 인버터 팬 교체면 derating 시간·방열판 온도차.
- 효과 = after/before 비율, 부트스트랩 CI.
  - CI가 기대효과(`expected_effect.min_delta`) 방향으로 0을 넘으면 `improved` → Finding `verified`
  - CI가 0을 포함하면 `no_change` → `reopened` 제안(관리자 확인)
  - 표본 부족이면 `insufficient_data`, 다음 날 재시도
- 같은 기간에 다른 조치가 겹치면 교란으로 보고 결과 신뢰도를 낮춤.

### 4.8 심각도·신뢰도 산정(초기안, 시뮬레이터로 보정)
```ts
export function scoreConfidence(i: {
  n: number; nRequired: number; effect: number; ciLow: number; ciHigh: number;
  dqCompleteness: number; methodsAgree: number;   // 자기기준선·peer·추세 중 동의 비율 0..1
}): number {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const sample = clamp01(i.n / i.nRequired);
  const precision = i.effect === 0 ? 0 : clamp01(1 - (i.ciHigh - i.ciLow) / (2 * Math.abs(i.effect)));
  const dq = clamp01((i.dqCompleteness - 0.8) / 0.2);
  return Math.round((0.35 * sample + 0.35 * precision + 0.2 * dq + 0.1 * i.methodsAgree) * 100) / 100;
}
```
- 심각도 = 탐지기별 임계표(효과 크기) × 자산 `criticality` 보정. **safety 카테고리(수소 누설 등)는 최소 4**.
- 예: 용량 감소 ≥5% → 3, ≥10% → 4, ≥20% 또는 가속 추세 → 5.
- 가중치·임계는 `om.detector_config`(버전 관리) 테이블로 빼서 코드 배포 없이 조정 가능하게 함.

---

## 5. 작업 실행(Vercel Cron, 워터마크, 잠금)

### 5.1 Vercel 제약(2026-08~09 공식 문서 기준)
| 항목 | Hobby | Pro | Enterprise |
|---|---|---|---|
| Cron 개수/프로젝트 | 100 | 100 | 100 |
| Cron 최소 간격 | **하루 1회**(더 잦으면 배포 실패) | **1분** | 1분 |
| 스케줄 정밀도 | 시간 단위(±59분) | 분 단위 | 분 단위 |
| 함수 최대 실행시간(Fluid) | 300s | 기본 300s, **최대 800s**, 1800s(베타, 함수별 설정) | 동일 |
| 메모리 | 2GB/1vCPU | 최대 4GB/2vCPU | 동일 |
| 요청/응답 본문 | 4.5MB | 4.5MB | 4.5MB |
| 포함 사용량 | 호출 100만, Active CPU 4시간, 메모리 360GB-h/월 | 월 $20 크레딧 기반 과금 | 계약 |
| 상업적 이용 | **불가(개인·비상업 전용)** | 가능 | 가능 |

Cron 동작 특성(공식):
- **재시도 없음**
- **전달이 best effort여서 누락 가능, 드물게 같은 스케줄이 중복 호출될 수 있음**
- 실행이 길면 다음 호출과 **겹칠 수 있어 잠금 권장**
- `CRON_SECRET` 환경변수를 설정하면 `Authorization: Bearer <secret>` 헤더로 전달됨
- 리다이렉트는 따라가지 않음
- 시각은 UTC 기준

Fluid compute에서는 I/O 대기 시간이 Active CPU로 과금되지 않음. 그래서 **집계를 SQL로 밀어 넣는 설계가 비용 면에서도 유리**함. 전역 `pg.Pool`은 `@vercel/functions`의 `attachDatabasePool(pool)`로 등록해 인스턴스 정지 전에 유휴 연결을 닫게 함.

> 현재 저장소의 `/api/solar/cleanup` 크론 핸들러는 `CRON_SECRET` 검사가 없어서 누구나 호출할 수 있음. 재구성할 때 함께 정리할 것.

### 5.2 잡 구성(Pro 기준)
| 경로 | 스케줄(UTC) | maxDuration / 시간예산 | 내용 |
|---|---|---|---|
| `/api/jobs/rollup` | `*/5 * * * *` | 300s / 240s | dirty 큐 소진(500버킷/트랜잭션 반복), 닫힌 시간 DQ 검사, m_1m/m_1h |
| `/api/jobs/episodes` | `7 * * * *` | 300s / 240s | 자산별 워터마크 기반 에피소드 추출(6시간 겹침 재처리), m_1d |
| `/api/jobs/daily` | `17 17 * * *`(= 02:17 KST) | 800s / 700s | 파티션 사전생성·보존, kpi_daily, 탐지기, 조치검증, 게이트웨이 헬스 |
| `/api/jobs/weekly-report` | `37 18 * * 0`(= 월 03:37 KST) | 800s / 700s | 사이트별 EvidencePack → ReportComposer → 초안 |

모든 잡은 **시간예산 초과 전에 스스로 멈추고**, 남은 일은 워터마크나 큐에 남겨 다음 호출이 이어받음(재개 가능). 정각(:00)을 피해 분산함.

**Hobby를 유지할 경우 대안**(권장하지 않음):
1. 롤업을 수집 요청의 `after()`(Next.js 15.1+ stable, Vercel에서는 `waitUntil`로 수명 연장)에서 버킷 N개만 처리
2. 하루 1회 크론으로 탐지·보존 처리
3. 더 잦은 트리거는 GitHub Actions `schedule`(최소 5분, 고부하 시 수~수십 분 지연·누락 가능)로 엔드포인트 호출
- 단, 회사 업무 콘솔은 Hobby 약관상 상업적 이용에 해당할 가능성이 큼.

### 5.3 워터마크와 잠금
```sql
CREATE TABLE om.job_lease (
  job         text PRIMARY KEY,
  holder      text NOT NULL,          -- 호출 id (x-vercel-id 등)
  acquired_at timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
-- 획득: 만료된 경우에만 탈취. 행이 반환되지 않으면 다른 실행이 보유 중
INSERT INTO om.job_lease (job, holder, acquired_at, expires_at)
VALUES ($1, $2, now(), now() + make_interval(secs => $3))
ON CONFLICT (job) DO UPDATE
  SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
  WHERE om.job_lease.expires_at < now()
RETURNING holder;
-- 해제
DELETE FROM om.job_lease WHERE job = $1 AND holder = $2;

CREATE TABLE om.watermark (
  stage      text NOT NULL,           -- 'episodes:ess.charge@3', 'kpi_daily@2'
  scope      text NOT NULL,           -- asset_id 또는 site_id
  value      timestamptz NOT NULL,    -- 여기까지 처리 완료
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stage, scope)
);

CREATE TABLE om.job_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','ok','partial','failed','skipped_locked')),
  stats jsonb, error text
);
```
- **잡 단위 잠금은 lease 행**(만료 시간 = maxDuration + 여유)으로 함. 서버리스 함수가 타임아웃으로 강제 종료돼도 만료 후 자동 회수되고, 콘솔에서 상태를 볼 수 있음.
- **짧은 임계구역**(예: 자산 1개 처리 트랜잭션)은 `pg_try_advisory_xact_lock(hashtextextended('asset:'||id, 0))`로 함. **트랜잭션 수준** advisory lock은 커밋·롤백 시 자동 해제되고, RDS Proxy를 도입해도 세션 고정(pinning)을 일으키지 않음. 세션 수준 `pg_advisory_lock`은 서버리스에서 해제 누락 위험과 Proxy pinning이 있어 피함.
- **증분 규칙**:
  - 처리 범위 `[watermark − overlap, min(now − settle, watermark + maxChunk)]`
  - 결과 upsert → **같은 트랜잭션에서** 워터마크 전진
  - 지연 데이터가 워터마크 이전 버킷을 dirty로 만들면 `UPDATE om.watermark SET value = LEAST(value, $bucket)`로 **되감기**
- Vercel Cron 문서의 "잠금 + 멱등 재조정(reconciliation)" 권고와 정확히 일치하는 구조임.

```ts
// lib/pipeline/run-job.ts (스케치)
export async function runJob<T>(
  name: string, leaseSeconds: number, budgetMs: number,
  body: (deadline: number) => Promise<T>,
): Promise<{ status: 'ok' | 'skipped_locked'; result?: T }> {
  const holder = crypto.randomUUID();
  const acquired = await acquireLease(name, holder, leaseSeconds);
  if (!acquired) return { status: 'skipped_locked' };
  const runId = await startRun(name);
  try {
    const result = await body(Date.now() + budgetMs);
    await finishRun(runId, 'ok', result);
    return { status: 'ok', result };
  } catch (err) {
    await finishRun(runId, 'failed', undefined, err);
    throw err;
  } finally {
    await releaseLease(name, holder);
  }
}
```

### 5.4 외부 워커로 옮길 판단 기준
다음 중 **하나라도 지속되면** 외부 워커를 검토함(예: AWS ECS Fargate 예약 태스크 / Lambda + EventBridge / 소형 EC2, RDS와 같은 VPC).
1. 청크로 나눌 수 없는 단일 단계가 **5~10분**을 넘음(예: 전 사이트 재추출 백필)
2. dirty 큐 최고 대기시간 p95 > **15분**, 또는 일일 잡이 연속 `partial`
3. 수집 규모가 시나리오 C 수준으로 커져 Vercel 함수 비용이 상시 워커 비용을 넘음
4. 게이트웨이가 **MQTT/상시 연결**을 요구하거나 HTTPS 푸시를 못 함
5. Python 생태계(pvlib, RdTools 등)를 직접 쓰고 싶음
6. **보안**: RDS를 퍼블릭 엔드포인트로 두지 않고 VPC 내부로 닫아야 함. Vercel에서 사설 연결은 Secure Compute(상위 플랜)가 필요함
- 봉투·순수 함수·SQL을 전송·런타임과 분리해 두면 이전 비용은 "진입점 교체" 수준으로 끝남.

---

## 6. LLM seam(이번 단계는 인터페이스만)

### 6.1 원칙
- LLM은 **숫자를 계산하지 않음.** 모든 수치·판정은 결정적 엔진이 만들고, LLM은 설명·우선순위 문장화·코칭 톤만 담당함.
- LLM 입력은 **EvidencePack**(Finding·근거 스냅샷·KPI·조치 이력·플레이북 요약)임. 원시 시계열은 넣지 않음. 차트용 다운샘플(≤120점)만 허용함.
- **같은 팩 → 템플릿 구현체 / LLM 구현체** 교체 가능. 두 결과 모두 `pack_hash`로 추적 가능하고 사람 검토 후 발행.
- LLM 산출물은 **검증기**(인용 존재, 수치 일치, 고심각도 누락 없음)를 통과해야 채택. 실패하면 템플릿으로 폴백.

```ts
// lib/report/types.ts
export interface EvidencePack {
  readonly schema: 'om.evidence-pack.v1';
  readonly site: { code: string; name: string; assetsSummary: ReadonlyArray<{ classKey: string; count: number }> };
  readonly period: { from: string; to: string; tz: 'Asia/Seoul' };
  readonly kpis: ReadonlyArray<{ key: string; label: string; value: number; unit: string; previous?: number; baseline?: number }>;
  readonly findings: ReadonlyArray<{
    readonly id: string; readonly assetPath: string; readonly assetClass: string;
    readonly failureMode: string; readonly category: string;
    readonly severity: 1 | 2 | 3 | 4 | 5; readonly confidence: number; readonly status: string;
    readonly effect: { metric: string; value: number; unit: string; ci?: readonly [number, number]; baseline?: number };
    readonly evidenceId: string; readonly evidence: EvidenceSnapshot;
    readonly playbook: { likelyCauses: readonly string[]; checks: readonly string[]; actions: readonly string[] };  // 규칙 카탈로그에서
    readonly history: { firstDetected: string; detections: number; actions: ReadonlyArray<{ type: string; at: string; verdict?: string }> };
  }>;
  readonly dataQuality: { completeness: number; issues: ReadonlyArray<{ assetPath: string; issue: string; hours: number }> };
  readonly verifiedActions: ReadonlyArray<{ assetPath: string; type: string; effect: number; verdict: string }>;
  readonly revenueSummary?: { smpKrw?: number; recKrw?: number; lossEstimateKrw?: number };
  readonly provenance: { generatedAt: string; engineVersion: string; packHash: string };
}

export interface ReportBlock { readonly text: string; readonly citations: readonly string[] }  // finding id / evidence id / kpi key
export interface ReportDraft {
  readonly composerId: string;               // 'template@1' | 'llm:<model>@<date>'
  readonly packHash: string;
  readonly title: string;
  readonly sections: ReadonlyArray<{ kind: 'summary' | 'priority_actions' | 'findings' | 'data_quality' | 'verified_actions' | 'kpi'; blocks: readonly ReportBlock[] }>;
}

export interface ReportComposer {
  readonly id: string;
  compose(pack: EvidencePack, opts: { locale: 'ko-KR'; audience: 'site_manager' | 'executive'; maxFindings: number }): Promise<ReportDraft>;
}

export interface DraftValidation { readonly ok: boolean; readonly problems: readonly string[] }
/** 인용된 id가 팩에 존재하는지, 본문 숫자가 인용된 근거 값과 허용오차 내인지, severity≥4 Finding이 모두 언급됐는지 검사 */
export function validateDraft(pack: EvidencePack, draft: ReportDraft): DraftValidation { throw new Error('sketch'); }
```

```ts
// lib/report/template-composer.ts: 결정적 구현체(이번 단계)
const MESSAGES: Record<string, (f: EvidencePack['findings'][number]) => string> = {
  'ess.capacity_fade': (f) =>
    `${f.assetPath}: 동일 조건(전류·온도·SOC 창) 충전 기준 유효용량이 기준기간 대비 ${fmtPct(1 - f.effect.value)} 감소했습니다` +
    (f.effect.ci ? ` (95% CI ${fmtPct(1 - f.effect.ci[1])}~${fmtPct(1 - f.effect.ci[0])})` : '') + '.',
  'tank.microleak': (f) =>
    `${f.assetPath}: 휴지 구간 온도보정 수소 질량이 ${fmt(f.effect.value)} ${f.effect.unit}로 감소 추세입니다. 즉시 누설 점검이 필요합니다.`,
};
export const templateComposer: ReportComposer = {
  id: 'template@1',
  async compose(pack, opts) {
    const top = pack.findings.toSorted((a, b) => b.severity * b.confidence - a.severity * a.confidence).slice(0, opts.maxFindings);
    return {
      composerId: 'template@1', packHash: pack.provenance.packHash,
      title: `${pack.site.name} O&M 코칭 리포트 (${pack.period.from} ~ ${pack.period.to})`,
      sections: [{
        kind: 'findings',
        blocks: top.map((f) => ({ text: (MESSAGES[f.failureMode] ?? genericMessage)(f), citations: [f.id, f.evidenceId] })),
      }],
    };
  },
};
```
```sql
CREATE TABLE om.report (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id      smallint NOT NULL REFERENCES om.site(id),
  period       tstzrange NOT NULL,
  composer_id  text NOT NULL,
  pack_hash    bytea NOT NULL,
  pack         jsonb NOT NULL,          -- 재현·감사용 원본 팩
  draft        jsonb NOT NULL,
  validation   jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','superseded')),
  reviewed_by  text, published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, period, composer_id, pack_hash)
);
```
나중에 LLM을 꽂을 때: `LlmComposer implements ReportComposer`로 구조화 출력(JSON 스키마 = ReportDraft)을 요구하고 → `validateDraft` 통과 시 채택, 실패 시 `templateComposer` 결과를 사용하고 사유를 기록함. 외부 LLM으로 사이트 데이터를 전송할 수 있는지는 사전에 정책 결정이 필요함.

---

## 7. 시뮬레이터: ground truth 기반 엔진 검증

### 7.1 구조
```
lib/sim/
  rng.ts            시드 PRNG(mulberry32 등). 모든 난수 주입
  weather.ts        청천 일사(Haurwitz: GHI = 1098·cosZ·exp(−0.057/cosZ)) × 운량 마르코프/AR(1), 기온(계절+일변화), 강우 이벤트
  models/pv.ts      P_dc = kWp·(G/1000)·(1+γ(Tcell−25)), γ≈−0.35%/°C, Tcell = Tamb + (NOCT−20)/800·G, 오염비 SR(t), 연 열화
  models/inverter.ts η(부하) 곡선, 클리핑, 온도 derating(방열판 열모델 1차 지연)
  models/battery.ts  용량 Q(t), SOC 적분, V = OCV(SOC) + I·R(t), CC-CV 충전, 온도에 따른 가용용량
  models/electrolyzer.ts V_cell = E_rev + b·ln(j/j0) + r·j + δ·운전시간, H₂ = N·I·η_F/(2F)
  models/compressor.ts / tank.ts  질량수지 dm/dt = ṁin − ṁout − ṁleak, P = Z·m·R·T/(M·V)
  models/fuelcell.ts 분극곡선 + 전압감쇠, 블로워 P = c·Q³/η_b(t), 진동 RMS
  scenarios.ts      고장·DQ 시나리오 정의(타입 안전)
  emit.ts           (a) 메모리 배열(단위 테스트용) (b) om.ingest.v1 봉투 배치(E2E: 실제 /api/ingest로 POST)
  truth.ts          ground truth 기록
  evaluate.ts       Finding ↔ truth 매칭 및 지표
```

### 7.2 시나리오 타입
```ts
export type FaultScenario =
  | { kind: 'battery_capacity_fade';       asset: string; start: string; lossPctPerMonth: number; shape: 'linear' | 'accelerating' }
  | { kind: 'battery_resistance_growth';   asset: string; start: string; pctPerMonth: number }
  | { kind: 'pv_soiling';                  asset: string; start: string; lossPctPerDay: number; resetOnRainMm: number; cleaningDates: readonly string[] }
  | { kind: 'inverter_efficiency_drop';    asset: string; start: string; deltaEtaPct: number; rampDays: number }
  | { kind: 'inverter_fan_degradation';    asset: string; start: string; thermalResistanceIncreasePct: number; rampDays: number }
  | { kind: 'electrolyzer_stack_degradation'; asset: string; start: string; microVoltPerHourPerCell: number }
  | { kind: 'fc_blower_wear';              asset: string; start: string; powerIncreasePctAtSameFlow: number; rampDays: number }
  | { kind: 'tank_microleak';              asset: string; start: string; leakPctOfInventoryPerDay: number };

export type DqScenario =
  | { kind: 'gateway_outage_then_backfill'; gateway: string; start: string; hours: number }
  | { kind: 'sensor_flatline';  point: string; start: string; hours: number }
  | { kind: 'spikes';           point: string; start: string; ratePerDay: number; magnitudeSigma: number }
  | { kind: 'clock_skew';       gateway: string; start: string; skewSeconds: number }
  | { kind: 'duplicate_batches'; gateway: string; ratio: number }
  | { kind: 'unit_change';      point: string; at: string; factor: number };

export interface SimConfig {
  readonly seed: number; readonly from: string; readonly to: string; readonly stepSeconds: number;
  readonly sites: readonly SiteSpec[];           // 자산·명판·peer 구성
  readonly faults: readonly FaultScenario[];
  readonly dq: readonly DqScenario[];
  readonly negativeControls: readonly ('winter_low_irradiance' | 'cloudy_week' | 'curtailment' | 'cold_snap' | 'part_load_electrolyzer' | 'fc_start_stop_cycles')[];
}
```
```sql
CREATE SCHEMA IF NOT EXISTS sim;
CREATE TABLE sim.run (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, seed bigint NOT NULL, config jsonb NOT NULL,
                      engine_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sim.injection (run_id bigint NOT NULL REFERENCES sim.run(id), asset_code text NOT NULL, kind text NOT NULL,
                            start_ts timestamptz NOT NULL, end_ts timestamptz, params jsonb NOT NULL,
                            expected_failure_modes text[] NOT NULL);   -- 'battery_capacity_fade' → {'capacity_fade'}
CREATE TABLE sim.eval_result (run_id bigint NOT NULL REFERENCES sim.run(id), detector_id text NOT NULL,
                              tp int, fp int, fn int, recall real, precision real,
                              median_delay_days real, magnitude_mae real, fp_per_asset_month real,
                              PRIMARY KEY (run_id, detector_id));
```

### 7.3 검증 방법
1. **시간 여행 재생**: 엔진을 시뮬레이션 시간으로 하루씩 전진시키며 실행함(`ctx.now` 주입). Finding의 `first_detected_at`이 시뮬레이션 시각이 되므로 **탐지 지연**을 측정할 수 있음.
2. **매칭 규칙**: 같은 자산 + `expected_failure_modes` 포함 + `first_detected_at ∈ [주입 시작, 주입 종료 + 허용일]`이면 TP. 건강한 대조 자산에서 나온 Finding은 FP.
3. **지표**
   - 재현율, 정밀도
   - 자산·월당 오탐 수
   - 탐지 지연 두 가지: (a) 주입 시작부터, (b) 주입 크기가 "명세상 최소 탐지 크기"를 넘은 시점부터
   - **크기 추정 오차**: 예) 참 −6.25% vs 추정 −6.0%
   - 신뢰도 보정: 신뢰도 구간별 실제 적중률
4. **민감도 곡선(최소 탐지 가능 크기)**: 시나리오 크기를 스윕(예: 누설 0.01~0.5%/일, 용량감소 1~10%)하고 시드를 여러 개 돌려 "크기 vs 재현율" 곡선을 만듦. 운영 측에 "이 시스템이 실제로 잡을 수 있는 수준"을 수치로 제시함(탱크 미세누설처럼 센서 정확도에 막히는 항목에 특히 중요).
5. **음성 대조군 필수**: 겨울 일사 감소, 흐린 주, **출력제어**, 한파(배터리 일시 용량 감소), 전해조 부분부하, 연료전지 잦은 기동정지. 이런 상황에서 Finding이 뜨면 기상·운전조건 정규화 실패로 봄.
6. **수집 경로 검증**: DQ 시나리오를 실제 `/api/ingest/v1`에 봉투로 POST함. 확인 항목은 중복 배치 흡수, 게이트웨이 단절 후 역순 백필, 시계 오차 플래그, 롤업 재계산 정확성(원시 재집계와 비교).
7. **CI 게이트**(예시 목표, 첫 보정 후 확정):
   - 크기 ≥ 명세 최소값에서 재현율 ≥ 0.9
   - 오탐 ≤ 0.1건/자산·월
   - 용량감소 크기 MAE ≤ 1%p
   - 안전 카테고리 탐지 지연 ≤ 3일

### 7.4 테스트 구성
- **단위**(Vitest 5 + fast-check): 통계 함수 성질 테스트
  - Theil–Sen은 이상치 10% 주입 후에도 기울기 변화가 작아야 함
  - `modifiedZ`는 스케일 불변
  - CUSUM은 계단 변화에서 `changeStart`가 참 시작점 ±k 이내
  - 에피소드 추출기는 인위 곡선에서 Ah가 해석해와 일치
- **통합**(docker-compose PostgreSQL, RDS와 같은 메이저 버전): 마이그레이션 up, 파티션 함수, dirty 큐 동시성(두 연결로 교차 실행), finding upsert 부분 유니크 인덱스.
- **데이터량**: 분석 검증은 12개월×5분 해상도를 메모리(Float64Array)에서 처리. DB E2E는 30일×1분(사이트 3개)으로 한정함.
- 물리 모델 파라미터 기본값(예: 전해조 비에너지 ~50~55kWh/kg, 수소 Z 계수)은 **가정값**임. 실제 설비 사양을 받으면 교체함.

---

## 8. 단계별 적용 제안(참고)
1. **P0 기반**: Docker PG(RDS 버전 일치) + node-pg-migrate + 카탈로그/자산/게이트웨이 스키마 + 수집 API(봉투·HMAC·멱등) + 시뮬레이터 emit(PV·ESS만) + 롤업 큐
2. **P1 분석 핵심**: DQ, ESS 충전 에피소드, 조건 매칭, Theil–Sen/CUSUM, Finding 모델·상태기계, 관리자 콘솔 Finding 목록·근거 차트, 템플릿 리포트
3. **P2 확장**: 인버터/PV 탐지기, 조치 효과 검증, 시뮬레이터 평가 CI 게이트
4. **P3 수소**: 전해조·압축기·탱크·연료전지 모델/탐지기, 연계 질량수지 KPI
5. **P4**: 원시 S3 아카이브, LLM Composer(검증기 포함), 필요 시 외부 워커

## 9. 주요 리스크
- **플랜 리스크**: Hobby 약관(상업 이용)과 크론 1회/일 제약 때문에 현실적으로 Pro가 필요함.
- **스토리지 리스크**: 포인트 수·주기가 가정보다 크면(셀 단위) RDS 비용이 급증함 → 게이트웨이 단 축약 정책을 먼저 합의해야 함.
- **정규화 리스크**: 일사계가 없고 동종 설비가 적은 사이트는 PV 탐지 신뢰도가 낮음 → 신뢰도에 반영하고 리포트에 명시.
- **보안 리스크**: RDS 퍼블릭 노출 + TLS 검증 비활성(현 `lib/db.ts`) → CA 검증, 보안그룹 최소화, 장기적으로 VPC 내 수집 경로 검토.
- **수소 안전**: 누설 탐지는 보조 분석이지 법정 안전설비(가스감지기·차단)를 대체하지 않음을 리포트·UI에 명시.
