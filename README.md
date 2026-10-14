# e2e-loop

웹 최종 E2E 테스트를 **이슈가 0이 될 때까지** 라운드로 반복하는 MCP 도구 + 스킬.

```
1라운드 → 수정 → 2라운드 → 수정 → 3라운드 → … → 이슈 0
```

- 요구사항(확정): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- 상태: 구현 진행 중. 기능 단위로 만들고 기능 단위로 push 한다.

## 설치

```sh
git clone git@github.com:BrilliantTiger/e2e-loop.git
cd e2e-loop
sh install.sh
```

`install.sh` 가 하는 일:

1. `bun` 이 없으면 설치한다.
2. `bun install` 로 의존성을 설치한다.
3. 환경을 점검한다: Playwright 브라우저, Chrome, Edge, Ego, ffmpeg, git, Orca, macOS 권한.
4. 빠진 **Playwright 브라우저는 자동 설치**한다.
5. **ffmpeg 처럼 설치 전에 물어야 하는 것**은 설치하지 않고 질문으로 돌려준다. 승인하면 `sh install.sh --confirm ffmpeg`.
6. e2e-loop MCP 를 **설치된 모든 클라이언트**(Claude Code, Codex)에 등록한다. 이미 있으면 건너뛴다.
7. 테스터 스킬(`skills/e2e-loop`)을 Claude Code(`~/.claude/skills`)와 Codex(`~/.agents/skills`)에 링크한다. 저장소를 `git pull` 하면 스킬도 함께 갱신된다. 같은 이름의 실제 폴더가 있으면 덮어쓰지 않고 알린다.
8. 직접 해야 하는 것(Ego 앱 설치, macOS 권한 허용)은 안내만 한다.

점검만 하려면 `bun src/cli.ts doctor`, 실행 계획만 보려면 `--dry-run`.

### 테스터 세션

E2E 는 코드를 고치는 에이전트가 아니라 **새 세션의 AI(테스터)** 가 진행한다.

- `e2e_session_start`: Orca 가 있으면 새 터미널에서 AI 를 띄운다. 없으면 "새 세션 / 여기서"를 묻고, "새 세션"이면 실행할 명령을 준다. 세션이 이미 있으면 그대로 유지한다(사용자가 새 세션을 명시할 때만 `new_session`).
- `e2e_intake`: 웹 주소와 기획서·디자인·기능정의서·코드를 받아 **최소 진행 조건**(실제로 열리는 웹 주소 + 근거 하나 이상)을 검사한다. 못 채우면 시작하지 않고 사용자에게 요청한다.
- 상태는 대상 프로젝트의 `.e2e/session.json`, `.e2e/intake.json`, `.e2e/sources.json` 에 있다.
- 터미널에서: `bun src/cli.ts session --mode new`, `bun src/cli.ts intake --baseUrl URL --materials '[{"kind":"plan","location":"docs/plan.md"}]'`

### 분석과 시트

- `e2e_discover`: 사이트를 돌며 클릭·입력·선택·토글·탭·폼·모달에 더해 **API 요청·응답(fetch·XHR), 다운로드 링크, 파일 입력**을 모은다.
- `e2e_analyze`: 코드(Next·React Router·Vue Router·Nuxt·SvelteKit·정적 HTML)에서 화면·이벤트·API·다운로드/업로드 후보를 뽑아 사이트 탐색 결과와 대조한다. 코드에는 있는데 링크로 안 닿는 화면은 직접 열어 확인하는 케이스로 만든다. 새 프레임워크는 `src/analysis/code.ts` 의 `ROUTE_EXTRACTORS` 에 추가한다.
- `e2e_os_check`: 다운로드·파일 선택이 브라우저 밖 OS 창을 거치는지 테스트 전에 점검한다. Chrome 계열은 Playwright 가 직접 처리하므로 해당 없다. Ego 에서 컴퓨터 제어가 안 되면 권한 안내와 함께 허용/스킵을 묻는다.
- `e2e_sheet`: 화면 → 기능 단위 → 케이스로 묶은 시트(`.e2e/sheet.md`)를 만든다. 케이스마다 근거(문서 절·코드 위치)가 있다. 요약을 한 번 보여 주고 바로 시작하며, 확인 후 시작을 원하면 `confirm_before_start`.

### 라운드 실행

- 시작 전 질문 `e2e_prestart`: 데이터 초기화(기본 안 함, 초기화 명령은 프로젝트마다 한 번), 라운드 상한(기본 10, 전체 라운드만 셈), 로그인·테스트 계정, "영상·스크린샷에 화면이 그대로 남으니 테스트 데이터와 테스트 계정만 입력" 안내. 마치기 전에는 `e2e_round_start` 가 시작되지 않는다.
- 기본은 Headed. Headless 는 `headless=true` 로 요구할 때만. 화면 없는 환경(Linux, DISPLAY 없음)이면 자동으로 바꾸지 않고 묻는다.
- 이슈 = 실패 + 불안정 + 검증 못 한 것(BLOCKED) + 사용자가 승격한 경고(`e2e_promote_warning`). **스킵은 이슈가 아니다.** 실패한 케이스는 3번 다시 돌린다: 모두 통과=통과, 일부만=불안정(이슈), 모두 실패=실패. 같은 이슈가 3라운드 연속이면 사용자에게 올린다.
- 파괴적 동작: 로그아웃은 테스트하고 다시 로그인한다(`auth.setupSteps` 가 있을 때). 삭제는 테스터가 입력해 등록한 데이터가 있는 줄만 누르고, 그 밖의 삭제·파괴적 동작은 스킵한다(데이터 초기화 회차는 모두 실행).
- 부분 라운드(`only`, `onlyFailed`)는 수정 확인용이다. 이슈 0 판정과 종료는 전체 라운드로만 한다. 라운드 도중 코드가 바뀌어도 무효로 하지 않는다.
- 증거: Chrome 계열은 Playwright 녹화(webm)를 mp4(h264)로 바꾸고, 멈춘 대기 구간을 줄이고, 챕터 파일(`*.chapters.txt`)을 만든다. 스크린샷·영상에 "커밋 | 시각 | 케이스 id | 원본 sha256" 도장을 찍고, 회차의 `evidence.json` 에 최종 파일 해시와 함께 적는다. 보관은 회차 단위이며 상한(기본 4096MB)의 80%부터 알리고 `e2e_evidence` 로 정리한다. ffmpeg 가 필요하다.
- Ego: 이동·클릭·입력·API·업로드·다운로드를 Ego 자체 API 로 실행한다. 영상은 `screencapture -v -l<창ID>` 로 "e2e-loop" 작업이 보이는 Ego 창 하나만 녹화한다. 그 창을 찾지 못하면(다른 작업이 앞에 보일 때 등) 영상 없이 스크린샷으로 증거를 남기고 이유를 경고로 적는다.
- 테스트 계정: 만들라고 하면 방법(화면·API·DB 스크립트)을 먼저 묻고, `e2e_account` 로 기록해 두었다가 종료 때 지운다.

### Ego 에 대해

Ego 는 MCP 서버가 아니라 **스킬 + `ego-browser` 명령**으로 동작한다. e2e-loop 는 그 명령을 직접 쓰므로 Ego 용 MCP 등록은 필요 없다. 설치: <https://lite.ego.app/> → 앱을 열어 첫 실행 온보딩을 마치면 `ego-browser` 명령이 PATH 에 등록된다(macOS 전용).

### 컴퓨터 제어

브라우저 밖 OS 창(다운로드·파일 선택)이 시트에 있을 때만 필요하다. 설치할 패키지는 없고, 쓰는 클라이언트의 컴퓨터 제어 기능(Codex 는 앱 내장, Claude Code 는 기본 연동)을 켜면 된다. `doctor` 가 보이는지 확인하고, 안 되면 권한 허용 방법을 안내한다.

## 개발

```sh
bun test            # 시험 (환경 점검·등록은 가짜 명령으로, 실제 설정 파일을 건드리지 않음)
bun run typecheck
bun test/demo.ts    # 버그를 심은 데모 사이트로 1라운드 실패 → 수정 → 2라운드 통과
```
