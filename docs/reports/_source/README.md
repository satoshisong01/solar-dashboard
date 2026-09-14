# 분석 예상안 문서 재생성 소스

`../` 의 PPT·Word·엑셀을 다시 만들 때 쓰는 원고와 렌더러입니다. (2026-09-14)

- `draft/report.json` — Word 원고(장·블록) · `draft/deck.json` — PPT 15장 구성 · `draft/factcheck.json` — 사실 검증 결과(23건, 모두 반영)
- `book.json` — 엑셀 워크북 구성(`build-book.py`가 `docs/renewal/research/`에서 조립) · `facts.json` — 문서에 쓴 집계 수치
- `charts*.json`, `charts/` — 차트 사양과 이미지(`charts.py`) · `first-logo.png` — 회사 로고

재생성(전역 설치 필요: docx, pptxgenjs / Python 3.11: matplotlib, openpyxl, pymupdf / 폰트: Pretendard):
```bash
NODE_PATH=$(npm root -g) node render-docx.js draft/report.json out.docx      # 차트 경로는 draft 기준 ../charts
NODE_PATH=$(npm root -g) node render-pptx.js draft/deck.json out.pptx        # deck.json meta.logo 경로를 ../first-logo.png 로 조정
py -3.11 build-book.py ../../renewal/research book.json && py -3.11 render-xlsx.py book.json out.xlsx
powershell -File excel-recalc.ps1 -Path out.xlsx   # Excel로 수식 재계산·오류 점검
```
스타일은 회사 레퍼런스(커넥티드모빌리티_자세변경알림_효과분석.pptx/.docx) 규격을 따릅니다.
