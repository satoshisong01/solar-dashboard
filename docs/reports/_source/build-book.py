"""Assemble the workbook spec (book.json) from research files.

Usage: py -3.11 build-book.py <repo>/docs/renewal/research out/book.json
"""
import html
import json
import re
import sys
from pathlib import Path

R = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2])
REPO = R.parents[2]  # <repo>/docs/renewal/research -> <repo>
META = {"title": "태양광·수소 발전 데이터 수집·AI 분석 예상안", "company": "주식회사 퍼스트씨앤디", "date": "2026. 09. 22"}

DOMAINS = [
    ("pv", "태양광"), ("ess", "ESS"), ("system", "연계·계통"),
    ("electrolyzer", "수전해(PEM)"), ("storage", "압축·저장·안전"), ("fuelcell", "연료전지(PEM)"),
    ("gaps", "공통·부지"),
]
AI_DOMAINS = DOMAINS + [("ai_methods", "AI 공통"), ("ai_llm", "LLM·코칭"), ("ai_cases", "상용 사례"), ("gaps", "공통·운영")]
# 가평 2MW 청정수소발전 P&ID(FCND-GP-PID-002 REV.2) 조사 — 본체 밖 부속 계통 다섯
PID_DOMAINS = [
    ("oxygen", "부산물 산소"), ("heat", "폐열회수"), ("water", "수처리"),
    ("pressure", "감압·버퍼"), ("supply", "외부 반입"),
]
PRIO = {"must": "필수", "should": "권장", "nice": "선택"}
MATURITY = {"descriptive": "기술(현황)", "diagnostic": "진단(원인)", "predictive": "예측(수명)", "prescriptive": "처방(최적화)"}
DIFF = {"low": "낮음", "medium": "중간", "high": "높음"}


def load(key):
    name = "gaps-fill" if key == "gaps" else f"research-{key}"
    return json.loads((R / "deep" / f"{name}.json").read_text(encoding="utf-8"))


def clean(s):
    return html.unescape(str(s or "")).strip()


def md_tables(md):
    """Return {section_heading: [rows...]} for every markdown table (header row first)."""
    out, heading, rows = {}, None, None
    for line in md.splitlines():
        if line.startswith("### "):
            heading, rows = line[4:].strip(), None
            continue
        if line.startswith("|"):
            cells = [clean(c) for c in line.strip().strip("|").split(" | ")]
            if re.fullmatch(r"[-:| ]+", line.replace(" ", "")):
                continue
            if rows is None:
                rows = out.setdefault(heading, [])
            rows.append(cells)
        else:
            rows = None
    return out


def cols(spec):
    return [{"header": h, "width": w, **({"align": a} if a else {})} for h, w, a in spec]


# ── 가평 P&ID 반영 ────────────────────────────────────────────────────────
# 조사 원문(docs/renewal/research/pid/)과 저장소 구현(db/seed/)에서만 값을 읽는다.
PID_DIR = R / "pid"
SEED = REPO / "db" / "seed"


def load_pid(key):
    return json.loads((PID_DIR / f"research-{key}.json").read_text(encoding="utf-8"))


PID = {key: load_pid(key) for key, _ in PID_DOMAINS}


def _read_seed(name):
    path = SEED / name
    if not path.exists():
        raise SystemExit(f"저장소 시드를 찾을 수 없습니다: {path}")
    return path.read_text(encoding="utf-8")


CATALOG_TS = _read_seed("catalog.ts")
GAPYEONG_TS = _read_seed("templates-gapyeong.ts")

# 1) 가평 반영으로 새로 만든 계측 항목 (catalog.ts의 '부산물 산소' 절 이후 전부)
_seg = CATALOG_TS[CATALOG_TS.index("// 부산물 산소 (가평 P&ID)"):]
_seg = _seg[:_seg.index("];")]
NEW_METRICS = [  # (key, name_ko, unit)
    (m[0], clean(m[1]), clean(m[2]))
    for m in re.findall(r"metric\('([^']+)', '([^']*)', '[^']*', '([^']*)'", _seg)
]
NEW_METRIC_NAME = {k: (n, u) for k, n, u in NEW_METRICS}
# 이름 조회는 카탈로그 전체로 한다 (기존 키를 한정자로 재사용하는 포인트도 한글 이름으로 보이게)
METRIC_NAME = {m[0]: (clean(m[1]), clean(m[2]))
               for m in re.findall(r"metric\('([^']+)', '([^']*)', '[^']*', '([^']*)'", CATALOG_TS)}

# 2) 가평 사이트 설비 트리와 도면 태그 매핑 — 설비 하나가 '    {' 로 시작하는 블록이다
_assets_src = GAPYEONG_TS[GAPYEONG_TS.index("export function gapyeongAssets()"):]
_assets_src = _assets_src[:_assets_src.index("\n}")]
ASSET_BLOCKS = [b for b in re.split(r"\n    \{\n", _assets_src)[1:]]


def _num(value):
    """시드의 숫자 구분 밑줄(50_000)을 사람이 읽는 형식(50,000)으로 바꾼다."""
    return re.sub(r"(?<=\d)_(?=\d)", ",", value.strip("'"))


def _nameplate(block):
    body = re.search(r"nameplate: \{([^{}]*)\}", block, re.S)
    if body is None:
        return ""
    pairs = re.findall(r"(\w+): ('[^']*'|[\w.]+)", body.group(1))
    known = [f"{k.replace('_', ' ')} {_num(v)}" for k, v in pairs if v != "null"]
    missing = [k.replace("_", " ") for k, v in pairs if v == "null"]
    return " · ".join(known) + (f"  (미확인: {', '.join(missing)})" if missing else "")


GP_ASSETS, GP_MAPPED = [], []
for _b in ASSET_BLOCKS:
    _code = re.search(r"code: '([^']+)'", _b)
    if _code is None:
        continue
    GP_ASSETS.append({
        "code": _code.group(1),
        "classKey": re.search(r"classKey: '([^']+)'", _b).group(1),
        "name": clean(re.search(r"name: '([^']+)'", _b).group(1)),
        "nameplate": _nameplate(_b),
        "criticality": re.search(r"criticality: (\d)", _b).group(1),
    })
    for pm in re.finditer(r"\['([^']+)', '[^']*', at\('([^']+)', ([\d_]+)(?:, '([^']*)')?\)\]", _b):
        GP_MAPPED.append((_code.group(1), pm.group(1), pm.group(4) or "",
                          pm.group(2), int(pm.group(3).replace("_", ""))))
GP_ASSET_NAME = {a["code"]: a["name"] for a in GP_ASSETS}

# 4) 신설 요청 포인트 (미설치) — required/recommended 호출을 그대로 읽는다
GP_PLANNED = []
for nec, fn in (("필수", "required"), ("권장", "recommended")):
    for pm in re.finditer(
            # 주석은 같은 줄 꼬리 주석만 읽는다 — \s*를 쓰면 다음 줄의 절 머리말(// B.x …)까지 붙는다
            rf"^  {fn}\((?:'([^']+)'|null), '([^']+)', '([^']+)', ([\d_]+)(?:, '([^']*)')?\),(?:[ \t]*//[ \t]*(.*))?$",
            GAPYEONG_TS, re.M):
        GP_PLANNED.append({
            "necessity": nec, "tag": pm.group(1) or "미지정", "asset": pm.group(2),
            "metric": pm.group(3), "periodS": int(pm.group(4).replace("_", "")),
            "qualifier": pm.group(5) or "", "note": clean(pm.group(6)),
        })

MAPPED_METRICS = {m[1] for m in GP_MAPPED}
REQUIRED_METRICS = {p["metric"] for p in GP_PLANNED if p["necessity"] == "필수"}
RECOMMENDED_METRICS = {p["metric"] for p in GP_PLANNED if p["necessity"] == "권장"}
PERIOD_BY_METRIC = {}
for _a, _m, _q, _t, _p in GP_MAPPED:
    PERIOD_BY_METRIC.setdefault(_m, _p)
for _p in GP_PLANNED:
    PERIOD_BY_METRIC.setdefault(_p["metric"], _p["periodS"])
ASSET_BY_METRIC = {}
for _a, _m, _q, _t, _p in GP_MAPPED:
    ASSET_BY_METRIC.setdefault(_m, _a)
for _p in GP_PLANNED:
    ASSET_BY_METRIC.setdefault(_p["metric"], _p["asset"])
TAG_BY_METRIC = {}
for _a, _m, _q, _t, _p in GP_MAPPED:
    TAG_BY_METRIC.setdefault(_m, _t)
for _p in GP_PLANNED:
    if _p["tag"] != "미지정":
        TAG_BY_METRIC.setdefault(_p["metric"], _p["tag"])

# 5) 조사 원문에서 '이 데이터로 알 수 있는 것'을 가져온다 (조사 파일의 source 번호는 시트에 쓰지 않는다)
PID_WHY, PID_AREA = {}, {}
for _key, _label in PID_DOMAINS:
    for _m in PID[_key]["metrics"]:
        PID_WHY.setdefault(_m["key"], clean(_m.get("why")))
        PID_AREA.setdefault(_m["key"], _label)

PID_DOMAINS_BY_LABEL = {label: key for key, label in PID_DOMAINS}
PID_DOMAIN_OF = [
    ("o2.", "부산물 산소"), ("hx.", "폐열회수"),
    ("water.", "수처리"), ("ro.", "수처리"), ("filter.", "수처리"), ("pump.", "수처리"),
    ("h2.pressure.", "감압·버퍼"), ("vent.", "감압·버퍼"),
    ("h2.delivery.", "외부 반입"), ("h2.trailer.", "외부 반입"), ("h2.vent.", "외부 반입"),
]


def pid_domain(key):
    for prefix, label in PID_DOMAIN_OF:
        if key.startswith(prefix):
            return label
    raise SystemExit("분야를 정할 수 없는 메트릭: " + key)


def priority_of(key):
    if key in MAPPED_METRICS or key in REQUIRED_METRICS:
        return "필수"
    return "권장" if key in RECOMMENDED_METRICS else "선택"


def pid_data_rows():
    rows = []
    order = {"필수": 0, "권장": 1, "선택": 2}
    for key, name, unit in NEW_METRICS:
        label = pid_domain(key)
        asset = GP_ASSET_NAME.get(ASSET_BY_METRIC.get(key, ""), "(설비 미지정 — 벤더 확인)")
        period = PERIOD_BY_METRIC.get(key)
        tag = TAG_BY_METRIC.get(key)
        area = PID_AREA.get(key, label)
        rows.append([
            label, asset, name, unit or "-",
            f"{period}초" if period else "계약 협의",
            priority_of(key),
            PID_WHY.get(key, ""),
            f"P&ID FCND-GP-PID-002 REV.2 · 계장 태그 {tag or '미지정(계약 협의)'} · 조사 research-{PID_DOMAINS_BY_LABEL[area]}",
        ])
    return sorted(rows, key=lambda r: ([label for _, label in PID_DOMAINS].index(r[0]), order.get(r[5], 3)))


periodic_md = (R / "research-periodic-analysis-lifespan.md").read_text(encoding="utf-8")
T = md_tables(periodic_md)

sheets = []

# 0. 안내
sheets.append({
    "name": "안내", "title": "이 워크북 읽는 법",
    "description": "실제 원시데이터가 없는 상태에서 업계 표준·공공기관·제조사 자료를 근거로 만든 예상안입니다. 수치는 출처 기준이며 설비 사양이 정해지면 다시 확인해야 합니다. "
                   "제2판(2026-09-17)에서 실제 사업 도면(가평 2MW 청정수소발전 P&ID, FCND-GP-PID-002 REV.2) 적용 결과를 더했고, 제3판(2026-09-22)에서 전해조 퍼지 카운터를 신설 요청 목록에 더했습니다. 초판 2026-09-14.",
    "columns": cols([("시트", 22, None), ("내용", 90, None)]),
    "rows": [
        ["요약", "시트별 항목 수를 수식으로 집계"],
        ["수집데이터_전력", "태양광·ESS·계통·부지 공통 설비에서 보통 받는 운전 데이터(텔레메트리)"],
        ["수집데이터_수소", "수전해·압축저장·연료전지에서 보통 받는 운전 데이터 + 가평 도면으로 더한 부속 계통 39행(산소·폐열·수처리·감압·반입)"],
        ["운영·비정형 데이터", "명판·정비이력·알람코드·점검사진·설정값 등 계측 외 데이터 + 반입·출하 전표 등 장부 데이터"],
        ["설계수명·교체주기", "설비별 기대수명, 대표 열화율, 소모품·점검 주기"],
        ["법정 점검", "국내 법정 정기검사·자체점검 주기"],
        ["분석항목×주기", "월간·분기·연간 AI 분석으로 판정 가능한 항목과 리포트 문장 예시(가평 구성 탐지기 3종 포함)"],
        ["정기 리포트 구성", "월간·분기·연간·수시 리포트의 표준 섹션"],
        ["AI 분석 방법", "현장 질문 → 입력 데이터 → 방법 → 결과 → 개선 코칭. 마지막 2행은 실제로 구현된 AI 설명 층"],
        ["개선항목·기대효과", "노후 지연·손실 회수 등 개선 여지와 근거"],
        ["축적기간별 로드맵", "데이터가 쌓이는 기간별로 가능해지는 분석"],
        ["검증 결과", "리서치 주장별 출처 대조 결과(검증·부분·미확인·반박)"],
        ["출처", "번호별 출처 목록(초판 485행 + 가평 도면 조사 119행)"],
        ["가평 사이트", "실제 사업 도면 적용 결과 — 설비 트리·명판, 매핑한 계장 태그, 신설 요청 포인트"],
        ["가평 P&ID 고장모드", "부속 계통 다섯 갈래의 고장 모드·신호·탐지 방법·오탐 함정·권장 조치"],
        {"cells": ["범례", "우선순위 필수=핵심 판정에 반드시 필요 / 권장=정확도·오탐 방지 / 선택=있으면 좋음. 주기 ●=해당 주기 리포트에서 판정. "
                           "명판·값의 '미확인'은 추정으로 채우지 않고 남긴 값이며 회신 대기 목록입니다"]},
    ],
    "filter": False, "freeze": False,
})

# 1. 요약 (formulas)
summary_rows = []
data_domains = [label for key, label in DOMAINS]
pid_labels = [label for key, label in PID_DOMAINS]
HYDROGEN_SHEET_LABELS = ("수전해(PEM)", "압축·저장·안전", "연료전지(PEM)", *pid_labels)
for label in data_domains + pid_labels:
    sheet_ref = "수집데이터_수소" if label in HYDROGEN_SHEET_LABELS else "수집데이터_전력"
    summary_rows.append([
        label,
        f"=COUNTIFS('{sheet_ref}'!$A:$A,\"{label}\",'{sheet_ref}'!$F:$F,\"필수\")",
        f"=COUNTIFS('{sheet_ref}'!$A:$A,\"{label}\",'{sheet_ref}'!$F:$F,\"권장\")",
        f"=COUNTIFS('{sheet_ref}'!$A:$A,\"{label}\",'{sheet_ref}'!$F:$F,\"선택\")",
        None,
    ])
for i, r in enumerate(summary_rows):
    row = 6 + i
    r[4] = f"=SUM(B{row}:D{row})"
first, last = 6, 5 + len(summary_rows)
summary_rows.append({"cells": ["합계", f"=SUM(B{first}:B{last})", f"=SUM(C{first}:C{last})", f"=SUM(D{first}:D{last})", f"=SUM(E{first}:E{last})"]})
sheets.append({
    "name": "요약", "title": "수집 데이터 항목 수 (분야 × 우선순위)",
    "description": "다른 시트의 행을 COUNTIFS로 집계합니다. 원본 시트를 고치면 자동으로 바뀝니다. 아래 표에 분석 주기별 항목 수가 이어집니다.",
    "columns": cols([("분야", 18, None), ("필수", 10, "center"), ("권장", 10, "center"), ("선택", 10, "center"), ("합계", 10, "center")]),
    "rows": summary_rows, "filter": False, "freeze": False,
    "notes": [],
})

# 2~3. 수집 데이터
def data_rows(keys):
    rows = []
    for key, label in DOMAINS:
        if key not in keys:
            continue
        for d in load(key)["dataToCollect"]:
            rows.append([label, clean(d["component"]), clean(d["name_ko"]), clean(d["unit"]), clean(d["sampling"]),
                         PRIO.get(d["priority"], d["priority"]), clean(d["whatItTells"]), clean(d["source"])])
    order = {"필수": 0, "권장": 1, "선택": 2}
    return sorted(rows, key=lambda r: (data_domains.index(r[0]), order.get(r[5], 3)))


DATA_COLS = cols([("분야", 13, "center"), ("구성품", 18, None), ("데이터 항목", 30, None), ("단위", 12, "center"),
                  ("수집 주기", 22, None), ("우선순위", 9, "center"), ("이 데이터로 알 수 있는 것", 60, None), ("출처·장치·프로토콜", 36, None)])
sheets.append({"name": "수집데이터_전력", "title": "태양광·ESS·계통·공통에서 보통 받는 데이터",
               "description": "인버터·BMS·계량기·기상센서 등에서 수집하는 운전 데이터. 우선순위 필수 항목부터 데이터 계약에 넣기를 권장합니다.",
               "columns": DATA_COLS, "rows": data_rows({"pv", "ess", "system", "gaps"}), "freezeCols": 3})
sheets.append({"name": "수집데이터_수소", "title": "수전해·압축저장·연료전지·부속 계통에서 보통 받는 데이터",
               "description": "PEM 전해조·수소 압축기·고압 저장·PEM 연료전지 기준. 안전 인터록 신호는 분석과 별도로 즉시 알람 대상입니다. "
                              "분야 ‘부산물 산소’~‘외부 반입’ 39행은 가평 2MW 청정수소발전 P&ID(FCND-GP-PID-002 REV.2)를 받아 더한 부속 계통 항목이며, "
                              "우선순위는 그 사이트의 매핑·신설 요청 구분입니다(필수=도면 태그가 있거나 없으면 판정 불가, 권장=정확도·오탐 방지).",
               "columns": DATA_COLS, "rows": data_rows({"electrolyzer", "storage", "fuelcell"}) + pid_data_rows(), "freezeCols": 3})

# 4. 비정형
nt_rows = []
for key, label in AI_DOMAINS:
    for d in load(key).get("nonTelemetryData", []):
        nt_rows.append([label, clean(d["name_ko"]), clean(d["examples"]), clean(d["whyNeeded"])])
# 가평 도면 검토로 드러난 장부 데이터 — 텔레메트리로는 절대 오지 않는다 (research/pid §4.3)
nt_rows += [
    ["장부·전표", "수소 반입 전표",
     "공급자, 트레일러 번호, 반입 질량[kg], 잔압(heel)[kg], 단가, 단가 기준(운송비·부가세 포함 여부), 청정수소 등급, 성적서 순도",
     "물질수지 식 ‘반입’ 항의 2순위 소스(1순위는 하역 적산계). 계량값과 건별로 대조해 편차율을 본다. 둘 다 없는 날은 판정 불능이다"],
    ["장부·전표", "산소 출하 전표",
     "구매자, 차량 번호, 출하 질량[kg], 단가, 순도, 법정 품질검사 번호",
     "산소 회수율(출하 ÷ 이론생산)과 방출 손실률의 분자. 압축기 투자 판단의 근거 자료가 된다"],
    ["장부·전표", "법정 산소 품질검사 기록",
     "1일 1회 이상 순도 99.5% 이상 확인 결과, 검사자, 검사 시각",
     "고압가스 안전관리법 시행규칙 별표4상 산소 제조자 의무. 준수율 100%가 목표이며 리포트 준수 절에 싣는다"],
    ["장부·전표", "세정·교체 이력",
     "열교환기 세정일과 세정액, RO 세정일, 혼상수지 교체일과 그때의 누적 통수량, 필터 교체",
     "기준선 리셋 시점. 남기지 않으면 성능 회복을 열화로, 교체 직후 값을 이상으로 오판한다"],
    ["장부·전표", "도면 리비전과 명판 회신",
     "P&ID 리비전 번호, 압력 기준(게이지/절대), Nm³ 기준조건(0/15/20 °C), 감압 단수·조정기 등급, 열교환기 벽 구조, 트레일러 형식",
     "숫자가 아니라 해석의 기준이다. 미확인이면 질량 환산과 임계가 전부 가정 위에 선다(수소 재고 3.3%, Nm³ 환산 약 7% 차이)"],
]
sheets.append({"name": "운영·비정형 데이터", "title": "계측 외에 함께 받아야 하는 데이터",
               "description": "명판·설계정보, 정비이력(=AI 학습 라벨), 알람코드, 점검 사진, 설정값 변경, 기상·시장가격, 반입·출하 전표 등.",
               "columns": cols([("분야", 13, "center"), ("데이터", 28, None), ("예시", 70, None), ("왜 필요한가", 60, None)]),
               "rows": nt_rows, "freezeCols": 2})

# 5. 설계수명
life_rows = []
for sec, area in [("A-1", "태양광"), ("A-2", "ESS"), ("A-3", "수전해(PEM)"), ("A-4", "압축·저장·안전"), ("A-5", "연료전지(PEM)")]:
    heading = next(h for h in T if h and h.startswith(sec))
    for cells in T[heading][1:]:
        if len(cells) == 4:  # A-4: 설비 | 수명·신뢰성 | 교체·점검·법정 | 출처
            cells = [cells[0], cells[1], "", cells[2], cells[3]]
        life_rows.append([area] + cells[:5])
sheets.append({"name": "설계수명·교체주기", "title": "설비별 설계수명·열화율·교체주기",
               "description": "[n]은 '출처' 시트 번호. '추정'은 원문에서 확인하지 못한 값이며 제조사 매뉴얼로 확정해야 합니다.",
               "columns": cols([("분야", 13, "center"), ("설비", 18, None), ("설계수명·기준", 48, None), ("대표 열화·신뢰성", 48, None), ("교체·점검 주기", 48, None), ("출처", 14, "center")]),
               "rows": life_rows, "freezeCols": 2})

# 6. 법정
legal = T[next(h for h in T if h and h.startswith("A-6"))]
sheets.append({"name": "법정 점검", "title": "국내 법정 점검·검사 주기",
               "description": "인허가 유형(고압가스 제조·저장·사용, 수소법)은 압력·저장능력·사업형태에 따라 달라지므로 한국가스안전공사 기술검토로 확정해야 합니다.",
               "columns": cols([("대상", 34, None), ("주기", 30, None), ("비고", 60, None), ("출처", 12, "center")]),
               "rows": legal[1:], "freezeCols": 1})

# 7. 분석항목×주기
def marks(cadence):
    c = cadence
    return ("●" if "월" in c else "", "●" if "분기" in c else "", "●" if re.search(r"연|YoY|년", c) else "")


matrix_rows = []
for sec, area in [("B-1", "태양광"), ("B-2", "ESS"), ("B-3", "수전해(PEM)"), ("B-4", "압축·저장·안전"), ("B-5", "연료전지(PEM)")]:
    heading = next(h for h in T if h and h.startswith(sec))
    for cells in T[heading][1:]:
        equip, item, data, cadence, period, sentence, src = (cells + [""] * 7)[:7]
        m, q, y = marks(cadence)
        matrix_rows.append([area, equip, item, data, m, q, y, cadence, period, sentence, src])
# 가평 P&ID 반영으로 만든 탐지기 3종 (lib/analytics/detectors/ — 구현 완료, 가상 대조군에서 오탐 0 확인)
matrix_rows += [
    ["감압·버퍼", "감압밸브 PRV", "감압밸브 시트 누설(락업 크리프)",
     "연료전지 정지·무유동 구간의 하류 압력 기울기[mbar/h]와 압력 설정값·상류 압력·외기온도",
     "●", "", "", "월간(무유동 hold 구간이 3회 이상 잡힐 때)", "21일 이상 · 하류 압력 60초 이하",
     "하류 압력이 무유동 구간에서 26 mbar/h로 오르고 있습니다(예시). 3회 연속 확인되어 조정기 점검을 요청합니다. "
     "공급압 효과(버퍼 압력 하강에 따른 설정압 상승)는 구간 전·후반 기울기 비교로 배제했습니다.",
     "가평 P&ID"],
    ["폐열회수", "열교환기 HX-301", "폐열회수 열교환기 성능 저하",
     "1·2차측 입출구 온도 4점으로 낸 UA와 접근온도, 양측 유량·차압(있으면)",
     "●", "●", "", "월간 이상 · 분기 추세(잠정)", "21일 이상(기준 14일, 세정 직후 권장) · 온도 60초 이하",
     "접근온도가 기준 대비 +3.4 K 올랐고 1차측 차압은 그대로입니다(예시). 스케일·막힘보다 표면 막 또는 유량 저하 쪽입니다. "
     "1차측 유량계가 없어 UA 대신 접근온도로 판정했습니다.",
     "가평 P&ID"],
    ["부산물 산소", "부산물 산소 계통", "산소 중 수소(HTO) 상승",
     "애노드 원가스 산소 중 수소 농도와 전해조 운전 유량·스택 전류, 법정 품질검사 기록",
     "●", "", "", "월간(전해조 운전 구간만)", "21일 이상(기준 14일) · 60초 이하",
     "산소 중 수소가 0.92 vol%로 법정 압축금지선(2 vol%)까지 1.08 vol%p 남았습니다(예시). "
     "저부하 비중 증가만으로도 오르므로 스택 전류 구간을 맞춰 비교했습니다.",
     "가평 P&ID"],
]
sheets.append({"name": "분석항목×주기", "title": "월간·분기·연간 AI 분석으로 판정 가능한 항목",
               "description": "●=해당 주기 리포트에서 판정. 월은 이상·손실, 분기는 추세(잠정), 연간·YoY는 열화율·수명(확정). 최소 데이터 기간 미달이면 리포트에 '판정 보류'로 표기합니다. "
                              "분야 ‘감압·버퍼’·‘폐열회수’·‘부산물 산소’ 3행은 가평 P&ID를 받아 실제로 만든 탐지기이며, 리포트 문장은 구현된 탐지기의 출력 형식입니다.",
               "columns": cols([("분야", 13, "center"), ("설비", 14, None), ("분석 항목", 26, None), ("무엇을 보나(데이터)", 36, None),
                                ("월", 6, "center"), ("분기", 6, "center"), ("연", 6, "center"), ("주기 상세", 28, None),
                                ("최소 데이터 기간·해상도", 28, None), ("리포트 문장 예시", 60, None), ("출처", 10, "center")]),
               "rows": matrix_rows, "freezeCols": 3})

# 요약 시트 뒤쪽에 주기 집계 추가
n_sum = len(summary_rows)
start = 6 + n_sum + 2
summary = sheets[1]
summary["rows"].append(["", "", "", "", ""])
summary["rows"].append({"cells": ["분석 주기", "항목 수", "", "", ""]})
for label, colL in [("월간", "E"), ("분기", "F"), ("연간", "G")]:
    summary["rows"].append([label, f"=COUNTIF('분석항목×주기'!{colL}:{colL},\"●\")", "", "", ""])

# 8. 정기 리포트 구성
rep_rows = []
for sec, kind in [("C-1", "월간"), ("C-2", "분기"), ("C-3", "연간"), ("C-4", "수시")]:
    heading = next(h for h in T if h and h.startswith(sec))
    for cells in T[heading][1:]:
        rep_rows.append([kind] + (cells + ["", "", ""])[:3])
sheets.append({"name": "정기 리포트 구성", "title": "정기 분석 리포트 표준 구성",
               "description": "월간 리포트가 업계 모범사례 주기이며, 분기는 월간 요약+추세, 연간은 계약 KPI·열화·교체계획을 담습니다. 수시 리포트는 1% 초과 손실·안전 이벤트 등으로 발행합니다.",
               "columns": cols([("리포트", 10, "center"), ("섹션", 30, None), ("내용", 80, None), ("출처", 16, "center")]),
               "rows": rep_rows, "freezeCols": 2})

# 9. AI 분석 방법
ai_rows = []
for key, label in AI_DOMAINS:
    for a in load(key)["aiAnalyses"]:
        ai_rows.append([label, clean(a["title"]), clean(a["question"]), "\n".join(clean(x) for x in a["inputs"]), clean(a["method"]),
                        clean(a["output"]), clean(a["improvement"]), clean(a["valueEvidence"]), clean(a["dataRequirements"]),
                        MATURITY.get(a["maturity"], a["maturity"]), DIFF.get(a["difficulty"], a["difficulty"])])
# AI 설명 층 (lib/llm/ — 구현 완료). 판정·수치는 통계 엔진이 만들고 LLM은 문장만 다시 쓴다.
ai_rows += [
    ["LLM·코칭", "발견사항 쉬운 말 설명 (AI 설명)",
     "이 발견사항이 무슨 뜻이고 무엇을 하라는 것인가",
     "분석 엔진이 만든 틀 문장 4줄\n효과 크기·신뢰구간·판정 등급\n설비·사이트 이름\n안전 고정 문구",
     "수치와 판정은 통계·규칙 기반 엔진이 확정하고, LLM(Gemini)은 이미 만들어진 틀 문장을 읽기 쉽게 다시 쓰기만 한다. "
     "LLM이 숫자를 계산하거나 원인을 단정하는 경로는 설계상 없다. 요청 1회·타임아웃 20초, 네트워크 오류만 1회 재시도하고 나머지는 즉시 폴백. "
     "생성문은 여섯 가지 검증을 통과해야 채택한다 — ①숫자·날짜는 엔진 문장에 있던 것만 개수까지 같게 ②설비·사이트 이름 보존 "
     "③반대 방향 단어 추가 금지 ④금지 표현(원인 단정·안전 판단 대체·법적 조언) ⑤안전 고정 문구 보존 ⑥줄 구성·길이",
     "읽기 쉬운 설명 4줄 + 생성문/틀 문장 배지",
     "현장 담당자가 근거를 따로 묻지 않아도 되는 수준의 설명. 검증에 하나라도 걸리면 채택하지 않고 틀 문장으로 되돌린다",
     "LLM 기반 시계열 예측 기법 3종에서 LLM 부분을 빼도 성능이 떨어지지 않았고 대부분 오히려 좋아졌다(Tan 외, NeurIPS 2024) "
     "— 판정에 LLM을 쓰지 않는 근거",
     "엔진 판정이 먼저 있어야 한다. API 키가 없거나 꺼져 있으면 틀 문장만 쓴다(앱 동작은 같다)",
     "기술(현황)", "중간"],
    ["LLM·코칭", "코칭 리포트 문장 다듬기",
     "월간·분기 리포트 초안을 사람이 읽기 좋게 쓸 수 있는가",
     "리포트 초안 섹션 문장\n발견사항·조치 이력·KPI 값\n금지 표현 목록",
     "리포트 초안 검증 규칙(숫자 토큰·방향 단어·금지 표현)을 그대로 쓰되 쉬운 말 4줄용으로 넓혔다. "
     "검토자가 승인하기 전에는 초안 상태로 남고, PDF 출력은 승인 후에만 된다",
     "검토 대기 상태의 리포트 초안",
     "검토자가 문장을 고치는 시간을 줄인다. 수치·판정은 바뀌지 않으므로 검토는 표현만 보면 된다",
     "생성문이 숫자를 하나라도 바꾸면 채택하지 않는다(검증 규칙 ①) — 리포트 수치의 출처는 항상 분석 엔진이다",
     "발견사항과 KPI가 먼저 계산돼 있어야 한다",
     "기술(현황)", "중간"],
]
sheets.append({"name": "AI 분석 방법", "title": "AI 분석으로 얻는 결과와 개선 방향",
               "description": "성숙도: 기술(현황)→진단(원인)→예측(수명)→처방(최적화). 정량 근거는 원 출처 기준이며 '검증 결과' 시트에서 대조 결과를 확인하세요. "
                              "마지막 2행(‘AI 설명’·‘리포트 문장 다듬기’)은 실제로 구현된 LLM 층이며, 수치는 통계 엔진이 만들고 LLM은 문장만 다시 씁니다.",
               "columns": cols([("분야", 12, "center"), ("분석", 26, None), ("답하는 현장 질문", 36, None), ("입력 데이터", 36, None), ("방법", 50, None),
                                ("결과물", 36, None), ("개선·코칭", 40, None), ("정량 근거", 40, None), ("필요 데이터 조건", 36, None),
                                ("성숙도", 12, "center"), ("난이도", 8, "center")]),
               "rows": ai_rows, "freezeCols": 2})

# 10. 개선
imp = T[next(h for h in T if h is None or False)] if False else None
imp_rows, road_rows = [], []
sections = re.split(r"\n## ", periodic_md)
for s in sections:
    if s.startswith("D."):
        tbl = md_tables("### D\n" + s)["D"]
        imp_rows = tbl[1:]
    if s.startswith("E."):
        tbl = md_tables("### E\n" + s)["E"]
        road_rows = tbl[1:]
sheets.append({"name": "개선항목·기대효과", "title": "개선 여지와 기대효과",
               "description": "정량 효과는 출처 조건 기준입니다(사이트 조건에 따라 달라짐).",
               "columns": cols([("영역", 12, "center"), ("개선 항목", 32, None), ("기대효과(출처 기준)", 80, None), ("필요 분석·주기", 32, None), ("출처", 14, "center")]),
               "rows": imp_rows, "freezeCols": 2})
sheets.append({"name": "축적기간별 로드맵", "title": "데이터 축적 기간별로 가능해지는 분석",
               "description": "초기 1~2년은 고장 집중 구간이므로 열화 판정보다 이상·결함 탐지에 비중을 둡니다.",
               "columns": cols([("시점", 18, "center"), ("가능해지는 분석", 90, None), ("아직 불가·주의", 50, None), ("근거", 16, "center")]),
               "rows": road_rows, "freezeCols": 1, "filter": False})

# 11. 검증
KEYS = {"pv": "태양광", "ess": "ESS", "system": "연계·계통", "electrolyzer": "수전해(PEM)", "storage": "압축·저장·안전",
        "fuelcell": "연료전지(PEM)", "ai_methods": "AI 공통", "ai_llm": "LLM·코칭", "ai_cases": "상용 사례"}
VERD = {"verified": "검증", "partially_verified": "부분 확인", "unverified": "미확인", "contradicted": "반박"}
ver_rows = []
for g in ("solar", "hydrogen", "ai"):
    for v in json.loads((R / "deep" / f"verify-{g}.json").read_text(encoding="utf-8"))["verdicts"]:
        ver_rows.append([KEYS.get(v["researchKey"], v["researchKey"]), VERD.get(v["verdict"], v["verdict"]), clean(v["claim"]),
                         clean(v["correctedClaim"]), clean(v["note"]), clean(v["evidenceUrl"])])
ver_rows.sort(key=lambda r: ["반박", "미확인", "부분 확인", "검증"].index(r[1]) if r[1] in ["반박", "미확인", "부분 확인", "검증"] else 9)
sheets.append({"name": "검증 결과", "title": "리서치 주장 출처 대조 결과",
               "description": "검증 에이전트가 출처 URL을 직접 열어 수치·조건을 대조했습니다. 반박·부분 확인 항목은 '출처 기준 문장'을 사용하세요.",
               "columns": cols([("분야", 12, "center"), ("판정", 10, "center"), ("원 주장", 60, None), ("출처 기준 문장", 60, None), ("비고", 40, None), ("근거 URL", 40, None)]),
               "rows": ver_rows, "freezeCols": 2})

# 12. 출처 (주기·수명 문서 F절 번호 + 설비·AI 리서치 출처)
src_rows = []
for sec in re.split(r"\n## ", periodic_md):
    if sec.startswith("F."):
        for cells in md_tables("### F\n" + sec)["F"][1:]:
            src_rows.append(["주기·수명", cells[0], cells[1], cells[2] if len(cells) > 2 else ""])
seen = set()
for key, label in AI_DOMAINS:
    for s in load(key)["sources"]:
        url = clean(s["url"])
        if url in seen:
            continue
        seen.add(url)
        src_rows.append([label, "", clean(s["title"]), url])
# 가평 P&ID 조사 출처 119건 — 영역별 번호는 research/pid/research-<영역>.json의 sources[n]과 같다
pid_src_count = 0
for key, label in PID_DOMAINS:
    for s in PID[key]["sources"]:
        src_rows.append([f"가평 P&ID·{label}", str(s.get("n", "")), clean(s["title"]), clean(s["url"])])
        pid_src_count += 1
sheets.append({"name": "출처", "title": "출처 목록",
               "description": f"'주기·수명' 번호는 설계수명·법정 점검·분석항목×주기·정기 리포트·개선항목 시트의 [n]과 대응합니다. "
                              f"'가평 P&ID·…' {pid_src_count}행은 실제 사업 도면 조사(부산물 산소·폐열회수·수처리·감압과 버퍼·외부 반입)의 출처이며, "
                              f"번호는 영역별로 따로 매겨져 있습니다.",
               "columns": cols([("구분", 16, "center"), ("번호", 7, "center"), ("제목", 70, None), ("URL", 70, None)]),
               "rows": src_rows, "freezeCols": 1})

# 13. 가평 사이트 (실제 사업 도면 적용 결과 — 설비 트리·매핑된 태그·신설 요청 포인트)
GP_STATUS = {"필수": "신설 요청 (필수)", "권장": "신설 요청 (권장)"}
gp_rows = [{"cells": ["설비 트리", "코드", "이름", "명판 (도면 표기 그대로 · 미확인은 그대로 남긴다)", "", "중요도"]}]
for a in GP_ASSETS:
    gp_rows.append(["설비", a["code"], a["name"], a["nameplate"] or "(명판 미확인 — 벤더 회신 대기)", "", a["criticality"]])
gp_rows.append({"cells": ["도면 계장 태그", "태그", "계측 항목", "설비 · 한정자", "주기", "상태"]})
for code, metric, qual, tag, period in sorted(GP_MAPPED, key=lambda x: x[3]):
    name, unit = METRIC_NAME.get(metric, (metric, ""))
    gp_rows.append(["계장", tag, f"{name} [{metric}]" if name != metric else metric,
                    code + (f" · {qual}" if qual else ""), f"{period}초", "매핑 완료"])
gp_rows.append({"cells": ["신설 요청 포인트", "태그", "계측 항목", "설비 · 한정자", "주기", "필요도"]})
for p in sorted(GP_PLANNED, key=lambda x: (x["necessity"] != "필수", x["tag"])):
    name, unit = METRIC_NAME.get(p["metric"], (p["metric"], ""))
    gp_rows.append(["요청", p["tag"], f"{name} [{p['metric']}]" if name != p["metric"] else p["metric"],
                    p["asset"] + (f" · {p['qualifier']}" if p["qualifier"] else "") + (f"  — {p['note']}" if p["note"] else ""),
                    f"{p['periodS']}초", GP_STATUS[p["necessity"]]])
sheets.append({"name": "가평 사이트", "title": "가평 2MW 청정수소발전 — 도면 적용 결과 (FCND-GP-PID-002 REV.2)",
               "description": f"고객사가 보낸 실제 사업 도면을 그대로 넣은 결과입니다. 설비 {len(GP_ASSETS)}개를 도면 명판대로 등록했고, "
                              f"계장 태그 {len(GP_MAPPED)}점은 계측 항목에 바로 매핑했으며, 나머지 {len(GP_PLANNED)}행"
                              f"(필수 {sum(1 for p in GP_PLANNED if p['necessity'] == '필수')}·"
                              f"권장 {sum(1 for p in GP_PLANNED if p['necessity'] == '권장')})은 미설치라 데이터 계약 요청 목록이 됩니다. "
                              "명판의 '미확인'은 추정값으로 채우지 않고 그대로 남긴 값이며, 그 자체가 벤더·설계사 회신 대기 목록입니다.",
               "columns": cols([("구분", 14, "center"), ("코드·태그", 16, None), ("이름·계측 항목", 34, None),
                                ("명판 · 설비·한정자", 70, None), ("주기", 10, "center"), ("상태·중요도", 16, "center")]),
               "rows": gp_rows, "freezeCols": 2, "filter": False})

# 14. 가평 P&ID 고장모드 (조사 5건의 failureModes)
fm_rows = []
for key, label in PID_DOMAINS:
    for f in PID[key]["failureModes"]:
        # 조사 파일의 source는 그 영역 sources[n] 번호다 — '출처' 시트에서 찾을 수 있게 영역을 붙인다
        src = clean(f.get("source"))
        fm_rows.append([label, clean(f.get("mode")), clean(f.get("signal")), clean(f.get("detectionMethod")),
                        clean(f.get("falsePositiveTraps")), clean(f.get("recommendedAction_ko")),
                        clean(f.get("severityHint")),
                        f"{label} [{src}]" if re.fullmatch(r"[\d,\s\[\]s]+", src) else src])
sheets.append({"name": "가평 P&ID 고장모드", "title": "부속 계통 다섯 갈래의 고장 모드와 오탐 함정",
               "description": f"가평 도면 조사에서 정리한 고장 모드 {len(fm_rows)}건입니다. '오탐 함정'은 다른 원인이 같은 신호를 그대로 흉내 내는 경우이며, "
                              "탐지기를 켜기 전에 이 목록으로 판별 체크를 먼저 설계합니다. 안전 판단은 현장 설비·PLC 인터록의 몫이며 콘솔이 대신하지 않습니다.",
               "columns": cols([("영역", 12, "center"), ("고장 모드", 26, None), ("데이터에 나타나는 신호", 46, None),
                                ("탐지 방법", 50, None), ("오탐 함정", 46, None), ("권장 조치", 46, None),
                                ("심각도", 10, "center"), ("출처", 14, "center")]),
               "rows": fm_rows, "freezeCols": 2})

# Fact-check corrections: align workbook text with verified wording used in the report and deck
CORRECTIONS = [
    ("30mA 급변·300mA 연속 트립 전 누설 증가 추세", "30mA 급변 트립 전 누설 증가 추세(SMA 매뉴얼 기준, 300mA 연속 기준은 미확인)"),
    ("근본원인이 밝혀진 ESS 사고의 89%가 제어·주변설비(BOS) 관련이고, 86%는 셀 제조결함이 아님", "원인이 분류된 ESS 사고 26건 중 셀 직접 원인은 3건(11%)"),
    ("89%가 제어·주변설비 관련", "원인 분류 26건 중 셀 직접 원인 3건(11%)"),
    ("수명 저하 기여: 버스 실운전 기준 부하변동 56.5%, 기동정지 33%", "수명 저하 기여: 차량용 연구 기준 부하변동 약 57%·기동정지 약 33%(Pei 2008, 2차 인용, 정치형은 재산정)"),
    ("버스 실운전 기준 열화 기여 부하변동 56.5%, 기동정지 33%", "차량용 연구 기준 열화 기여 부하변동 약 57%·기동정지 약 33%(Pei 2008, 2차 인용)"),
    ("연 오염손실 1.91% 사례(애리조나)에서 세척 1회 1.52%(−20%), 2회 1.32%(−31%), 3회 1.20%(−37%).", "Micheli 2021: 스페인 남부 1 MW(연 오염손실 3% 이내 지역), 여름 ±31일 창 안 연 1회 최적 세척 시 이익 최대 3.6%."),
    ("정량 효과는 셀 데이터로 재산정 필요(추정)", "셀 온도를 연중 20~30°C로 유지하면 수명 4.9년→7.0년(NREL Smith 2017 수명모델, 용량 70% 기준·DOD 74%, 시뮬레이션)"),
    ("스페인 1MW 사이트는 연 오염 손실이 2.8%에 불과했지만 세척 일정 최적화로 이익이 최대 3.6% 증가했다", "스페인 1MW 사이트(연 오염 손실 3% 이내 지역)에서도 세척 일정 최적화로 이익이 최대 3.6% 증가했다"),
    ("22대 알칼라인 전해조 플랜트에서 온도·HTO 동특성 반영 스케줄링이 기존 방식 대비 수소 +7.74%, 이익 +8.72%였고", "풍력 직결·완벽 예측을 가정한 22대 알칼라인 전해조 플랜트 단일 시뮬레이션에서 온도·HTO 동특성 반영 스케줄링이 수소 +7.74%, 이익 +8.72%였고"),
    ("22대 플랜트 사례 수소 +7.74%·수익 +8.72%", "풍력 직결·완벽 예측 가정 22대 플랜트 단일 시뮬레이션 수소 +7.74%·수익 +8.72%"),
    ("MILP 스케줄링으로 연간 가용에너지 89.7% 흡수·가동률 93.7%, 기동정지 764회를 설비 간 균등 분배(IJHE 2021, 모델 연구). ", ""),
]
SKIP = {"검증 결과", "출처"}
for rule_from, rule_to in CORRECTIONS:
    hits = 0
    for sh in sheets:
        if sh["name"] in SKIP:
            continue
        for row in sh["rows"]:
            cells = row["cells"] if isinstance(row, dict) else row
            for i, v in enumerate(cells):
                if isinstance(v, str) and rule_from in v:
                    cells[i] = v.replace(rule_from, rule_to)
                    hits += 1
    print(("ok  " if hits else "MISS"), hits, rule_from[:40])
    if not hits:
        raise SystemExit("correction did not match: " + rule_from)
for sh in sheets:
    if sh["name"] == "AI 분석 방법":
        sh["description"] += " 출처 대조에서 반박·미확인으로 판정된 수치는 정정하거나 삭제했습니다."

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"meta": META, "sheets": sheets}, ensure_ascii=False, indent=1), encoding="utf-8")
print("sheets:", [(s["name"], len(s["rows"])) for s in sheets])
