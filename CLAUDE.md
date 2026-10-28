# REMEMBER WAY AI — 이 저장소에서 코드를 쓸 때 지킬 것

이 파일은 Claude(또는 다른 AI 코딩 도구)가 이 저장소에서 작업할 때 매번 읽는 규칙이다. 학생이 코드를 요청할 때 이 규칙과 어긋나는 제안은 거절하고 이유를 말한다.

## 이 앱이 하는 일 (한 문장)

기기도 등록도 없이 사라진 치매 어르신을, 보호자의 기억만으로 찾게 돕고 그 경험으로 다음 실종을 막는 보호자용 실종 대응 시뮬레이터.

**AI가 하는 일:** 보호자의 말을 경찰이 쓸 정보로 바꾸고, 빠진 것을 되묻고, 확인할 곳을 지도에 정리한다.

## 절대 하지 않는 것

- **위치를 예측하지 않는다.** "확률", "예측", "있을 확률", "AI가 추천" 같은 말을 UI·주석·문서 어디에도 쓰지 않는다. 쓰는 말은 "우선 확인 순서", "보호자가 말한 곳", "확인할 곳".
- **생성형 AI에게 판단을 맡기지 않는다.** 점수·순위·위험도·"지금 할 일"은 전부 코드(`public/lib/priority.js`, `public/lib/diary.js`)가 정한다. AI는 말 → 구조화, 되묻기 질문, 패턴 문장만 만든다.
- **AI 출력을 검증 없이 쓰지 않는다.** 모든 AI 응답은 `public/lib/verify.js`(스키마 검사, 원문 대조 ⚠)를 거친 뒤에만 화면에 쓴다. `missing`은 AI 값을 믿지 않고 `computeMissing`으로 다시 계산한다.
- **이름을 입력받지 않는다.** 호칭(아버지·어머니·어르신)만. 주소는 동 단위. 복용약은 성분명 없이 "복용 여부"만. 사진은 저장하지 않는다.
- **API 키를 브라우저에 두지 않는다.** `UPSTAGE_API_KEY`/`GEMINI_API_KEY`/`ANTHROPIC_API_KEY`는 서버 함수(`api/*.js`, `lib/claude.js`)에서만 읽는다. `.env.local`은 커밋하지 않는다.
- **서버 DB를 만들지 않는다.** 프로필·일지·사건 기록은 보호자 기기 `localStorage`에만. (예외: 환자 모드 푸시 구독, 맨 마지막 단계)
- **녹화 결과를 실시간인 척하지 않는다.** 미리 저장한 결과를 보여 줄 때는 화면에 "녹화 결과"라고 표시한다.
- **MOCK_AI=1 모의 응답을 실제 AI 결과처럼 쓰지 않는다.** 모의 응답이면 화면 상단 배너(`mockBanner`)를 지우지 않는다.
- **모의 데이터를 실제인 것처럼 쓰지 않는다.** 모든 사례는 가명·가짜 주소. `data/mock_cases.json`의 `_note`를 유지한다.

## 구조 (바꾸지 않는 것)

```
public/lib/schema.js    타입 설명·가중치·임계값·되묻기 우선순위  ← 여기 숫자를 바꾸면 docs/ 결정표도 같이 바꾼다
public/lib/verify.js    스키마 검사·missing 재계산·환각 대조 (브라우저·서버 공용)
public/lib/priority.js  R_max, 우선 확인 순서, 지금 할 일 3가지, 요약문 조립 (규칙)
public/lib/diary.js     일지 → 장소 4분류, 주간 집계 (규칙)
lib/prompts.js          호출 ①②④⑤⑥ 시스템 프롬프트  ← "없으면 null", "원문에 없는 사실 금지"는 삭제 금지
lib/claude.js           생성형 AI 호출 — Upstage Solar / Gemini / Claude (AI_PROVIDER), fetch, 서버 전용, 15초 타임아웃·대체 모델, MOCK_AI
lib/http.js             서버 함수 공통 (POST 파싱, 오류 → ok:false)
api/extract.js ①  api/followup.js ②  api/record.js ④  api/diary.js ⑤  api/weekly.js ⑥  api/config.js(AI 상태만)
public/*.html           화면. 빌드 없음. 각 화면의 스크립트는 그 HTML 안에 있다
public/js/common.js     저장·API 호출·음성 입력·공통 UI   public/js/map.js  지도(OSM/Leaflet)·좌표 찾기(Nominatim)
data/                   모의 사례·정답표·실험 결과       docs/  결정표·화면 구성·확정안·실험기록 (여기와 어긋나면 docs가 우선)
```

설치할 npm 패키지는 없다. 새 패키지를 추가하자는 제안은 거절한다 (빌드 없이 Vercel에 올라가는 구조를 유지).

## 만드는 순서 (고정)

화면 1 → 2 → 3 → 0 → 4 → 환자 모드. 앞 화면이 실제 API로 돌기 전에 뒤 화면을 시작하지 않는다.

## 화면 규칙

- 화면 1 최상단: "치매 어르신은 즉시 신고 대상입니다. 먼저 112에 전화하세요." 고정.
- 화면 2: AI가 채운 칸마다 ✎ 수정 가능, ⚠는 원문에 없는 값. [모름] 버튼 필수. "질문 건너뛰고 바로 요약" 버튼 필수.
- 화면 3: 가중치 표(추억 +3 / 최근 증가 +3 / 자주 +2 / 새로운 +2 / 기타 +1 / 경로 교차로 +2 / 반경 밖 −2)를 그대로 보여 주고 "임의 설정, 실험으로 조정" 표기. 고정 문구: "어르신은 목적지에 도착하지 못하고 가는 길에서 발견되는 경우가 많습니다. 이 지도는 보호자가 말한 것을 정리한 것입니다."
- 화면 0: 첫 등록(대화) → 매일 칩 탭(AI 호출 없음) → "다른 곳이 있어요"일 때만 `/api/diary`. 기록일 7일 미만이면 "기록이 적어 패턴 신뢰도가 낮습니다".
- 첫 화면 개인정보 문구 3줄: 이름 안 묻음 / 사진 저장 안 함 / 내 기기에만 저장.
- 모바일 폭 기준. 존댓말. 어르신은 "어르신".

## AI 장애 시

`/api/*`가 `{ok:false}`를 주면 화면은 **고정 서식 입력 모드**로 전환한다. 서식만으로도 화면 3 요약이 만들어져야 한다. 15초 타임아웃은 `lib/claude.js`와 `public/js/common.js`(api 함수) 양쪽에 있다.

## 기술

순수 HTML/CSS/JS PWA (ES 모듈, 빌드 없음) · Vercel 서버리스 함수 `api/*.js` (Node 20+, ESM) · Upstage Solar(OpenAI 호환) / Gemini / Claude 중 `AI_PROVIDER`로 선택, `fetch`로 직접 호출 · OpenStreetMap+Leaflet(키 없음, Nominatim 지오코딩) · Web Speech API(STT, 미지원 브라우저는 글쓰기) · localStorage.
2026-10-28에 Next.js에서 이 구조로 바꿨고, 같은 날 AI를 Claude에서 Gemini(교육용 키)로 바꿨다 (이유: docs/결정표 "추가 결정").

## 실험

`npm run mock` → `data/results_날짜.json` (`MOCK_AI=1`이면 `_mock` 접미사, 품질 수치로 쓰지 않는다). 지표: 채운 칸 수, 환각 수(정답표의 expected_null에 값이 들어간 수 + ⚠ 수), 첫 되묻기 키, 소요 시간. 결과는 숨기지 않고 docs에 기록한다.

## 모르면

`docs/REMEMBER_WAY_AI_구현전_결정표_2026-10-25.md`를 먼저 본다. 거기 없으면 코드를 짜기 전에 지도교사에게 묻는다.
