"""Assemble the workbook spec (book.json) from research files.

Usage: py -3.11 build-book.py <repo>/docs/renewal/research out/book.json
"""
import html
import json
import re
import sys
from pathlib import Path

R = Path(sys.argv[1])
OUT = Path(sys.argv[2])
META = {"title": "태양광·수소 발전 데이터 수집·AI 분석 예상안", "company": "주식회사 퍼스트씨앤디", "date": "2026. 09. 14"}

DOMAINS = [
    ("pv", "태양광"), ("ess", "ESS"), ("system", "연계·계통"),
    ("electrolyzer", "수전해(PEM)"), ("storage", "압축·저장·안전"), ("fuelcell", "연료전지(PEM)"),
    ("gaps", "공통·부지"),
]
AI_DOMAINS = DOMAINS + [("ai_methods", "AI 공통"), ("ai_llm", "LLM·코칭"), ("ai_cases", "상용 사례"), ("gaps", "공통·운영")]
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


periodic_md = (R / "research-periodic-analysis-lifespan.md").read_text(encoding="utf-8")
T = md_tables(periodic_md)

sheets = []

# 0. 안내
sheets.append({
    "name": "안내", "title": "이 워크북 읽는 법",
    "description": "실제 원시데이터가 없는 상태에서 업계 표준·공공기관·제조사 자료를 근거로 만든 예상안입니다. 수치는 출처 기준이며 설비 사양이 정해지면 다시 확인해야 합니다.",
    "columns": cols([("시트", 22, None), ("내용", 90, None)]),
    "rows": [
        ["요약", "시트별 항목 수를 수식으로 집계"],
        ["수집데이터_전력", "태양광·ESS·계통·부지 공통 설비에서 보통 받는 운전 데이터(텔레메트리)"],
        ["수집데이터_수소", "수전해·압축저장·연료전지에서 보통 받는 운전 데이터"],
        ["운영·비정형 데이터", "명판·정비이력·알람코드·점검사진·설정값 등 계측 외 데이터"],
        ["설계수명·교체주기", "설비별 기대수명, 대표 열화율, 소모품·점검 주기"],
        ["법정 점검", "국내 법정 정기검사·자체점검 주기"],
        ["분석항목×주기", "월간·분기·연간 AI 분석으로 판정 가능한 항목과 리포트 문장 예시"],
        ["정기 리포트 구성", "월간·분기·연간·수시 리포트의 표준 섹션"],
        ["AI 분석 방법", "현장 질문 → 입력 데이터 → 방법 → 결과 → 개선 코칭"],
        ["개선항목·기대효과", "노후 지연·손실 회수 등 개선 여지와 근거"],
        ["축적기간별 로드맵", "데이터가 쌓이는 기간별로 가능해지는 분석"],
        ["검증 결과", "리서치 주장별 출처 대조 결과(검증·부분·미확인·반박)"],
        ["출처", "번호별 출처 목록"],
        {"cells": ["범례", "우선순위 필수=핵심 판정에 반드시 필요 / 권장=정확도·오탐 방지 / 선택=있으면 좋음. 주기 ●=해당 주기 리포트에서 판정"]},
    ],
    "filter": False, "freeze": False,
})

# 1. 요약 (formulas)
summary_rows = []
data_domains = [label for key, label in DOMAINS]
for label in data_domains:
    sheet_ref = "수집데이터_수소" if label in ("수전해(PEM)", "압축·저장·안전", "연료전지(PEM)") else "수집데이터_전력"
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
sheets.append({"name": "수집데이터_수소", "title": "수전해·압축저장·연료전지에서 보통 받는 데이터",
               "description": "PEM 전해조·수소 압축기·고압 저장·PEM 연료전지 기준. 안전 인터록 신호는 분석과 별도로 즉시 알람 대상입니다.",
               "columns": DATA_COLS, "rows": data_rows({"electrolyzer", "storage", "fuelcell"}), "freezeCols": 3})

# 4. 비정형
nt_rows = []
for key, label in AI_DOMAINS:
    for d in load(key).get("nonTelemetryData", []):
        nt_rows.append([label, clean(d["name_ko"]), clean(d["examples"]), clean(d["whyNeeded"])])
sheets.append({"name": "운영·비정형 데이터", "title": "계측 외에 함께 받아야 하는 데이터",
               "description": "명판·설계정보, 정비이력(=AI 학습 라벨), 알람코드, 점검 사진, 설정값 변경, 기상·시장가격 등.",
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
sheets.append({"name": "분석항목×주기", "title": "월간·분기·연간 AI 분석으로 판정 가능한 항목",
               "description": "●=해당 주기 리포트에서 판정. 월은 이상·손실, 분기는 추세(잠정), 연간·YoY는 열화율·수명(확정). 최소 데이터 기간 미달이면 리포트에 '판정 보류'로 표기합니다.",
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
sheets.append({"name": "AI 분석 방법", "title": "AI 분석으로 얻는 결과와 개선 방향",
               "description": "성숙도: 기술(현황)→진단(원인)→예측(수명)→처방(최적화). 정량 근거는 원 출처 기준이며 '검증 결과' 시트에서 대조 결과를 확인하세요.",
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
sheets.append({"name": "출처", "title": "출처 목록",
               "description": "'주기·수명' 번호는 설계수명·법정 점검·분석항목×주기·정기 리포트·개선항목 시트의 [n]과 대응합니다.",
               "columns": cols([("구분", 12, "center"), ("번호", 7, "center"), ("제목", 70, None), ("URL", 70, None)]),
               "rows": src_rows, "freezeCols": 1})

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
