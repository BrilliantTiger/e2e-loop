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
7. 직접 해야 하는 것(Ego 앱 설치, macOS 권한 허용)은 안내만 한다.

점검만 하려면 `bun src/cli.ts doctor`, 실행 계획만 보려면 `--dry-run`.

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
