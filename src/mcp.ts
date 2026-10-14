#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as A from "./actions.ts";

const server = new McpServer({ name: "e2e-loop", version: "0.1.0" });
const project = z.string().optional().describe("대상 프로젝트 루트(절대 경로). 생략하면 E2E_PROJECT 환경변수 또는 서버의 현재 폴더");
const out = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const wrap = <T>(fn: (a: T) => unknown | Promise<unknown>) => async (a: T) => {
  try {
    return out(await fn(a));
  } catch (e: any) {
    return { isError: true, content: [{ type: "text" as const, text: String(e?.message ?? e) }] };
  }
};
const step = z.object({ op: z.string() }).passthrough();
const caseShape = z.object({
  id: z.string(), title: z.string(), steps: z.array(step).min(1),
  type: z.enum(["spec", "probe"]).optional(), source_ref: z.string().optional().describe("근거 위치. 예: '기획서 3.2절' 'Figma 2673:222145'"),
  event: z.string().optional(), area: z.string().optional(), element: z.string().optional(),
  risk: z.enum(["safe", "mutating", "destructive"]).optional(), tags: z.array(z.string()).optional(),
}).passthrough();

server.registerTool("e2e_doctor", {
  title: "환경 점검·설치·등록",
  description: "E2E 에 필요한 도구를 점검한다(bun·Playwright 브라우저·Chrome·Edge·Ego·ffmpeg·git·Orca·macOS 권한). fix=true 면 빠진 Playwright 브라우저를 자동 설치하고 e2e-loop MCP 를 설치된 모든 클라이언트(Claude·Codex 등)에 등록한다. ffmpeg 처럼 설치 전에 사용자에게 물어야 하는 것은 needs_confirmation 으로 돌려주니, 사용자가 승인하면 confirm=['ffmpeg'] 로 다시 호출한다. Ego 설치·OS 권한 허용은 manual 로 안내만 한다. dryRun=true 면 실행하지 않고 할 일만 보여 준다.",
  inputSchema: { fix: z.boolean().optional(), confirm: z.array(z.string()).optional().describe("사용자가 설치를 승인한 항목 id"), dryRun: z.boolean().optional() },
}, wrap(A.aDoctor));

server.registerTool("e2e_init", {
  title: "프로젝트 E2E 설정",
  description: "대상 프로젝트에 .e2e/ 설정을 만들거나 갱신한다. 처음 호출하면 ask_user 에 사용자에게 물어봐야 할 것(브라우저 선택·데이터 정책·근거 자료)이 나온다. 브라우저: auto(ego 있으면 ego → Chrome → chromium) / ego / chrome / chromium. 데이터 정책: ask(회차마다 묻기) / reset / keep.",
  inputSchema: {
    project, baseUrl: z.string().optional(), driver: z.enum(["auto", "ego", "chrome", "edge", "chromium"]).optional(), headless: z.boolean().optional(),
    dataPolicy: z.enum(["ask", "reset", "keep"]).optional(), resetCommand: z.string().optional().describe("데이터 초기화 셸 명령. 빈 문자열이면 제거"),
    resetCwd: z.string().optional(), resetScope: z.enum(["round", "case"]).optional(), codeRoot: z.string().optional().describe("회차 도중 코드 변경 감지용 git 저장소 경로(기본: 프로젝트 루트)"),
    authLocalStorage: z.record(z.string(), z.string()).optional().describe("로그인 토큰 등 미리 심을 localStorage. 값에 ${ENV} 사용 가능"),
    authSetupSteps: z.array(step).optional().describe("케이스마다 맨 앞에서 실행할 스텝(로그인 등)"),
    destructivePattern: z.string().optional(), acceptedSkips: z.array(z.string()).optional(),
    crawl: z.object({ maxPages: z.number().optional(), maxDepth: z.number().optional(), seeds: z.array(z.string()).optional(), ignore: z.array(z.string()).optional(), reveal: z.boolean().optional(), maxRevealPerPage: z.number().optional() }).optional(),
    probes: z.enum(["auto", "off"]).optional(), dashboardPort: z.number().optional(), viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  },
}, wrap(A.aInit as any));

server.registerTool("e2e_source_add", {
  title: "근거 자료 등록",
  description: "E2E 의 기대값 근거를 등록한다. 우선순위: plan/design(기획서·디자인) > feature-spec(기능정의서) > live-site(개발된 사이트 전수 탐색). 근거가 하나도 없으면 회차를 시작할 수 없다. sections 에 문서의 절/프레임 이름을 넣으면 e2e_coverage 가 케이스 없는 절을 알려 준다.",
  inputSchema: { project, kind: z.enum(["plan", "design", "feature-spec", "live-site"]), title: z.string(), location: z.string().describe("파일 경로 또는 URL(Figma 등)"), sections: z.array(z.string()).optional() },
}, wrap(A.aSourceAdd));

server.registerTool("e2e_discover", {
  title: "사이트 전수 탐색",
  description: "개발된 사이트를 돌며 링크·버튼·입력·선택·토글·탭·폼·모달(눌러서 열어 안쪽 요소까지)을 모두 수집하고, 요소마다 자동 점검 케이스(probe)를 만든다. 삭제·로그아웃 같은 파괴적 요소는 눌러 보지 않고 표시만 한다. 기획서 기반 spec 케이스는 건드리지 않는다.",
  inputSchema: { project, seeds: z.array(z.string()).optional(), maxPages: z.number().optional(), reveal: z.boolean().optional(), driver: z.enum(["auto", "ego", "chrome", "edge", "chromium"]).optional() },
}, wrap(A.aDiscover));

server.registerTool("e2e_case_upsert", {
  title: "케이스 등록·수정",
  description: "기획서/디자인/기능정의서의 기대 동작을 spec 케이스로 등록한다. 스텝 op: goto{url} click{sel} dblclick hover fill{sel,value} select{sel,value} check{sel,checked} press{key,sel?} wait{ms | sel,state} expect{sel?, visible|hidden|text|textContains|value|count|checked|enabled, url, title, titleContains, dialog} api{method,url,body,status,json} screenshot eval{script,equals}. 선택자: CSS · text=\"정확한 글\" · role=button[name=\"저장\"] · xpath=. 케이스는 매번 새 브라우저에서 시작하므로 첫 스텝은 goto. source_ref 에 근거 위치를 적는다.",
  inputSchema: { project, cases: z.array(caseShape).min(1) },
}, wrap(A.aCaseUpsert as any));

server.registerTool("e2e_case_list", {
  title: "케이스 목록",
  description: "등록된 케이스를 간단히 조회한다.",
  inputSchema: { project, type: z.enum(["spec", "probe"]).optional(), status: z.enum(["active", "blocked", "na"]).optional(), area: z.string().optional(), limit: z.number().optional() },
}, wrap(A.aCaseList));

server.registerTool("e2e_case_set_status", {
  title: "케이스 보류/제외 표시",
  description: "blocked(기대값 근거 없음 등) 또는 na(해당 없음)로 바꾼다. 반드시 근거(reason)를 적는다. 미실행을 PASS 로 두지 않는다.",
  inputSchema: { project, ids: z.array(z.string()).min(1), status: z.enum(["active", "blocked", "na"]), reason: z.string().optional() },
}, wrap(A.aCaseSetStatus));

server.registerTool("e2e_coverage", {
  title: "커버리지",
  description: "화면 요소 중 케이스가 없는 것, 문서 절 중 케이스가 없는 것, spec/probe 케이스 수를 보여 준다. 회차를 시작하기 전에 빠진 곳을 메운다.",
  inputSchema: { project },
}, wrap(A.aCoverage));

server.registerTool("e2e_round_start", {
  title: "회차 시작",
  description: "전체 케이스를 처음부터 한 회차 실행한다(백그라운드). 시작 전에 데이터를 초기화할지 그대로 갈지 반드시 사용자에게 확인해야 한다 — data 를 주지 않고 정책이 ask 면 질문 선택지(needs_decision)가 돌아온다. data: reset(초기화 후 시작, 파괴적 동작도 점검) / keep(그대로, 파괴적 동작은 SKIP) / manual-reset-done(사용자가 직접 초기화 완료). 실시간 대시보드 주소가 함께 돌아온다. 회차가 도는 동안에는 코드·케이스를 고치지 않는다.",
  inputSchema: { project, data: z.enum(["reset", "keep", "manual-reset-done"]).optional(), driver: z.enum(["auto", "ego", "chrome", "edge", "chromium"]).optional(), headless: z.boolean().optional(), only: z.array(z.string()).optional().describe("지정한 케이스만(부분 회차 — 완료 판정에는 쓸 수 없음)"), onlyFailed: z.boolean().optional().describe("직전 회차 실패 케이스만 다시(부분 회차)"), open: z.boolean().optional().describe("대시보드를 브라우저로 열기") },
}, wrap(A.aRoundStart as any));

server.registerTool("e2e_round_status", {
  title: "회차 진행 확인",
  description: "진행 상황(몇 건 중 몇 건, 지금까지 실패, 마지막 이벤트)을 돌려준다. wait_seconds 를 주면 최대 90초까지 끝나길 기다린다. 자주 부르지 말고 wait_seconds 를 써서 기다린다.",
  inputSchema: { project, wait_seconds: z.number().optional() },
}, wrap(A.aRoundStatus));

server.registerTool("e2e_round_stop", { title: "회차 중단", description: "진행 중인 회차를 중단한다(현재 케이스가 끝나면 멈춤).", inputSchema: { project } }, wrap(A.aRoundStop));

server.registerTool("e2e_round_report", {
  title: "회차 결과",
  description: "끝난 회차의 결과. format=md(AI용 요약: 실패·원인 힌트·증거 경로·다음 행동), json(전체 구조), paths(사람용 report.html 경로 등). 사람에게는 report.html 과 대시보드 주소를 알려 준다.",
  inputSchema: { project, round: z.string().optional(), format: z.enum(["md", "json", "paths"]).optional() },
}, wrap(A.aRoundReport));

server.registerTool("e2e_complete_check", {
  title: "완료 판정",
  description: "이슈가 0 에 수렴했는지 기록으로만 판정한다. 마지막 회차가 전체 회차이고, 회차 도중 코드 변경이 없고, 케이스 정의가 그대로이고, FAIL 0, 검증 못 한 SKIP 0 일 때만 complete=true. 말로 완료를 선언하기 전에 반드시 호출한다.",
  inputSchema: { project },
}, wrap(A.aCompleteCheck));

server.registerTool("e2e_feedback", {
  title: "사용자의 E2E 요청 기록",
  description: "사용자가 E2E 에 관해 말한 요청(케이스 추가·기대값 변경·범위 변경 등)을 기록한다. 기본은 '진행 중인 회차는 건드리지 않고 다음 회차부터 적용'. 사용자가 '지금 회차부터 적용하라'고 한 경우에만 apply='now' 로 부르고, 그러면 처음부터 다시 돌릴지(restart) 지금 흐름에서 적용할지(in-flow) 먼저 사용자에게 물어보라는 needs_decision 이 돌아온다. 답을 받으면 mode 와 함께 다시 호출한다. in-flow 에서는 cases 에 끼워 넣을 케이스를 준다.",
  inputSchema: { project, text: z.string(), apply: z.enum(["next", "now"]).optional(), mode: z.enum(["restart", "in-flow"]).optional(), cases: z.array(caseShape).optional() },
}, wrap(A.aFeedback as any));

server.registerTool("e2e_feedback_resolve", {
  title: "요청 반영 완료 표시",
  description: "기록해 둔 사용자 요청을 케이스·설정에 반영했으면 done 으로 표시한다. 다음 회차를 시작하기 전에 pending 요청을 모두 반영하고 표시한다.",
  inputSchema: { project, ids: z.array(z.string()).min(1), note: z.string().optional() },
}, wrap(A.aFeedbackResolve));

server.registerTool("e2e_dashboard", { title: "실시간 대시보드 주소", description: "실시간 대시보드(진행·지금 화면·로그·이슈 추이)를 띄우고 주소를 돌려준다. open=true 면 브라우저로 연다.", inputSchema: { project, open: z.boolean().optional() } }, wrap(A.aDashboard));

server.registerTool("e2e_status", { title: "현재 상태와 다음 행동", description: "근거·케이스·회차·이슈 추이·미반영 요청을 한 번에 보고, 다음에 할 일을 알려 준다. 세션을 이어받았을 때 가장 먼저 호출한다.", inputSchema: { project } }, wrap(A.aStatus));

await server.connect(new StdioServerTransport());
