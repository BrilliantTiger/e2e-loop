// 종단 시험: 버그가 든 데모 사이트로 "1회차 실패 → 수정 → 2회차 통과 → 완료 판정"을 끝까지 돌린다.
// 사용법: bun test/demo.ts [--driver chromium|chrome|ego]
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as A from "../src/actions.ts";

const driver = (process.argv.includes("--driver") ? process.argv[process.argv.indexOf("--driver") + 1] : "chromium") as any;
const root = process.env.DEMO_PROJECT ?? "/tmp/e2e-loop-demo";
const port = 4567;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const setBugs = (b: Record<string, boolean>) => writeFileSync(join(root, "bugs.json"), JSON.stringify(b));
setBugs({ modalNoClose: true, statsApi: true, exportThrows: true, brokenLink: true });
Bun.spawnSync(["git", "init", "-q"], { cwd: root });
Bun.spawnSync(["git", "add", "."], { cwd: root });
Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });

const server = Bun.spawn(["bun", join(import.meta.dir, "../examples/demo-site/server.ts"), root, String(port)], { stdout: "ignore", stderr: "inherit" });
await Bun.sleep(800);
const ok = (c: boolean, m: string) => {
  console.log((c ? "  ✔ " : "  ✘ ") + m);
  if (!c) {
    server.kill();
    process.exit(1);
  }
};
try {
  console.log("1) 환경 점검");
  const d = await A.aDoctor({ fix: false });
  ok(d.checks.find((c) => c.id === "playwright-chromium")?.status === "ok", "playwright chromium 준비됨");

  console.log("2) 초기화·근거 등록");
  const init = await A.aInit({ project: root, baseUrl: `http://127.0.0.1:${port}`, driver, dataPolicy: "ask", headless: true, resetCommand: `curl -s -X POST http://127.0.0.1:${port}/api/reset`, dashboardPort: 7790 });
  ok(init.ask_user.length > 0, "처음 init 은 사용자에게 물어볼 것을 알려 줌: " + init.ask_user.length + "건");
  let start: any = await A.aRoundStart({ project: root });
  ok(!!start.error, "근거가 없으면 회차 시작 거부: " + start.error?.slice(0, 40));

  console.log("3) 사이트 전수 탐색");
  const disc = await A.aDiscover({ project: root });
  console.log("   ", JSON.stringify(disc.elements), "자동 점검", disc.probe_cases.total);
  ok(disc.elements.total >= 15, `요소 ${disc.elements.total}개 수집`);
  ok(disc.elements.modalOpeners >= 1, `모달을 여는 버튼 ${disc.elements.modalOpeners}개 발견(눌러서 열어 봄, 모달 안쪽 요소 ${disc.elements.inModal}개)`);
  ok(disc.risky.destructive.length >= 1, "파괴적 요소 표시: " + disc.risky.destructive.join(", "));

  console.log("4) 기획서 기반 케이스 등록");
  const up = A.aCaseUpsert({
    project: root,
    cases: [
      { id: "SPEC-001", title: "홈에 대시보드 제목이 보인다", source_ref: "기획서 1.1", steps: [{ op: "goto", url: "/" }, { op: "expect", sel: "h1", text: "대시보드" }] },
      { id: "SPEC-002", title: "가입하면 '가입 완료'가 보인다", source_ref: "기획서 2.3", steps: [{ op: "goto", url: "/" }, { op: "fill", sel: "input[name=email]", value: "a@b.co" }, { op: "click", sel: "button:text-is(\"가입하기\")" }, { op: "expect", sel: "#msg", text: "가입 완료" }] },
      { id: "SPEC-003", title: "통계를 누르면 항목 수가 나온다", source_ref: "기획서 3.1", steps: [{ op: "goto", url: "/" }, { op: "click", sel: "#stats" }, { op: "expect", sel: "#stat-out", textContains: "항목" }] },
    ],
  });
  ok(up.errors.length === 0, `spec 케이스 ${up.added}건 등록`);

  console.log("5) 회차 시작 전 데이터 결정 요구");
  const q: any = await A.aRoundStart({ project: root });
  ok(q.options?.length === 3, "data 를 안 주면 사용자에게 물을 선택지 3개가 돌아옴");

  console.log("6) 1회차 (버그 있는 상태, 데이터 초기화)");
  start = await A.aRoundStart({ project: root, data: "reset", headless: true });
  ok(start.started, `${start.round} 시작, 케이스 ${start.cases}건, 대시보드 ${start.dashboard}`);
  const dashState = await (await fetch(start.dashboard + "/api/state")).json();
  ok(dashState.running === true, "대시보드 API 가 진행 중 상태를 보여 줌");
  console.log("   회차 도중 사용자 요청 처리");
  const fb: any = A.aFeedback({ project: root, text: "소개 페이지 제목도 확인해줘" });
  ok(fb.ok && fb.feedback.appliesTo === "next-round", "기본은 다음 회차에 적용: " + fb.message.slice(0, 50));
  const fb2: any = A.aFeedback({ project: root, text: "지금 회차부터 적용해줘", apply: "now" });
  ok(fb2.needs_decision === true && fb2.options.some((o: any) => o.value === "restart") && fb2.options.some((o: any) => o.value === "in-flow"), "'지금부터'는 처음부터/지금 흐름 중 무엇인지 되물음");
  let st: any;
  do {
    st = await A.aRoundStatus({ project: root, wait_seconds: 20 });
    console.log(`    진행 ${st.done}/${st.total} ${JSON.stringify(st.counts)}`);
  } while (st.running);
  ok(st.status === "finished", "1회차 끝남");
  const rep1: any = A.aRoundReport({ project: root, format: "json" });
  console.log("   실패:", rep1.failures.map((f: any) => `${f.priority} ${f.id}`).join(", "));
  ok(rep1.summary.FAIL >= 3, `결함 ${rep1.summary.FAIL}건 발견`);
  ok(existsSync(join(root, ".e2e/rounds/R01/report.html")), "사람용 report.html 생성");
  const c1 = A.aCompleteCheck({ project: root });
  ok(!c1.complete, "실패가 있으니 완료 판정 거부");

  console.log("8) 결함 수정 (회차가 끝난 뒤)");
  setBugs({});
  Bun.spawnSync(["git", "add", "."], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fix"], { cwd: root });
  A.aFeedbackResolve({ project: root, ids: ["FB001"], note: "시험에서 확인" });

  console.log("9) 2회차 (수정 후 전체)");
  start = await A.aRoundStart({ project: root, data: "reset", headless: true });
  do {
    st = await A.aRoundStatus({ project: root, wait_seconds: 20 });
  } while (st.running);
  const rep2: any = A.aRoundReport({ project: root, format: "json" });
  console.log("   요약:", JSON.stringify(rep2.summary), "추이:", rep2.trend.map((t: any) => `${t.round}=${t.issues}`).join(" → "));
  console.log("   이전 대비: 고쳐짐", rep2.diff.fixed.length, "회귀", rep2.diff.regressed.length);
  const gate = A.aCompleteCheck({ project: root });
  console.log("   완료 판정:", gate.complete, gate.reasons);
  ok(rep2.summary.FAIL === 0, "2회차 결함 0건");
  ok(gate.complete, "이슈 0 → 완료 판정 통과");
  console.log("\n모든 시험 통과. 보고서:", join(root, ".e2e/rounds/R02/report.html"));
} finally {
  server.kill();
}
process.exit(0);
