// 4단계 시험(브라우저 없음): 이슈 정의, 완료 판정, 증거 처리(영상·도장·챕터), 시작 전 질문, 상한·반복 이슈, 테스트 계정, Ego 화면 프레임 → 영상.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../src/store.ts";
import { isIssue } from "../src/issues.ts";
import { completeCheck } from "../src/gate.ts";
import { buildChapters, chaptersFile, dropSpans, EvidenceKit, evidenceUsage, mapTime, pruneEvidence, sha256File } from "../src/evidence.ts";
import { aAccount, aPrestart, prestartStatus } from "../src/prestart.ts";
import { displayAvailable, precheck, repeatedIssues } from "../src/round.ts";
import { buildVideoFromFrames, concatList, listFrames } from "../src/drivers/egorec.ts";
import { run } from "../src/env/detect.ts";
import type { Case, CaseResult, RoundMeta } from "../src/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-s4-"));
const stub = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};
const res = (id: string, status: CaseResult["status"], over: Partial<CaseResult> = {}): CaseResult => ({ id, title: id, type: "spec", status, warnings: [], steps: [], console: [], pageErrors: [], failedRequests: [], durationMs: 1, startedAt: "2026-10-14T00:00:00Z", ...over });

/** 끝난 회차 기록을 디스크에 만든다 */
function addRound(p: Project, n: number, results: CaseResult[], scope: "full" | "partial" = "full") {
  const active = p.cases().filter((c) => (c.status ?? "active") === "active");
  const { caseHash } = require("../src/store.ts");
  const id = "R" + String(n).padStart(2, "0");
  const meta: RoundMeta = { id, n, status: "finished", startedAt: "", driver: "t", headless: true, data: { decision: "keep", scope: "round" }, scope, caseHash: caseHash(active), caseCount: results.length, code: {}, baseUrl: "http://x" };
  p.writeJson(`rounds/${id}/meta.json`, meta);
  p.writeJson(`rounds/${id}/results.json`, results);
}
const caseOf = (id: string): Case => ({ id, title: id, type: "spec", source_ref: "근거", steps: [{ op: "goto", url: "/" }] });

// ---------- 이슈 정의와 완료 판정 ----------

test("이슈 = 실패 + 불안정 + 검증 못 한 것(BLOCKED). 스킵·해당 없음은 이슈가 아니고, 받아들인 BLOCKED 는 제외", () => {
  const cfg = { acceptedSkips: ["B2"] };
  expect(isIssue(res("F", "FAIL"), cfg)).toBe(true);
  expect(isIssue(res("X", "FLAKY"), cfg)).toBe(true);
  expect(isIssue(res("B1", "BLOCKED"), cfg)).toBe(true);
  expect(isIssue(res("B2", "BLOCKED"), cfg)).toBe(false);
  expect(isIssue(res("S", "SKIP"), cfg)).toBe(false);
  expect(isIssue(res("N", "NA"), cfg)).toBe(false);
  expect(isIssue(res("P", "PASS"), cfg)).toBe(false);
});

test("완료 판정: 스킵이 있어도 이슈 0 이면 완료. BLOCKED·불안정·실패는 완료를 막는다. 도중 코드 변경은 무효 사유가 아니다", () => {
  const p = new Project(tmp());
  p.ensure();
  p.saveCases([caseOf("A"), caseOf("B")]);
  addRound(p, 1, [res("A", "PASS"), res("B", "SKIP", { reason: "규칙" })]);
  const ok = completeCheck(p);
  expect(ok.complete).toBe(true);
  expect(ok.reasons).toEqual([]);

  addRound(p, 2, [res("A", "PASS"), res("B", "BLOCKED", { reason: "환경" })]);
  const b = completeCheck(p);
  expect(b.complete).toBe(false);
  expect(b.reasons.join(" ")).toContain("검증하지 못한 케이스(BLOCKED)");
  const cfg = p.config();
  p.saveConfig({ ...cfg, acceptedSkips: ["B"] });
  expect(completeCheck(p).complete).toBe(true);

  addRound(p, 3, [res("A", "FLAKY"), res("B", "PASS")]);
  expect(completeCheck(p).reasons.join(" ")).toContain("불안정");

  // 회차 도중 코드가 바뀌어도(코드 지문이 달라도) 무효로 보지 않는다
  addRound(p, 4, [res("A", "PASS"), res("B", "PASS")]);
  const m = p.readJson<RoundMeta>("rounds/R04/meta.json", null as any);
  p.writeJson("rounds/R04/meta.json", { ...m, code: { head: "abc", dirtyHash: "x" } });
  expect(completeCheck(p).complete).toBe(true);
});

test("부분 라운드로는 완료 판정을 할 수 없다", () => {
  const p = new Project(tmp());
  p.ensure();
  p.saveCases([caseOf("A")]);
  addRound(p, 1, [res("A", "PASS")], "partial");
  const g = completeCheck(p);
  expect(g.complete).toBe(false);
  expect(g.reasons.join(" ")).toContain("부분 회차");
});

// ---------- 시작 전 질문 ----------

test("시작 전 질문: 남은 질문을 알려 주고, 계정 생성은 만드는 방법을 먼저 묻고, 모두 답해야 ready", () => {
  const p = new Project(tmp());
  p.ensure();
  const s0 = prestartStatus(p);
  expect(s0.ready).toBe(false);
  expect(s0.questions.map((q) => q.id)).toEqual(["data", "max-rounds", "login", "account", "notice"]);
  expect(s0.notice).toContain("테스트 데이터와 테스트 계정만 입력");

  const a = aPrestart(p, { dataPolicy: "keep", maxRounds: 7, login: "provided", account: { mode: "create" } });
  expect(a.questions.map((q) => q.id)).toEqual(["login-details", "account-method", "notice"]);
  expect(p.config().maxRounds).toBe(7);
  const b = aPrestart(p, { loginLocalStorage: { token: "t" }, account: { mode: "create", method: "api" }, acknowledged: true });
  expect(b.ready).toBe(true);
  expect(aPrestart(p, { maxRounds: 0 }).errors.length).toBe(1);

  const c = aPrestart(p, { dataPolicy: "reset" });
  expect(c.questions.map((q) => q.id)).toEqual(["reset-command"]);
  expect(aPrestart(p, { resetCommand: "echo reset" }).ready).toBe(true);
});

test("시작 전 질문을 마치기 전에는 회차를 시작할 수 없다", () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveConfig(p.config());
  writeFileSync(join(root, "plan.md"), "# 기획서");
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: join(root, "plan.md"), addedAt: "" }]);
  p.saveCases([caseOf("A")]);
  const pre: any = precheck(p, { data: "keep" });
  expect(pre.ok).toBe(false);
  expect(pre.decision.options[0].value).toBe("e2e_prestart");
  aPrestart(p, { dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
});

// ---------- 상한과 반복 이슈 ----------

function readyProject() {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveConfig(p.config());
  writeFileSync(join(root, "plan.md"), "# 기획서");
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: join(root, "plan.md"), addedAt: "" }]);
  p.saveCases([caseOf("A"), caseOf("B")]);
  aPrestart(p, { dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  return p;
}

test("라운드 상한: 전체 라운드가 상한에 닿으면 사용자에게 올리고, 부분 라운드는 세지 않는다", () => {
  const p = readyProject();
  aPrestart(p, { maxRounds: 2 });
  addRound(p, 1, [res("A", "FAIL"), res("B", "PASS")]);
  addRound(p, 2, [res("A", "PASS"), res("B", "FAIL")]);
  addRound(p, 3, [res("A", "PASS"), res("B", "PASS")], "partial");
  const full: any = precheck(p, { data: "keep" });
  expect(full.ok).toBe(false);
  expect(full.decision.question).toContain("라운드 상한 2번");
  expect(full.decision.options.map((o: any) => o.value)).toEqual(["raise", "stop"]);
  expect((precheck(p, { data: "keep", only: ["A"] }) as any).ok).toBe(true); // 부분 라운드는 상한과 무관
  aPrestart(p, { maxRounds: 5 });
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
});

test("같은 이슈가 반복 한도(여기선 3으로 정함)만큼 연속이면 사용자에게 올리고, 계속하기로 하면 같은 이슈로는 다시 묻지 않는다", () => {
  const p = readyProject();
  p.saveConfig({ ...p.config(), repeatLimit: 3 });
  for (const n of [1, 2]) addRound(p, n, [res("A", "FAIL"), res("B", n === 1 ? "FAIL" : "PASS")]);
  expect(repeatedIssues(p)).toEqual([]); // 2번뿐
  addRound(p, 3, [res("A", "FAIL"), res("B", "FAIL")]);
  expect(repeatedIssues(p)).toEqual(["A"]); // B 는 연속이 아님
  const ask: any = precheck(p, { data: "keep" });
  expect(ask.ok).toBe(false);
  expect(ask.decision.question).toContain("같은 이슈가 3라운드 연속");
  expect((precheck(p, { data: "keep", acknowledgeRepeated: true }) as any).ok).toBe(true);
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true); // 이미 올렸으니 같은 이슈로는 다시 막지 않음
  // 스킵은 이슈가 아니므로 반복 이슈에 들지 않는다
  const q = readyProject();
  q.saveConfig({ ...q.config(), repeatLimit: 3 });
  for (const n of [1, 2, 3]) addRound(q, n, [res("A", "SKIP"), res("B", "PASS")]);
  expect(repeatedIssues(q)).toEqual([]);
});

test("화면 없는 환경(Linux, DISPLAY 없음)에서 Headed 면 자동 전환하지 않고 묻는다", () => {
  expect(displayAvailable({}, "linux")).toBe(false);
  expect(displayAvailable({ DISPLAY: ":0" }, "linux")).toBe(true);
  expect(displayAvailable({}, "darwin")).toBe(true);
});

test("증거 보관 용량: 80% 에서 경고 수준, 상한을 넘으면 시작 전에 묻고, prune 은 증거만 지운다", () => {
  const p = readyProject();
  const cfg = p.config();
  p.saveConfig({ ...cfg, evidenceLimitMB: 1 });
  addRound(p, 1, [res("A", "PASS")]);
  mkdirSync(p.p("rounds/R01/evidence/A"), { recursive: true });
  writeFileSync(p.p("rounds/R01/evidence/A/video.mp4"), Buffer.alloc(900_000));
  expect(evidenceUsage(p).level).toBe("warn");
  writeFileSync(p.p("rounds/R01/evidence/A/more.bin"), Buffer.alloc(300_000));
  expect(evidenceUsage(p).level).toBe("over");
  const q: any = precheck(p, { data: "keep" });
  expect(q.decision.question).toContain("보관 용량이 상한을 넘었습니다");
  addRound(p, 2, [res("A", "PASS")]);
  const r = pruneEvidence(p, 1);
  expect(r.pruned).toEqual(["R01"]);
  expect(existsSync(p.p("rounds/R01/evidence"))).toBe(false);
  expect(existsSync(p.p("rounds/R01/results.json"))).toBe(true); // 결과는 남는다
  expect(evidenceUsage(p).level).toBe("ok");
});

// ---------- 테스트 계정 ----------

test("테스트 계정: 만드는 방법을 먼저 기록해야 하고, 종료 때 deleteCommand 로 지우며, 방법이 없으면 사람이 지우도록 안내", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  aPrestart(p, { account: { mode: "create" } });
  await expect(aAccount(p, { action: "record", account: { id: "u1" } })).rejects.toThrow("만드는 방법");
  aPrestart(p, { account: { mode: "create", method: "api" } });
  const marker = join(root, "deleted.txt");
  await aAccount(p, { action: "record", account: { id: "u1", username: "e2e-user-1", deleteCommand: `echo "$E2E_ACCOUNT_ID:$E2E_ACCOUNT_USERNAME" >> "${marker}"` } });
  await aAccount(p, { action: "record", account: { id: "u2", username: "e2e-user-2" } });
  await expect(aAccount(p, { action: "record", account: { id: "u1" } })).rejects.toThrow("이미 기록");
  const r: any = await aAccount(p, { action: "cleanup" });
  expect(r.deleted).toEqual(["u1"]);
  expect(readFileSync(marker, "utf8").trim()).toBe("u1:e2e-user-1");
  expect(r.manual[0].id).toBe("u2");
  expect(r.manual[0].how).toContain("api");
  expect(r.pending_cleanup).toBe(1);
  const m: any = await aAccount(p, { action: "mark_deleted", ids: ["u2"] });
  expect(m.pending_cleanup).toBe(0);
  const bad = await aAccount(p, { action: "record", account: { id: "u3", deleteCommand: "exit 3" } });
  const f: any = await aAccount(p, { action: "cleanup" });
  expect(f.failed[0].id).toBe("u3");
  expect(bad.recorded).toBe("u3");
});

// ---------- 증거: 챕터·영상·도장 ----------

test("대기 구간 줄이기: 길게 멈춘 구간만 앞뒤를 남기고 줄이고, 줄어든 시간에 맞춰 시각을 옮긴다", () => {
  const drops = dropSpans([{ start: 1, end: 5 }, { start: 6, end: 6.5 }, { start: 7, end: 9 }]);
  expect(drops.length).toBe(2); // 0.5초짜리는 그대로 둔다
  expect(drops[0]).toEqual({ start: 1.35, end: 4.65 });
  expect(mapTime(0.5, drops)).toBeCloseTo(0.5);
  expect(mapTime(1.35, drops)).toBeCloseTo(1.35);
  expect(mapTime(5, drops)).toBeCloseTo(1.7); // 1.35 + 0.35
  expect(mapTime(10, drops)).toBeCloseTo(10 - 3.3 - 1.3);
});

test("챕터: 스텝 시작 시각에서 만들고, 파일은 ffmpeg 메타데이터 형식", () => {
  const steps = [{ i: 0, desc: "이동 /", at: 0 }, { i: 1, desc: "클릭 #a", at: 2000 }, { i: 2, desc: "확인", at: 6000 }];
  const ch = buildChapters(steps, 8, []);
  expect(ch.map((c) => [c.startMs, c.endMs])).toEqual([[0, 2000], [2000, 6000], [6000, 8000]]);
  expect(ch[1]!.title).toBe("2. 클릭 #a");
  const txt = chaptersFile({ title: "C1 제목", comment: "commit=abc;case=C1" }, ch);
  expect(txt.startsWith(";FFMETADATA1")).toBe(true);
  expect(txt.match(/\[CHAPTER\]/g)!.length).toBe(3);
  expect(txt).toContain("comment=commit\\=abc\\;case\\=C1"); // = ; # 는 메타데이터 형식에 맞게 이스케이프
  expect(buildChapters([], 3, [])[0]!.title).toBe("케이스 전체");
});

const ffmpeg = Bun.which("ffmpeg");
test.skipIf(!ffmpeg)("영상: 가짜 녹화를 mp4(h264)로 바꾸고, 멈춘 구간을 줄이고, 챕터·도장·원본 해시를 남긴다", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  mkdirSync(p.roundDir("R01"), { recursive: true });
  const dir = join(p.roundDir("R01"), "evidence", "C1");
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, "video.mov");
  // 1초 움직임 + 4초 정지 + 1초 움직임
  const g = await run([ffmpeg!, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=10:duration=4", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1", "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", raw]);
  expect(g.code).toBe(0);
  const rawSha = sha256File(raw);
  const kit = new EvidenceKit({ project: p, roundId: "R01", commit: "abcdef1234567" });
  const steps = [{ i: 0, op: "goto", desc: "이동 /", status: "ok" as const, ms: 1, at: 0 }, { i: 1, op: "click", desc: "클릭 #b", status: "ok" as const, ms: 1, at: 1000 }, { i: 2, op: "expect", desc: "확인", status: "ok" as const, ms: 1, at: 5200 }];
  const out = await kit.processVideo(raw, { id: "C1", title: "시험 케이스", steps, startedAt: "2026-10-14T01:02:03.000Z" });
  await kit.close();
  expect(out!.video.endsWith(".mp4")).toBe(true);
  expect(existsSync(raw)).toBe(false); // 원본은 변환 뒤 지운다
  const probe = await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "default=nw=1", out!.video]);
  expect(probe.out).toContain("codec_name=h264");
  const dur = parseFloat(probe.out.match(/duration=([\d.]+)/)![1]!);
  expect(dur).toBeLessThan(4.2); // 6초 중 멈춘 4초를 줄였다
  expect(dur).toBeGreaterThan(2);
  const ch = await run(["ffprobe", "-v", "error", "-show_chapters", "-of", "csv", out!.video]);
  expect(ch.out.trim().split("\n").length).toBe(3);
  const meta = JSON.parse(readFileSync(out!.video.replace(/\.mp4$/, ".chapters.json"), "utf8"));
  expect(meta.commit).toBe("abcdef1234567");
  expect(meta.rawSha256).toBe(rawSha);
  expect(meta.droppedIdleSeconds).toBeGreaterThan(2);
  expect(readFileSync(out!.chapters!, "utf8")).toContain("commit\\=abcdef1234567");
  kit.writeManifest();
  const man = JSON.parse(readFileSync(p.p("rounds/R01/evidence.json"), "utf8"));
  expect(man.files[0]).toMatchObject({ case: "C1", kind: "video", rawSha256: rawSha, commit: "abcdef1234567" });
  expect(man.files[0].sha256).toBe(sha256File(out!.video));
});

test.skipIf(!ffmpeg)("스크린샷 도장: 찍기 전 원본의 해시를 도장과 기록에 남기고, 파일은 실제로 바뀐다", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  mkdirSync(p.roundDir("R01"), { recursive: true });
  const png = join(p.roundDir("R01"), "shot.png");
  await run([ffmpeg!, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:size=600x300", "-frames:v", "1", png]);
  const raw = sha256File(png);
  const kit = new EvidenceKit({ project: p, roundId: "R01", commit: "1234567abcdef" });
  const r = await kit.stampImage(png, "CASE-9");
  await kit.close();
  expect(r!.rawSha256).toBe(raw);
  expect(r!.sha256).not.toBe(raw); // 도장이 얹혀 파일이 달라졌다
  expect(sha256File(png)).toBe(r!.sha256);
  expect(kit.manifest[0]).toMatchObject({ case: "CASE-9", kind: "screenshot", commit: "1234567abcdef", rawSha256: raw });
  expect(kit.stampLine("CASE-9", raw, "T")).toBe(`1234567 | T | CASE-9 | sha256:${raw.slice(0, 10)}`);
});

test("ffmpeg 가 없으면 영상은 원본 그대로 두고 경고를 남긴다", async () => {
  const p = new Project(tmp());
  p.ensure();
  mkdirSync(p.roundDir("R01"), { recursive: true });
  const raw = join(p.roundDir("R01"), "video.webm");
  writeFileSync(raw, "x");
  const kit = new EvidenceKit({ project: p, roundId: "R01" });
  (kit as any).ffmpeg = null;
  const out = await kit.processVideo(raw, { id: "C", title: "t", steps: [], startedAt: "" });
  expect(out!.video).toBe(raw);
});

// ---------- Ego 화면 프레임 → 영상 ----------

test("Ego 프레임: 파일 이름의 시각으로 재생 시간을 정한다(프레임 사이 간격만큼 보여 줌)", () => {
  const dir = tmp();
  for (const [seq, at] of [[2, 1200], [1, 1000], [3, 2000]] as const) writeFileSync(join(dir, `f${String(seq).padStart(6, "0")}_${at}.jpg`), "x");
  writeFileSync(join(dir, "other.txt"), "x");
  const frames = listFrames(dir);
  expect(frames.map((f) => f.at)).toEqual([1000, 1200, 2000]); // 번호 순서
  const list = concatList(frames, 300).split("\n");
  expect(list.filter((l) => l.startsWith("duration")).map((l) => l.split(" ")[1])).toEqual(["0.200", "0.800", "0.300"]);
  expect(list.filter((l) => l.startsWith("file")).length).toBe(4); // 마지막 file 을 한 번 더
});

test.skipIf(!ffmpeg)("Ego 프레임을 mp4(h264)로 만들고 프레임을 지운다. 프레임이 없으면 이유를 돌려준다", async () => {
  const dir = tmp();
  // 가짜 프레임: 색이 바뀌는 jpg 6장(0.2초 간격 → 재생 시간 약 1.4초)
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 6; i++) {
    const r = await run([ffmpeg!, "-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${(i * 40).toString(16).padStart(2, "0")}8040:size=321x241`, "-frames:v", "1", join(dir, `f${String(i + 1).padStart(6, "0")}_${t0 + i * 200}.jpg`)]);
    expect(r.code).toBe(0);
  }
  const out = join(dir, "video.mp4");
  const r = await buildVideoFromFrames(dir, out);
  expect(r.warn).toBeUndefined();
  expect(r.video).toBe(out);
  expect(r.frames).toBe(6);
  const pr = await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "default=nw=1", out]);
  expect(pr.out).toContain("codec_name=h264");
  expect(pr.out).toContain("width=320"); // 홀수 크기는 짝수로 맞춘다
  expect(parseFloat(pr.out.match(/duration=([\d.]+)/)![1]!)).toBeGreaterThan(1.1);
  expect(parseFloat(pr.out.match(/duration=([\d.]+)/)![1]!)).toBeLessThan(1.8);
  expect(listFrames(dir).length).toBe(0); // 프레임은 지운다
  const none = await buildVideoFromFrames(tmp(), join(tmp(), "v.mp4"));
  expect(none.video).toBeUndefined();
  expect(none.warn).toContain("프레임을 하나도 받지 못해");
});
