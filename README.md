# REMEMBER WAY AI

기기도 등록도 없이 사라진 치매 어르신을, 보호자의 기억만으로 찾게 돕고 그 경험으로 다음 실종을 막는 보호자용 실종 대응 시뮬레이터.

**AI가 하는 일 (한 문장):** 보호자의 말을 경찰이 쓸 정보로 바꾸고, 빠진 것을 되묻고, 확인할 곳을 지도에 정리한다.

> 2026 AI 동행 프로젝트 · 생성형AI 분과 · 그럴게요 팀 (동명중학교)

## AI가 하는 것 / 하지 않는 것

| 하는 것 (생성형 AI, Gemini API) | 하지 않는 것 (코드·사람) |
|---|---|
| 보호자의 두서없는 말 → 단서 JSON (호출 ①) | 즉시 신고 안내 (고정 문구) |
| 빠진 항목을 돌려 묻는 질문 생성 (호출 ②) | 우선 확인 순서 점수 (가중치 공개, `public/lib/priority.js`) |
| 찾은 뒤 서술 → 예방 계획 (호출 ④) | 장소 분류·반경·거리 (`public/lib/diary.js`, 지도 API) |
| 일지 발화 → 새 장소·언급 (⑤), 주간 요약 문장 (⑥) | 환각 대조 ⚠, 최종 확인 (보호자) |
| (본선) 사진 → 인상착의 (③, 미구현) | |

위치를 **예측하지 않는다.** 확률을 표시하지 않는다. 생성 결과는 검증(`public/lib/verify.js`)과 보호자 확인 전에는 어디에도 쓰이지 않는다.

## 화면

`/` 처음 → `/report` 화면 1 상황 입력 → `/confirm` 화면 2 확인·되묻기 → `/summary` 화면 3 요약·지도 → `/record` 화면 4 찾은 뒤 기록
`/profile` 화면 0 첫 등록 → `/diary` 매일 일지 · `/about` 소개

폰 홈 화면에 추가하면 앱처럼 열린다 (PWA). 브라우저로도 똑같이 쓴다.

## 상태 (예선 제출 시 갱신)

- [x] 화면 1 상황 입력 (Web Speech API + 글 입력, 경과 시간·걸음 속도)
- [x] 화면 2 확인·되묻기 (`/api/extract`, `/api/followup`, ⚠·✎·[모름]·[건너뛰고 요약])
- [x] 화면 3 요약(복사·공유) + 카카오맵(반경 원·마커) + 우선 확인 순서 + 가중치 표 + 지금 할 일 3가지
- [x] 서식 모드 (AI 10초 타임아웃·키 없음·오프라인 → 서식만으로 화면 3)
- [x] 화면 0 첫 등록 + 매일 일지(칩) + 30일 분류 + 주간 요약 (`/api/diary`, `/api/weekly`, localStorage)
- [x] 화면 4 찾은 뒤 기록 → 예방 계획 → 확인할 곳 추가 (`/api/record`)
- [x] PWA (manifest, 서비스워커, 아이콘)
- [ ] **실제 Gemini API로 검증** — 키 입력 후 `npm run mock` 결과를 `docs/실험기록.md`에 기록 (지금까지는 MOCK_AI 모의 응답으로 화면 흐름만 확인)
- [ ] **카카오맵 실기기 확인** — 키 입력·도메인 등록 후
- [ ] 도보 길찾기·교차로 (길찾기 API 미연동. 거리는 직선거리)
- [ ] 환자 모드 (어르신 폰 큰 버튼 → 서버 푸시) — 미구현
- [ ] 사진 → 인상착의 (본선)

## 실행

```bash
cp .env.example .env.local   # 키 입력 (GEMINI_API_KEY, KAKAO_JS_KEY)
npm run dev                  # http://localhost:3000  (설치할 패키지 없음, Node 20+)
npm run mock                 # 모의 사례 3개를 실제 AI로 실행 → data/results_<날짜>.json
npm run mock:fake            # 키 없이 모의 응답으로 흐름만 점검 (MOCK_AI=1)
```

## 배포 (Vercel)

1. 이 저장소를 GitHub에 올린다.
2. Vercel → Add New Project → 저장소 선택. Framework Preset은 **Other**(자동 감지됨). Build Command 없음.
3. Environment Variables: `GEMINI_API_KEY`, `GEMINI_MODEL`(예: gemini-3.8-flash), `KAKAO_JS_KEY` (MOCK_AI는 넣지 않는다). Claude를 쓰려면 `AI_PROVIDER=claude`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.
4. Deploy. 주소가 나오면 카카오 개발자 콘솔 → 앱 → 플랫폼 → Web 사이트 도메인에 그 주소를 추가한다.
5. 폰에서 주소 열기 → "홈 화면에 추가".

`public/` 이 화면, `api/*.js` 가 서버 함수다. AI 키는 서버 함수에서만 읽는다. 환경변수를 바꾼 뒤에는 Vercel에서 Redeploy 한 번.

## 구조

```
public/            화면 (HTML/CSS/JS, 빌드 없음)
public/lib/        schema · verify · priority · diary  ← 브라우저와 서버가 같이 쓰는 규칙
lib/               prompts · claude(Gemini/Claude 호출, 10초 타임아웃, MOCK) · http  ← 서버 전용
api/               extract ① · followup ② · record ④ · diary ⑤ · weekly ⑥ · config
data/              모의 사례·정답표 (가명·가짜 주소)
scripts/           dev.js(로컬 서버) · run_mock.js(실험)
docs/              결정표·화면 구성·확정안·실험기록
```

## 데이터·개인정보

모든 사례는 가명·가짜 주소의 모의 데이터다. 이름은 입력받지 않는다. 사진은 저장하지 않는다. 등록 정보는 보호자 기기(localStorage)에만 있고 "모두 지우기"로 삭제할 수 있다. AI 호출 때 보호자의 말과 등록 정보는 서버 함수를 거쳐 Gemini API로 전달된다.

## 근거 (요약)

- 2025년 치매 실종 신고 16,586건, 2026 1~7월 +14.4% (경찰청)
- 신고 가족 10명 중 3명이 치매 증상 미언급 (Yoo 외, The Gerontologist 2025)
- 치매 어르신 10명 중 8명은 목적지가 있어도 도착 못 함, 배회는 교차로에서 시작 (한국일보·한양대 GPS 분석 2023)
- 실종경보 발견의 23.2%가 시민 제보 (경찰청 2026.8)

전체 출처는 `docs/` 참고.
