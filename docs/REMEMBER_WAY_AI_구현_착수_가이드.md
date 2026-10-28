# REMEMBER WAY AI — 구현 착수 가이드

- 작성 2026-10-25 · 대상: 학생 2명 + 지도교사
- 예선: 11월 초(날짜 미공지). 오늘부터 약 2주.

---

## 0. 시작 전 5분 점검

| 확인 | 상태 |
|---|---|
| 공용 GitHub 계정·저장소(공개) 생성 | □ |
| 공용 Vercel 계정, GitHub 연결 | □ |
| 공용 카카오 개발자 계정, JavaScript 키 발급, **길찾기 API 권한** 확인 | □ |
| Claude API 키 (지도교사) → Vercel 환경변수 + `.env.local` | □ |
| `rememberway-starter.zip` 풀어서 저장소에 첫 커밋 (CLAUDE.md 포함) | □ |
| Node 20+, `npm install` 성공 | □ |
| `docs/` 세 문서를 학생이 한 번 읽음 (결정표 → 화면구성 → 확정안 순) | □ |

## 1. 저장소 만드는 순서 (첫날)

```bash
npx create-next-app@latest rememberway --typescript --tailwind --app --src-dir=false --import-alias "@/*"
cd rememberway
# starter의 CLAUDE.md, lib/, app/api/, data/, scripts/, docs/, .env.example, .gitignore, README.md 를 덮어쓰기
npm install @anthropic-ai/sdk tsx
cp .env.example .env.local   # 키 입력
git init && git add . && git commit -m "starter"
```

첫 커밋 뒤 Vercel에서 저장소 연결 → 환경변수 3개 입력 → 자동 배포 확인. 이 시점에 화면이 없어도 `/api/extract`에 POST가 되면 성공.

## 2. 1주차 (10/27~11/2) — 화면 1→2→3

| 날 | 할 일 | 끝났다는 기준 |
|---|---|---|
| 월 | `npm run mock` 실행 → `data/results_*.json` 확인. 환각·되묻기 결과 보고 `lib/prompts.ts` 수정 | 세 사례 모두 JSON이 나오고 첫 되묻기가 정답표와 맞음 |
| 화 | 화면 1: 112 안내, 말로/글로 입력, Web Speech API, [단서 정리하기] → `/api/extract` 호출 | 말한 내용이 JSON으로 돌아옴 |
| 수 | 화면 2: 칸별 표시·✎ 수정·⚠, `/api/followup` → 질문·[답하기]·[모름], [건너뛰고 요약] | 답하면 JSON이 갱신됨 |
| 목 | 화면 3: 요약 텍스트, 카카오맵 표시, `lib/priority.ts`로 우선 확인 순서, 가중치 표, 고정 문구, 지금 할 일 3가지 | 지도에 목적지·추억 장소가 찍힘 |
| 금 | 서식 모드(AI 장애 시), 10초 타임아웃 동작, 녹화 결과 1건 저장 | 네트워크 끊고도 화면 3이 나옴 |
| 주말 | 비교 실험 1차: 모의 사례 5개 × (서식 vs 대화) 기록 | 표 하나 완성 |

**길찾기 API가 안 열리면:** 지도 표시 + 직선 거리로 간다. 교차로는 뺀다. 결정표에 기록.

## 3. 2주차 (11/3~) — 화면 0 → 4 → 환자 모드

- 화면 0: 첫 등록 대화 → 칩 UI → `/api/diary` → `lib/diary.ts` 분류 → 주간 요약. 7일치 모의 일지 데이터 하나 만들어 시험.
- 화면 4: 사건 서술 → `/api/record`(호출 ④, 아직 없음 — 만들 때 `prompts.ts`에 추가) → 예방 계획 → 프로필 갱신.
- 환자 모드: 큰 버튼 → Web Push. VAPID 키·구독 저장(Vercel KV). 못 가면 README "상태"에 미구현.
- 예선 제출 전: README 상태표 갱신, 녹화 결과 확인, 발표 자료.

## 4. 학생이 Claude에게 코드 시킬 때

저장소 루트의 `CLAUDE.md`를 Claude가 읽는다. 요청은 이렇게:

> "화면 2를 만들어 줘. `docs/REMEMBER_WAY_AI_화면구성_및_한계분석.md`의 화면 2 설명과 `lib/schema.ts`의 ClueJSON을 따르고, CLAUDE.md 규칙을 지켜 줘."

Claude가 "확률", "예측", AI 순위 같은 걸 넣으면 CLAUDE.md를 가리키며 거절하게 되어 있다. 그래도 나오면 지도교사에게.

## 5. 매일 커밋 메시지에 남길 것

`feat(screen2): ...` / `fix(prompt): ...` / `exp: mock run 10/27` 처럼 앞에 종류를 쓴다. 실험 결과 파일은 커밋하지 않는다(`.gitignore`). 대신 수치를 `docs/실험기록.md`에 손으로 적는다 — 탐구기록물이 된다.

## 6. 멈춰야 하는 신호

- 월요일 mock에서 세 사례 중 둘 이상 JSON 실패 → 프롬프트·모델부터 다시. 화면 만들지 않는다.
- 수요일까지 화면 2가 안 돌면 → 화면 0·4·환자 모드를 "향후 계획"으로 내리고 1~3에 집중.
- "확률 68%" 같은 숫자가 화면에 다시 나타나면 → 결정표 2절 다시 읽기.

## 7. 지도교사가 할 일

- 키 전달, Vercel 환경변수 입력 (학생이 키를 메신저로 주고받지 않게)
- 현장 자문 (아직 미실시). 결과를 `docs/`에 한 줄.
- 기획안 3·5·8쪽 갱신은 자문 + 모델 결정 뒤 한 번에.
- 금요일마다 "되는 것 / 안 되는 것 / 미구현" 세 줄을 받아 둔다. 예선 README 상태표가 된다.

## 8. 파일 지도

| 보고 싶은 것 | 파일 |
|---|---|
| 오늘까지 결정 전부 | `docs/REMEMBER_WAY_AI_구현전_결정표_2026-10-25.md` |
| 화면별 구성·데이터 흐름·되묻기 규칙·한계 | `docs/REMEMBER_WAY_AI_화면구성_및_한계분석.md` |
| 왜 이 방향인지·근거·기존 서비스 관계 | `docs/REMEMBER_WAY_AI_확정안_요약_2026-10-20.md` |
| AI 코딩 규칙 | `CLAUDE.md` |
| 제출용 기획안 | `REMEMBER_WAY_AI_해커톤_기획안_제출용.pptx` (저장소 밖) |
| 자문 기록지 | `REMEMBER_WAY_AI_현장자문_전화기록지_v2.docx` (저장소 밖) |
