# 분석 예상안 문서 재생성 소스

`../` 의 PPT·Word·엑셀을 다시 만들 때 쓰는 원고와 렌더러입니다. (초판 2026-09-14 · 제2판 2026-09-17 가평 P&ID 반영)

- `draft/report.json` — Word 원고(장·블록, 11장) · `draft/deck.json` — PPT 20장 구성 · `draft/factcheck.json` — 사실 검증 결과(23건, 모두 반영)
- `book.json` — 엑셀 워크북 구성(16시트) · `facts.json` — 문서에 쓴 집계 수치
- `charts*.json`, `charts/` — 차트 사양과 이미지(`charts.py`) · `first-logo.png` — 회사 로고

`build-book.py`는 두 곳에서 읽습니다.
- `docs/renewal/research/` — 설비·AI 심층 조사와 주기·수명 조사 (초판 그대로)
- `docs/renewal/research/pid/` + 저장소 시드 `db/seed/catalog.ts`·`templates-gapyeong.ts` — 가평 2MW 청정수소발전
  P&ID(FCND-GP-PID-002 REV.2) 반영분. 계측 항목·설비 트리·매핑된 태그·신설 요청 포인트는 **코드에서 직접 읽으므로**
  시드가 바뀌면 워크북도 따라 바뀝니다(사람이 옮겨 적은 값이 아닙니다).

재생성(전역 설치 필요: docx, pptxgenjs / Python 3.11: matplotlib, openpyxl, pymupdf / 폰트: Pretendard):
```bash
py -3.11 charts.py charts.json charts && py -3.11 charts.py charts-slide.json charts   # 수치가 바뀌면 먼저
NODE_PATH=$(npm root -g) node render-docx.js draft/report.json out.docx      # 차트 경로는 draft 기준 ../charts
NODE_PATH=$(npm root -g) node render-pptx.js draft/deck.json out.pptx        # deck.json meta.logo 경로를 ../first-logo.png 로 조정
py -3.11 build-book.py ../../renewal/research book.json && py -3.11 render-xlsx.py book.json out.xlsx
powershell -File excel-recalc.ps1 -Path out.xlsx   # Excel로 수식 재계산·오류 점검
powershell -File export-pdf.ps1 -InputPath out.docx -OutputPdf out.pdf   # Word/PowerPoint COM으로 PDF
```
스타일은 회사 레퍼런스(커넥티드모빌리티_자세변경알림_효과분석.pptx/.docx) 규격을 따릅니다.
