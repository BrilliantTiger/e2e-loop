#!/usr/bin/env bun
// 사람이 터미널에서 직접 쓰는 진입점. 같은 동작을 MCP 도구와 공유한다.
import * as A from "./actions.ts";

const [, , cmd, ...rest] = process.argv;
const flags: Record<string, any> = {};
const pos: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const t = rest[i]!;
  if (t.startsWith("--")) {
    const k = t.slice(2);
    const nxt = rest[i + 1];
    if (nxt === undefined || nxt.startsWith("--")) flags[k] = true;
    else {
      flags[k] = nxt;
      i++;
    }
  } else pos.push(t);
}
for (const k of Object.keys(flags)) {
  const v = flags[k];
  if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) flags[k] = JSON.parse(v);
  if (v === "true") flags[k] = true;
  if (v === "false") flags[k] = false;
}
const project = flags.project;
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

const HELP = `e2e-loop — 웹 E2E 회차 루프
  doctor [--fix] [--confirm ffmpeg] [--dry-run]   환경 점검(--fix: 자동 설치+MCP 등록, --confirm: 승인한 설치)
  setup [--confirm ffmpeg] [--dry-run]   doctor --fix 와 같음
  session [--mode here|new] [--agent claude|codex] [--new_session] [--baseUrl URL] [--dryRun]   테스터 세션 시작
  intake [--baseUrl URL] [--materials '[{"kind":"plan","location":"docs/plan.md"}]']   웹 주소·근거 등록과 최소 진행 조건 검사
  analyze [--codeRoot 경로] [--rediscover false]   코드 분석 + 사이트 탐색 결과와 대조
  os-check [--decision allow|skip]       OS 창(다운로드·파일 선택) 점검
  sheet [--confirm] [--confirm_before_start] [--full]   테스트 시트(화면 → 기능 → 케이스)
  init --baseUrl URL [--driver ego|chrome|chromium|auto] [--dataPolicy ask|reset|keep] [--resetCommand CMD]
  source --kind plan|design|feature-spec|live-site --title T --location L [--sections '["3.1","3.2"]']
  discover                               사이트 전수 탐색 + 자동 점검 케이스 생성
  cases [--type spec|probe]              케이스 목록
  coverage                               커버리지
  round [--data reset|keep|manual-reset-done] [--only '["id"]'] [--onlyFailed]   한 회차 실행(끝날 때까지 기다림)
  report [--round R01] [--format md|json|paths]
  check                                  완료 판정
  feedback --text "요청" [--apply now --mode restart|in-flow]
  status                                 현재 상태와 다음 행동
  dashboard [--open] [--host IP]         현황판(내부망 IP, 토큰). 이 프로세스가 떠 있는 동안 코멘트를 받고 자동 응답도 맡는다
  mcp                                    MCP 서버 실행(stdio)
공통: --project <대상 프로젝트 경로>(기본: 현재 폴더)`;

switch (cmd) {
  case "doctor": print(await A.aDoctor({ fix: !!flags.fix, dryRun: !!flags["dry-run"], confirm: typeof flags.confirm === "string" ? String(flags.confirm).split(",") : undefined })); break;
  case "setup": print(await A.aDoctor({ fix: true, dryRun: !!flags["dry-run"], confirm: typeof flags.confirm === "string" ? String(flags.confirm).split(",") : undefined })); break;
  case "session": print(await A.aSessionStart({ ...flags, project } as any)); break;
  case "intake": print(await A.aIntake({ ...flags, project } as any)); break;
  case "analyze": print(await A.aAnalyze({ ...flags, project } as any)); break;
  case "os-check": print(await A.aOsCheck({ ...flags, project } as any)); break;
  case "sheet": print(A.aSheet({ ...flags, project } as any)); break;
  case "init": print(await A.aInit({ ...flags, project } as any)); break;
  case "source": print(A.aSourceAdd({ ...flags, project } as any)); break;
  case "discover": print(await A.aDiscover({ ...flags, project })); break;
  case "cases": print(A.aCaseList({ ...flags, project })); break;
  case "coverage": print(A.aCoverage({ project })); break;
  case "round": {
    const r: any = await A.aRoundStart({ ...flags, project } as any);
    print(r);
    if (r.started) {
      process.stderr.write("진행 중… (Ctrl+C 로 CLI 만 종료하면 회차도 함께 멈춥니다)\n");
      for (;;) {
        const s: any = await A.aRoundStatus({ project, wait_seconds: 30 });
        process.stderr.write(`  ${s.done}/${s.total} ${JSON.stringify(s.counts)}\n`);
        if (!s.running) break;
      }
      print(A.aRoundReport({ project, format: "md" }));
    }
    break;
  }
  case "report": print(A.aRoundReport({ ...flags, project } as any)); break;
  case "check": print(A.aCompleteCheck({ project })); break;
  case "feedback": print(A.aFeedback({ ...flags, project } as any)); break;
  case "status": print(A.aStatus({ project })); break;
  case "dashboard": {
    print(await A.aDashboard({ project, open: !!flags.open, host: typeof flags.host === "string" ? flags.host : undefined }));
    await new Promise(() => {});
    break;
  }
  case "mcp": await import("./mcp.ts"); break;
  default: print(HELP);
}
if (cmd !== "dashboard" && cmd !== "mcp") process.exit(0);
