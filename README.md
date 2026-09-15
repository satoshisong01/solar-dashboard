# HySol Desk

태양광·ESS·수전해·수소저장·연료전지 설비의 원시데이터를 분석해 사이트별 유지보수 코칭까지 잇는 관리자 전용 O&M 분석 콘솔입니다.

- 설계 문서: [docs/renewal/README.md](docs/renewal/README.md)

## 로컬 개발

> **운영 DB 주의:** 로컬 개발과 테스트는 `localhost:54320`의 embedded-postgres만 씁니다. `.env.local`에 있는 운영 AWS RDS 접속정보(`DB_HOST` 등)는 새 코드가 읽지 않으며, 수정·삭제하지 마세요. 새 코드는 `DATABASE_URL`만 사용하고, 테스트는 `localhost:54320/hysol_test`가 아니면 실행을 거부합니다.

### 사전 준비

- Node.js 22.12 이상
- Docker는 필요 없습니다. [embedded-postgres](https://github.com/leinelissen/embedded-postgres)가 PostgreSQL 17을 로컬 프로세스로 실행합니다(데이터: `.data/pg`, 포트 54320). 관리자 권한이 아닌 일반 셸에서 실행하세요.

### 시작하기

1. 환경변수 파일을 만들고 값을 채웁니다. `BETTER_AUTH_SECRET`(32자 이상)과 `INGEST_KEY_ENC_KEY`(base64 32바이트)는 랜덤 값이며 생성 명령은 `.env.example`에 있습니다.
   ```bash
   cp .env.example .env.development.local
   ```
2. 의존성을 설치합니다.
   ```bash
   npm install
   ```
3. **별도 터미널**에서 DB 서버를 켜 두고 그대로 둡니다. 최초 실행 시 `hysol`·`hysol_test` DB를 만듭니다.
   ```bash
   npm run db:up      # Ctrl+C로 종료. 터미널을 닫지 못했으면 npm run db:down
   ```
4. 개발 DB를 마이그레이션합니다.
   ```bash
   npm run db:migrate
   ```
5. 설비 카탈로그와 가상 사이트를 넣습니다.
   ```bash
   npm run db:seed
   ```
   - `om.asset_class`·`om.metric_def` 카탈로그와 가상 사이트 SIM-A(태양광+ESS)·SIM-B(연계형)·SIM-C(연계형 대조군)의 설비 트리·게이트웨이·포인트 매핑을 upsert합니다. 여러 번 실행해도 결과가 같고, 이미 있는 설비·포인트는 UPDATE만 해서 id 시퀀스도 늘지 않습니다.
   - 게이트웨이 개발용 HMAC 비밀값 `SIM_GATEWAY_SECRET_<게이트웨이 코드>`가 env 파일에 없으면 생성해 파일 끝에 추가하고, DB에는 `INGEST_KEY_ENC_KEY`로 암호화해 저장합니다. 이미 저장된 키는 현재 `INGEST_KEY_ENC_KEY`로 풀리고 비밀값이 같으면 다시 암호화하지 않습니다(키를 바꿨거나 비밀값이 달라졌을 때만 다시 암호화). 비밀값은 출력하지 않습니다.
   - 정의는 `db/seed/`(순수 데이터 모듈)에 있습니다. `db/seed/sites.ts`의 `UNMAPPED_SOURCE_TAGS`는 일부러 매핑하지 않는 태그라 DB에 넣지 않습니다(미매핑 인박스·재처리 시연용).
6. 관리자 계정을 만듭니다. 가입이 비활성이라 계정은 이 스크립트로만 만듭니다.
   ```bash
   npm run admin:create -- --email admin@hysol.local --password '<12자 이상>' --name 관리자
   ```
7. 개발 서버를 실행하고 http://localhost:3000/login 에서 로그인합니다.
   ```bash
   npm run dev
   ```

| 스크립트 | 설명 |
|---|---|
| `db:migrate` / `db:migrate:down` | 개발 DB에 남은 마이그레이션 전부 적용 / 마지막 1개 되돌리기. `scripts/db-migrate.ts`가 node-pg-migrate를 실행하며 `DATABASE_SSL`·`DATABASE_SSL_CA_PATH`를 앱과 같은 규칙으로 반영한다. 개수 지정: `npm run db:migrate:down -- 2` |
| `db:migrate:test` | 테스트 DB 마이그레이션 (integration·e2e가 시작할 때 같은 작업을 자동으로 한다) |
| `db:types` | DB에서 `lib/db/types.ts` 생성 (om, public, sim 스키마. 파티션 자식 테이블은 제외) |
| `db:seed` / `db:seed:test` | 개발 / 테스트 DB에 카탈로그·가상 사이트 멱등 upsert. 게이트웨이 개발용 비밀값이 없으면 해당 env 파일에 생성 |
| `db:reset` | **로컬 전용.** 개발 DB 스키마를 모두 지우고 다시 migrate. `localhost:54320`이 아니면 중단 |
| `db:rollup:rebuild` | **로컬 전용.** `om.m_1h`를 원시 측정값에서 UTC 하루 단위로 전부 다시 집계한다(롤업 규칙이 바뀐 뒤 과거분을 맞출 때). 끝나면 `n_good/n` 비율을 출력. `localhost:54320`이 아니면 중단 |
| `admin:create` / `admin:create:test` | 개발 / 테스트 DB에 관리자 계정 생성. 이미 있으면 안내 후 종료 |
| `typecheck` / `lint` | `tsc --noEmit` / ESLint |

### 데모 데이터 만들기

시뮬레이터(`lib/sim`)로 가상 사이트 SIM-A/B/C의 과거 데이터를 만들어 **실제 수집 API**(`POST /api/ingest/v1`, HMAC 서명·gzip)로 적재하고 DB에서 검증합니다. 개발 DB(`hysol`)에만 넣습니다.

1. 별도 터미널에서 DB 서버를 켭니다: `npm run db:up`
2. `npm run db:migrate`
3. `npm run db:seed` — 게이트웨이 키가 없으면 `.env.development.local`에 `SIM_GATEWAY_SECRET_*`를 만듭니다.
4. 별도 터미널에서 서버를 켭니다: `npm run dev`
5. 과거 30일치를 적재합니다.
   ```bash
   npm run sim:backfill -- --days 30 --sites SIM-A,SIM-B,SIM-C --seed 42 --base-url http://localhost:3000 --scenario dq
   ```
6. 적재 결과를 검증합니다: `npm run verify:ingest`

30일 × 3사이트는 샘플 약 738만 개, 1시간 배치 2,279개(재전송 포함)입니다. 이 PC 기준으로 적재에 `next dev` 약 1분(`next build` + `next start` 약 46초), 검증에 약 15초가 걸리고 DB가 약 750 MB 늘어납니다.

**`sim:backfill` 옵션**

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--days` | 30 | 적재 기간(일). 끝은 실행 시각을 배치 단위로 내림한 시각 |
| `--sites` | `SIM-A,SIM-B,SIM-C` | 적재할 사이트 |
| `--seed` | 42 | 같은 시드·기간이면 같은 데이터 |
| `--base-url` | `http://localhost:3000` | 수집 API 서버 |
| `--scenario` | `healthy` | `healthy`(시나리오 없음), `dq` 또는 `demo120`(아래) |
| `--batch-minutes` | 60 | 게이트웨이 배치 길이(분) |
| `--max-samples` | 5000 | 배치당 최대 샘플 수. 넘으면 나눠 보냄 |
| `--concurrency` | 4 | 동시에 보내는 요청 수 |
| `--manifest` | `.data/sim/backfill-manifest.json` | `verify:ingest`가 읽는 적재 기록 |

`dq` 시나리오(3일 이상, SIM-A·SIM-B 필요): 전 사이트 중복 배치 5%, SIM-B 게이트웨이 6시간 단절 후 역순 백필, SIM-A +200초 시계 오차 12시간, SIM-A 일사계(`WX1/POA`) 8시간 고착, SIM-B 저장탱크 압력 스파이크, SIM-B 수소 누출 1차 경보 1회. 대조군 SIM-C에는 값을 바꾸는 시나리오를 넣지 않습니다.

`demo120` 시나리오(120일 이상, 세 사이트 필요, 일수는 적재 시작일의 KST 0시 기준): SIM-A 랙 1 용량 45일째부터 30일간 −7%·인버터 1 효율 60일째 −2%p·랙 3 셀 불균형 30일째부터 월 10 mV, SIM-B 전해조 스택 30일째부터 25 µV/h·연료전지 30일째부터 30 µV/h·90일째 ESS SOC 상한 90% → 80%(대조군 조건), SIM-C 한파 주간(20일째)·흐린 주(50일째)·출력제어 3회(70·77·84일째). SOC 상한 변경처럼 봉투에 실리지 않는 운영 이벤트는 적재가 끝난 뒤 `om.asset_event`에 기록합니다(같은 행이 있으면 건너뜀).

**분석 데모 (demo120 → 분석 결과)**

```bash
npm run db:reset && npm run db:seed          # 계정도 지워지므로 필요하면 npm run admin:create
npm run dev                                   # 별도 터미널
npm run sim:backfill -- --days 120 --sites SIM-A,SIM-B,SIM-C --seed 42 --scenario demo120
npm run verify:ingest
npm run analyze -- --sites SIM-A,SIM-B,SIM-C --days 120 --to <적재 끝 시각, 예: 2026-09-15T02:00:00+09:00>
```

이 PC 기준 실측: 샘플 29,514,240개·배치 8,640개 적재 4분 36초(`next dev`, 동시성 4), `.data/pg` 0.8 GB → 3.9 GB(DB 2.9 GB), 검증 46초, 3사이트 120일 분석 43초(에피소드 11,468개·KPI 8,429행). 기대 결과: SIM-A 랙 1 용량 약 −7.4%(기준 대비 기본 노화 포함)·인버터 1 약 −2.1%·랙 3 셀 전압 편차 약 +24 mV, SIM-B 전해조 약 21 µV/h(주입 전 30일의 기본 4 µV/h가 섞인 전체 기울기)·연료전지 약 28 µV/h, SIM-B SOC 상한 변경은 용량 탐지 표본 부족으로 오탐 없음, SIM-C 발견사항 0건. (위 실측은 휴지 앵커·bin별 기준 도입 전입니다. 도입 뒤 SIM-B 용량은 휴지 앵커로 판정되며, SOC 상한 변경 대조군이 판정 ok 상태에서 오탐 0인지는 `sim:eval` 게이트로 확인합니다. 개발 DB는 `ess.rest@2` 재추출이 필요해 다시 분석해야 합니다.)

**`verify:ingest` 검사 항목** (하나라도 실패하면 종료 코드 1)

- (a) 사이트별 `om.measurement` 행 수 = 적재 기록의 기대 고유 샘플 수 (미매핑 제외, 적재 샘플 시각 범위 안)
- (b) 남은 dirty를 모두 롤업한 뒤 `om.m_1h` 전체 = 원시 전체 재집계 (n·n_good·min·max·first·last 완전 일치, avg·sum 상대 오차 1e-9)
- (c) `om.unmapped_source`에 일부러 매핑하지 않은 태그만 있음
- (d) 보낸 critical 경보가 안전 이벤트(`is_safety`)로 기록됨
- (e) `CLOCK_SUSPECT` 샘플 수 = 시계 오차 배치의 기대 샘플 수, `LATE` 비트 존재

**알아 둘 점**

- 과거분을 지금 한꺼번에 보내므로 수신 시각보다 1시간 넘게 지난 샘플에는 모두 `LATE` 비트가 붙습니다(설계 §5.1 규칙 6). 품질 비트는 두 종류입니다.
  - **BAD**(`DEVICE_BAD`·`HARD_RANGE`·`SPIKE`·`FLATLINE`): 값을 믿을 수 없음. `m_1h.n_good`에서 빠집니다.
  - **INFO**(`CLOCK_SUSPECT`·`LATE`·`REPROCESSED`): 값은 유효하고 수신·출처 상태만 표시. `n_good`에 포함됩니다. 시각 정확도가 중요한 분석은 `isGoodWithTrustedClock`으로 `CLOCK_SUSPECT`까지 뺄 수 있습니다(`lib/ingest/quality.ts`).
  - `n_good` = 값이 NULL이 아니고 BAD 비트가 없는 샘플 수입니다. 이 규칙 이전에 적재한 개발 DB는 `npm run db:rollup:rebuild`로 `m_1h`를 다시 집계하세요.
- 봉투 본문은 시뮬레이터가 만든 그대로 보냅니다(`sent_at` = 시뮬레이션 배치 전송 시각). 서버는 `sent_at`이 아니라 **서명 시각(`X-OM-Timestamp`)과 수신 시각의 차이**로 시계 오차를 재므로(재전송 본문의 `sent_at`은 오래될 수 있음), `CLOCK_SUSPECT`는 시계 오차 구간의 배치에만 붙습니다.
- 같은 시간대(같은 적재 창)에 같은 시드·옵션으로 다시 실행하면 본문이 같아 모든 배치가 200 duplicate가 되고 원시는 늘지 않습니다. 이 방식 이전 전송기(`sent_at`을 전송 시각으로 바꿔 보냄)로 적재한 데이터에 다시 보내면 409가 날 수 있습니다(샘플은 이미 들어 있음). 다른 시각에 다시 실행하면 기간이 겹쳐 (a)가 맞지 않습니다. 처음부터 다시 만들려면 `npm run db:reset` → `npm run db:seed` → `npm run admin:create`(계정도 지워짐) 후 4~6단계를 반복하세요.
- 실시간 전송: `npm run sim:live -- --sites SIM-A,SIM-B,SIM-C` 는 현재 시각부터 5분 창마다 보냅니다(시나리오 없음, Ctrl+C로 종료). 설비 상태를 시작 시각으로 추정하므로 적재한 과거 데이터와 값이 이어지지는 않습니다.

### 분석 실행 (`lib/analysis`)

분석은 **수동 실행만** 있습니다(설계 §0). 관리자가 사이트·설비·기간을 고르면 `runAnalysis(db, { siteIds, assetIds?, from, to, requestedBy })`가 결과를 발견사항(finding)으로만 저장하고, 리포트는 만들지 않습니다. 콘솔의 "분석 실행" 버튼(`/desk`)과 로컬 확인용 CLI가 같은 함수를 씁니다.

```bash
npm run analyze -- --sites SIM-A,SIM-B,SIM-C --days 120        # 끝 시각 기본값 = 지금
npm run analyze -- --sites SIM-B --days 30 --to 2026-09-15T00:00:00+09:00 --assets 57,58 --budget-min 10
```

1. `om.analysis_run` 행을 만들고, 전용 연결의 트랜잭션에서 사이트 id 순서대로 `pg_try_advisory_xact_lock(hashtext('om.analysis_run'), site_id)`를 잡습니다. 하나라도 못 잡으면 실행 행을 `failed`로 남기고 거절합니다(`AnalysisBusyError`). 잡은 뒤 같은 사이트를 포함한 채 시간 예산의 두 배보다 오래 `running`으로 남은 실행만 중단된 실행으로 보고 `failed`로 정리합니다(방금 들어와 잠금을 기다리는 다른 요청의 행은 건드리지 않음).
2. 대상 사이트 포인트의 남은 dirty 롤업을 처리합니다.
3. 설비별 에피소드 추출: `[from − 6시간의 KST 0시, to)`(앞 실행이 끝에 걸려 `open`으로 저장한 에피소드가 있으면 그 시작부터)를 다시 뽑아, 그 구간의 기존 에피소드를 지우고 새로 넣습니다. 전해조·연료전지 스택은 창 시작 전 마지막 운전 샘플을 따로 조회해(기본키 인덱스 역순) 창 첫 기동의 꺼짐 시간·냉간 여부를 전체 추출과 같게 잽니다.
4. `om.kpi_daily` upsert (인버터 발전량·비발전량·동종 비율·가용률, 사이트 합계, 랙 왕복효율, 전해조 SEC, 연료전지 원단위·기준 전류밀도 전압).
5. 탐지기 6종: 저장된 에피소드 전체 이력(기준선부터)과 `om.asset_event`(설비·상위 설비, `resets_baseline` 반영), 활성 `om.detector_config`(default < class < asset)로 `lib/analytics/pipeline`이 입력을 조립합니다. `dq.gap_flatline`은 1시간 롤업 공백과 원시 고착 구간을 SQL로 요약합니다(사이트에 데이터가 있는 구간만). 고착 구간 끝은 마지막 샘플 + 주기이고 길이가 `metric_def.flatline_max_s` 이상이면 고착이며, 일사량(POA·GHI, 기준 2시간)은 야간 |값| ≤ 5 W/m² 구간을 뺍니다. 같은 규칙을 `lib/analytics/dq/summary.ts`(메모리 평가 경로)가 순수 함수로 갖고 integration 테스트가 두 경로 결과가 같은지 확인합니다. 용량 감소 finding이 나면 대표 세션 충전 곡선을 읽어 오버레이를 채웁니다.
   - `el.voltage_rise`·`fc.voltage_decay`: CUSUM 변화 시작점 뒤 누적 운전시간이 300 h(`minHoursAfterChange`) 이상이고 변화 전·후 기울기 95% CI가 겹치지 않으면 변화점 이후 기울기를 효과로 쓰고, 전체·변화 전 기울기는 근거에 남깁니다(열화율이 도중에 바뀐 스택의 크기 과소 추정 방지).
   - `ess.capacity_fade` 방식 우선순위: CV 종료 앵커 > 휴지 앵커(`rest_anchored`: 30분 이상 휴지 끝 SOC 두 점 사이 순 Ah ÷ ΔSOC, |ΔSOC| ≥ 25%, 중간 충방전 허용, 불확실도 역분산 가중) > CC 구간 Ah > 부분 충전 SOC 변화. 앞 방식이 판정 불능이면 다음 방식을 씁니다. SOC 기반 방식은 근거에 "BMS SOC 재보정 품질에 의존" 주의 코드를 남기고 화면·리포트가 문구로 보여 줍니다.
   - 기준은 bin별로 고릅니다: 기준선 재설정 이후 조건 bin마다 가장 이른 5개(`referencePerBin`)가 그 bin의 기준이고, 주 bin(최근 가중치 최대) 기준 시점과 120일(`maxReferenceSpreadDays`) 넘게 떨어진 bin은 결합에서 뺍니다(근거 bin 표에 기준 기간·제외 이유). `detector_config.reference_window`가 있으면 그 창이 우선입니다. 휴지 앵커는 `ess.rest@2` 에피소드(휴지 끝 SOC·휴지 중 순 Ah)가 필요합니다.
6. finding upsert: `dedup_key = 탐지기|설비|고장모드`. 열린 건은 갱신(`last_detected_at`·`detection_count`·심각도·신뢰도·효과, 조치 이후 악화면 system이 `reopened`), 없으면 억제 기간 안의 기각 건이면 건너뛰고 아니면 새로 만듭니다(닫힌 이전 건은 `previous_finding_id`). 근거는 매번 `finding_evidence`에 추가합니다(`input_hash`).
7. 조치 효과 검증: 후 창(`performed_at + stabilization_days`부터 `window_days`, 기본 30일)이 `to`까지 채워진 정비 조치를 `matched_before_after@1`로 비교해 `om.action_verification`에 upsert하고, `improved`이면 연결 발견사항을 system이 `verified`로 옮깁니다.
8. 설비·탐지기 단위 오류와 시간 예산(기본 15분) 초과는 기록하고 계속해 `partial`, 실행 전체가 실패하면 `failed`로 끝납니다. `stats`에 사이트별 설비·에피소드·KPI 행·탐지기별 ok/부족/오류/finding·finding 생성·갱신·억제·재발·검증 결과·소요시간이 남습니다.

상태 전이(`lib/analysis/transitions.ts`, 규칙은 `transition-rules.ts`): `triageFinding`(new·reopened → triaged), `dismissFinding`(사유 필수, 억제 기간, 사유가 '운영 조건 변경'이면 `resetBaseline`으로 기준선 분할 `asset_event` 생성), `reopenFinding`, `markFindingsInReport`(리포트 승인 시), `registerMaintenanceAction`(조치 기록 + `action_taken`). `verified`는 조치 검증(system)만 기록합니다.

### 분석 데스크 화면 (`/desk`, `/desk/[findingId]`)

- **분석 실행**: 사이트(여러 개)·설비(선택)·기간(최근 30/90/120일·사용자 지정)을 골라 Server Action이 `runAnalysis`를 부릅니다(화면 시간 예산 10분, 페이지 `maxDuration` 800초). 결과 요약(새 발견사항·갱신·판정 불가 탐지기·소요 시간)과 최근 실행 10건을 보여 주고, 리포트는 만들지 않습니다.
- **인박스**: 필터(사이트·도메인·카테고리·최소 심각도·상태, URL 쿼리)와 정렬(심각도×신뢰도 → 심각도 → 최근 탐지)은 `lib/desk/inbox.ts` 순수 규칙입니다. 일괄 분류(triaged)와 일괄 기각(사유 필수, 억제 기간, '운영 조건 변경'이면 발생 시점에 기준선 분할 이벤트)을 합니다. 최근 탐지 500건 안에서 거릅니다.
- **워크스페이스**: 탐지기 신뢰 배지(`lib/analytics/scorecard.json`), 효과 카드(효과 크기·95% CI — 점추정과 CI 경계가 표시상 같아지면 최대 소수 3자리까지 늘리는 `formatEffectWithCi`, 리포트와 같은 규칙·같은 조건 문장·기준 전류 환산 충전시간), 같은 조건 비교표(bin별 기준 기간·제외 이유·SOC 기반 추정 주의), 에피소드 오버레이(경과시간/누적 Ah/SOC 축), 추세 산점도(Theil–Sen 선·기울기 CI 밴드·CUSUM 변화 시작·SOH 80% 도달 예상일 — 데이터 60일 이상·기울기 CI 상한 < 0·10년 이내일 때만 날짜, 아니면 "추세 확인 중(데이터 N일)", `lib/desk/projection.ts`), 원시 시계열(에피소드·결측 구간 밴드, 확대 시 `/api/series`), 동종 비교, 원인 후보 판별 체크와 플레이북, 권고 조치 기록(→ `maintenance_action`, `action_taken`), 활동 타임라인. 근거 스냅샷 jsonb는 `lib/desk/evidence.ts`가 표시 모델로 읽습니다.
- **오늘**: 할 일 카운터(새 발견사항·조사 중·조치 후 검증 대기·최근 7일 검증 결과)와 새 발견·다시 열림 상위 10건. **플릿**: 열린 발견사항 최고 심각도 4 이상 위험, 2 이상 주의.
- **시뮬레이터**(`/sim`): `HYSOL_SHOW_SIM=1`일 때만 메뉴·라우트가 열리며 스코어카드의 게이트·탐지기별 성능·최소 탐지 크기 곡선을 보여 줍니다. 플래그가 없으면 `proxy.ts`가 HTTP 404로 응답합니다(화면은 '찾을 수 없습니다').

### 코칭 리포트 (`/reports`, `/reports/[id]`, `/reports/[id]/print`, `lib/report`)

분석과 분리되어 있습니다(설계 §0): 분석 실행은 리포트를 만들지 않고, 리포트 만들기는 분석을 실행하지 않습니다. 메일 발송·서버 PDF·LLM은 없습니다.

- **리포트 만들기**: 사이트·기간(월간/분기/사용자 지정, KST 날짜 경계)을 고르고 포함할 발견사항을 체크합니다(기본: 기간에 겹치는 열린 발견사항 중 심각도 2 이상 + 효과 확인된 발견사항, 조치 효과 검증 포함). Server Action이 `loadPackInput` → `buildEvidencePack`(`om.evidence-pack.v1`) → `templateComposer@1` → `validateDraft` → `om.report`(draft)로 저장합니다. 같은 사이트·기간·composer·팩 해시면 기존 리포트를 돌려줍니다.
- **EvidencePack**: 사이트·기간·일 KPI 요약(끝난 날만)·발전/수소 계측·발견사항(효과+CI, 근거 요약 ≤120점, 플레이북, 전이 이력)·데이터 품질(완결성 95% 미만 설비)·검증된 조치·시장가격 요약·출처(엔진·탐지기 버전, 팩 해시). 원시 시계열은 넣지 않습니다. 판정(확정: 신뢰도 0.7 이상·탐지 2회 이상 / 잠정 / 판정 보류: 탐지기별 최소 데이터 기간 미달)과 할 일 3개(심각도×신뢰도×추정 영향)는 `lib/report/planner.ts`가 정합니다. 팩 해시는 생성 시각을 뺀 안정 JSON 해시입니다.
- **초안**: 섹션(요약 / 이번 달·분기 할 일 / 발견사항 / 데이터 품질 요청 / 검증된 조치 효과 / KPI / 안전 고정 문구)의 블록마다 `citations`(팩 근거 id)와 `numberTokens`(본문 숫자 ↔ 팩 경로)를 둡니다. 탐지기별 문장 템플릿은 `lib/report/messages/`에 있습니다.
- **validateDraft**: 인용 id가 팩에 있음, 본문 숫자 = 토큰 = 팩 값(표시 반올림 허용, 추적되지 않은 숫자 금지), 심각도 4 이상 발견사항을 포함 블록이 모두 인용, 금지 표현(법정 안전 판단·인터록 대체, 안전 보장 등) 없음, 안전 고정 문구 포함, 팩 해시 일치, 효과 값 뒤 같은 문장의 방향 단어가 효과 부호와 맞음(템플릿은 부호로 "증가/감소"를 만들고, 편집으로 "감소"를 "증가"로 바꾸면 `direction_mismatch`, `lib/report/direction.ts`).
- **검토**: 블록 문장 편집(숫자·이름 토큰은 잠김 — 값·개수가 바뀌면 화면과 서버 모두 거절), 블록 포함/제외(사유 필수), 편집마다 재검증. 검증을 통과해야 승인할 수 있고, 승인하면 편집할 수 없으며 포함한 발견사항은 `in_report`, 같은 사이트·기간의 이전 초안·승인본은 `superseded`가 됩니다. 승인본은 "새 초안 만들기"로 같은 선택의 새 초안을 만듭니다(팩에 바탕 리포트 id를 남김).
- **인쇄 화면**: 콘솔 크롬 없는 A4 레이아웃(회사·사이트·기간·작성일, 포함한 블록, 발견사항·KPI 표, 근거 요약 정적 SVG 차트)입니다. "PDF 출력"은 `window.print()`이며 인쇄 대화상자에서 PDF로 저장합니다. 화면 테마와 상관없이 밝은 종이 색으로 그립니다.

### 조치 추적 (`/actions`, `/actions/[id]`, `lib/maintenance`)

- **조치 목록**: 사이트·설비·조치 유형·수행일·연결 발견사항·검증 상태(개선 확인·변화 없음·악화·데이터 부족 / 대기: 안정화 n/d일·after 창 n/d일·창 채워짐 / 검증 안 함). **검증 대기 큐**는 진행률과 함께 보여 줍니다.
- **직접 등록**: 사이트 → 설비 → (선택) 같은 설비의 열린 발견사항, 기대 효과(설비 종류로 계산할 수 있는 검증 지표만). 발견사항을 연결하면 `action_taken`이 됩니다.
- **CSV 가져오기**: 헤더 `site_code,asset_path,action_type,performed_at,performed_by,notes[,finding_id]`, `performed_at`은 `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:mm`(KST). 파일을 고르면 서버가 사이트·설비·발견사항·중복을 대조해 행 번호별 오류를 보여 주고, 오류가 없을 때만 한 트랜잭션으로 가져옵니다. 같은 설비·조치 종류·수행일시는 유니크 인덱스로 한 행만 두며, 검증 뒤 다른 가져오기가 먼저 넣은 행은 `ON CONFLICT DO NOTHING`으로 건너뛰고 결과 문구에 건수를 알립니다(직접 등록에서 중복이면 오류). `finding_id`가 있으면 그 탐지기의 기본 검증 지표로 기대 효과(최소 변화량 0, 기본 안정화 일수)를 채웁니다.
- **효과 검증**은 분석 실행 때 함께 계산됩니다(`lib/analysis/verification.ts`). 조치 상세의 "검증만 실행"은 `runAnalysis(..., { stages: 'verify' })`로 그 설비의 저장된 에피소드만 써서 전후 비교를 다시 계산합니다(롤업·추출·탐지 없음, 실행 이력에 "조치 효과 검증만"으로 남음). 상세 화면은 전후 같은 조건 bin 중앙값 차트·표와 효과·95% CI·판정을 보여 줍니다.

### 시뮬레이터 평가 게이트 (`sim:eval`)

DB·서버 없이 메모리 모드로 1년치 가상 데이터를 만들어 탐지기 성능을 재고, 설계 §5.5 CI 게이트를 판정합니다. 에피소드 추출·탐지기 입력 조립은 분석 실행(`lib/analysis`)과 같은 `lib/analytics/pipeline` 함수를 씁니다.

```bash
npm run sim:eval                                  # 전체: 시드 3 × 크기 스윕 5 (사이트 잡 33개)
npm run sim:eval -- --runs 3,4,5                  # CI 축소: 스윕 3~5번(용량 5·7·10%, 전해조 20·40 µV/h) — 용량·스택 게이트 주입은 전체와 같고 셀 불균형(월 20 mV)·데이터 품질(12시간)은 일부만
npm run sim:eval -- --cache .data/sim-eval        # 시뮬레이션·추출 결과를 저장해 두고 탐지기 파라미터만 바꿔 다시 평가
```

- 프리셋은 `lib/sim/presets.ts`의 `EVAL_PRESET`(2025-10-01부터 365일, 고장은 120일째 시작, 용량 감소는 30일에 걸쳐 진행)입니다. 스윕: SIM-A 랙 1·SIM-B 랙 1 용량 1·3·5·7·10%, SIM-A 랙 3 셀 전압 산포 월 5·10·20 mV, 인버터 0.5~3%p, 전해조·연료전지 5~40 µV/h, 데이터 품질 결측·고착 3·6·12시간. 사이트마다 난수·플랜트가 독립이라 같은 시드·시나리오인 사이트는 한 번만 시뮬레이션합니다(대조군 SIM-C는 시드당 1회).
- 잡은 자식 프로세스 N개(`--concurrency`, 기본 min(8, CPU−1))로 나눠 돌립니다. 이 PC(16코어)에서 전체 약 5분 20초, `--runs 3,4,5` 축소는 약 2분 20초입니다(휴지 앵커·데이터 품질 평가 추가 전 전체 3분 30초). 시드 하나만 고르면 게이트 주입이 2~3건이라 한 건의 지연이 중앙값을 좌우합니다(예: `--seeds 101 --runs 3,4`는 용량 5% 주입 지연 43일이 섞여 중앙값 31일로 미달). CI 코어가 적으면 `--runs 3,4,5`를 쓰고 `--concurrency`를 코어 수에 맞추세요.
- 주 단위 점검 시각마다 탐지기를 실행하고, 주입 설비는 하루 단위로 첫 탐지를 좁힙니다. 판정 규칙은 `lib/sim/eval/score.ts` 머리 주석에 있습니다: TP = 주입 설비·기대 고장모드 finding이 주입 시작~종료+7일에 나옴, FP = 그 밖의 finding(연속 점검은 한 건), 크기 오차 = 마지막 탐지 효과와 같은 창의 참값 차이(용량은 시뮬레이터 참 SOH 비율).
- 게이트: `ess.capacity_fade` SIM-A 5% 이상 재현율 ≥ 0.9·크기 MAE ≤ 1%p·지연 중앙값 ≤ 21일, SIM-B(연계형 부분 사이클) 5% 이상 재현율 ≥ 0.8·지연 ≤ 45일, 여름(6~8월) 연속 판정 불능 < 60일, SOC 상한 변경 대조군 변경 7일 뒤 판정 ok 점검 ≥ 1·변경 이후 finding 0 / 6종 오탐 ≤ 0.1건/자산·월 / `el.voltage_rise` 20 µV/h 이상 재현율 ≥ 0.9 / 전해조·연료전지 20 µV/h 이상 크기 상대오차 중앙값 ≤ 10% / `ess.cell_imbalance` 월 10 mV 이상 재현율 ≥ 0.9 / `dq.gap_flatline` 6시간 이상 결측·고착 재현율 ≥ 0.9. 스코어카드 용량 항목에는 사이트별 곡선·판정 불능 비율(전체·여름)·SOC 상한 변경 대조군 결과가 함께 남습니다. 하나라도 미달이면 종료 코드 1입니다. 평가할 주입이 없으면(축소 선택에서 빠짐) 미달로 봅니다.
- `dq.gap_flatline`은 저장값 수준 주입만 평가합니다: 결측(`dq.sample_loss`, 메모리 모드 값 NaN = 저장되지 않은 샘플, HTTP 적재에서는 보내지 않음)·고착(`dq.stuck_sensor`) 3·6·12시간을 SIM-A·SIM-B에 넣고 주 단위 점검마다 최근 7일 창을 DB 경로와 같은 요약 규칙으로 평가합니다. 전송 계층 단절 후 백필·지연·시계 오차는 메모리 모드가 재현하지 않아 DB E2E 모드에서 확인합니다.
- 전체 프리셋이면 `lib/analytics/scorecard.json`(탐지기별 재현율·정밀도·오탐률·지연·크기 오차·최소 탐지 크기 곡선, 게이트, 파라미터 조정 내역)을 갱신합니다. 일부만 돌리면 `--out`을 준 경우에만 씁니다. `npm run db:up`으로 로컬 DB가 떠 있으면 `sim.run`·`sim.injection`·`sim.eval_result`에도 기록합니다(`--no-db`로 끔).

### 테스트

테스트용 환경변수 파일을 한 번 만듭니다. `DATABASE_URL`의 DB 이름을 `hysol_test`로 바꾸고, `BETTER_AUTH_SECRET`·`INGEST_KEY_ENC_KEY`는 개발용과 다른 값, `E2E_ADMIN_PASSWORD`(12자 이상)를 채웁니다. E2E 브라우저도 한 번 설치합니다.

```bash
cp .env.example .env.test.local
npx playwright install chromium
```

integration·e2e는 `npm run db:up`이 떠 있어야 합니다. 꺼져 있으면 서버를 대신 띄우지 않고 "먼저 npm run db:up 을 실행하세요" 오류로 멈춥니다.

| 명령 | 내용 |
|---|---|
| `npm test` / `npm run test:unit` | Vitest unit (`lib/**`, `components/**`의 `*.test.ts`). DB 불필요 |
| `npm run test:integration` | Vitest integration (`tests/integration`). 테스트 DB를 최신으로 migrate한 뒤 스키마·마이그레이션 왕복·수집·분석 실행(재실행 멱등·동시 실행 잠금·partial/failed)·리포트·조치를 검사 |
| `npm run test:e2e` | Playwright (`tests/e2e`, chromium). `next build` 후 `next start -p 3100`을 띄우고, 테스트 DB 초기화(마이그레이션 down → up)·시드·테스트 관리자(`e2e-admin@hysol.local`) 생성, SIM-B 최근 2일을 실제 수집 API로 적재, 폐루프 시나리오용 SIM-A 과거 80일(고장 주입, `tests/e2e/closed-loop-plan.ts`)을 원시에 직접 적재한 뒤 실행(적재 약 30초). 끝나면 테스트 DB를 migrate·seed 직후 상태로 되돌린다 |
| `npm run test:all` | unit → integration → e2e 순서로 모두 실행 |
| `npx vitest run --project unit --coverage` | `lib/**` 커버리지 (`coverage/`). `lib/analytics/**`는 구문·분기·함수·라인 중 하나라도 80% 미만이면 실패 |

`tests/e2e/p2-closed-loop.spec.ts`는 한 흐름을 순서대로 이어 갑니다(serial): SIM-A 1차 기간 분석 → 용량 감소 워크스페이스(효과·CI·비교표·오버레이·판별 체크) → 셀 불균형 분류·조치 → 조치 뒤 비교 창이 지난 기간까지 재분석해 `improved` → `verified` → 인버터 발견사항 '운영 조건 변경' 기각·기준선 재설정 → 재분석에서 같은 발견사항 없음 → 리포트 만들기·숫자 잠금·승인(`in_report`)·인쇄 화면 → 분석이 리포트를 만들지 않음 → 조치 CSV 행 오류 → 비로그인 차단(가로챈 실제 Server Action 재전송 포함) → `/sim` 404.

integration과 e2e는 둘 다 테스트 DB의 마이그레이션을 모두 되돌렸다가 다시 적용하므로 동시에 실행하지 마세요. e2e가 끝난 테스트 DB에는 수집 데이터·테스트 계정이 남지 않습니다.

## 인증

Better Auth(이메일+비밀번호, 가입 비활성, admin 플러그인, DB 세션·rate limit)를 씁니다. 테이블은 `auth_*`이고 `db/migrations`로만 관리합니다(`auth migrate`를 직접 실행하지 않음).

- `proxy.ts`는 세션 쿠키가 있는지만 보고 없으면 `/login`으로 보냅니다.
- 실제 검사는 `lib/auth/dal.ts`의 `requireAdmin()`입니다. 콘솔의 모든 page, Server Action, Route Handler 첫 줄에서 호출합니다.
- 로그인은 브라우저에서 `/api/auth/sign-in/email`로 보냅니다. 서버의 `auth.api.*` 호출에는 rate limit이 적용되지 않기 때문입니다.

새 마이그레이션은 SQL 파일로 만듭니다.

```bash
npx node-pg-migrate create <이름> -j sql -m db/migrations --migration-filename-format utc
```

## 운영 RDS에 마이그레이션 적용

`npm run db:migrate`는 `.env.development.local`(로컬 DB)을 읽으므로 운영에는 쓰지 않습니다. `.env.local`의 옛 `DB_*` 변수는 읽지 않습니다. 운영용 env 파일을 따로 만들어(`.env*`는 git에 올라가지 않음, 예: `.env.rds.local`) 같은 스크립트를 실행합니다.

1. RDS CA 번들을 받습니다: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
2. env 파일에 연결 정보만 넣습니다 (마이그레이션은 인증·수집 비밀값이 필요 없습니다).
   ```bash
   DATABASE_URL=postgres://<user>:<password>@<rds-endpoint>:5432/<db>
   DATABASE_SSL=verify-full
   DATABASE_SSL_CA_PATH=<global-bundle.pem 경로>
   ```
3. 적용합니다. 셸에 `DATABASE_URL`이 남아 있으면 dotenv가 파일 값을 덮어쓰지 않으니 먼저 지우세요.
   ```bash
   npx dotenv -e .env.rds.local -- tsx scripts/db-migrate.ts up
   ```
   - 시작 줄에 접속 대상(비밀번호 제외)과 SSL 모드가 나옵니다. `verify-full`이면 CA 번들로 인증서 체인과 호스트 이름을 검증하고, CA 경로가 없거나 파일을 읽지 못하면 접속 전에 중단합니다.
   - `require`는 인증서를 검증하지 않아 운영에는 쓰지 않습니다.
   - 되돌리기: `... tsx scripts/db-migrate.ts down [개수]` (기본 1개)
4. `sim` 스키마 마이그레이션(`*_sim-eval-schema.sql`)은 시뮬레이터 평가용이라 앱이 참조하지 않지만, 적용 순서 검사 때문에 건너뛰지 말고 함께 적용합니다(빈 테이블만 생깁니다).
