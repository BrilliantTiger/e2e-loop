// 오류 V: 로그인 만료 — 남은 토큰을 다시 써서 시험 도중 만료돼 로그인 화면으로 튕김.
// 시작 전에 토큰의 남은 시간을 보고 짧으면 시작하지 않고, 도중에 튕기거나 401 을 받고 실패한 케이스는 FAIL 이 아니라 NA(V).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtExp, onLoginScreen, tokenProblem, tokensLeft } from "../src/authexp.ts";
import { runCase } from "../src/runner.ts";
import { precheck } from "../src/round.ts";
import { excludedRows, toolErrorCount } from "../src/toolerror.ts";
import { aPrestart } from "../src/prestart.ts";
import { Project } from "../src/store.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case } from "../src/types.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (expSec: number) => `eyJhbGciOiJIUzI1NiJ9.${b64({ sub: "tester", exp: expSec })}.sig`;
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0); // 19:00 KST

test("토큰의 만료 시각을 읽어 남은 시간이 짧거나 만료됐으면 시작 전 사유를 낸다", () => {
  const exp = NOW / 1000 + 60 * 60; // 1시간 남음
  expect(jwtExp(`{"accessToken":"${jwt(exp)}"}`)).toBe(exp * 1000);
  expect(jwtExp("plain-token")).toBeUndefined();
  const cfg = { auth: { localStorage: { auth: JSON.stringify({ accessToken: jwt(exp) }) } } };
  expect(tokensLeft(cfg, NOW)).toEqual([{ where: "localStorage auth", expiresAt: exp * 1000, leftMin: 60 }]);
  expect(tokenProblem(cfg, NOW)).toContain("localStorage auth 남은 60분(2026-10-20 20:00 KST 만료)");
  expect(tokenProblem({ auth: { cookies: [{ name: "sid", value: jwt(NOW / 1000 - 10) }] } }, NOW)).toContain("cookie sid 만료됨");
  // 넉넉하면(기본 240분 이상) 문제 없음, 기준을 낮추면 1시간도 통과
  expect(tokenProblem({ auth: { localStorage: { t: jwt(NOW / 1000 + 12 * 3600) } } }, NOW)).toBeUndefined();
  expect(tokenProblem({ auth: { ...cfg.auth, minRemainingMin: 30 } }, NOW)).toBeUndefined();
  // JWT 가 아니면 남은 시간을 알 수 없어 막지 않는다
  expect(tokenProblem({ auth: { localStorage: { t: "opaque" } } }, NOW)).toBeUndefined();
});

test("로그인 화면 판별: loginPath 에 맞고, 로그인 화면으로 가는 것이 목표가 아닐 때만", () => {
  const cfg = { auth: { loginPath: "^/login" } };
  expect(onLoginScreen(cfg, "/login")).toBe(true);
  expect(onLoginScreen(cfg, "/l2/datasets/1/time-anchor")).toBe(false);
  expect(onLoginScreen(cfg, "/login", "/login")).toBe(false);
  expect(onLoginScreen({}, "/login")).toBe(false);
});

const mk = (id: string): Case => ({ id, title: id, type: "spec", source_ref: "기획서 2210", screen: "/time-anchor", feature: "Time anchor", chapter: "C11", steps: [{ op: "goto", url: "/time-anchor" }, { op: "expect", sel: "#candidates", textContains: "후보", basis: "CCB-2210" }] });

test("도중에 로그인 화면으로 튕기면 읽지 않고 NA(V) — 도구 오류로 세고 제외 시트에 V 로 오른다", async () => {
  const reads: string[] = [];
  const ctx = fakeCtx({ url: async () => "http://fake/login?next=/time-anchor", text: async (s: string) => (reads.push(s), "") });
  ctx.cfg.auth = { loginPath: "^/login" };
  const r = await runCase(ctx, mk("V-1"));
  expect(r.status).toBe("NA");
  expect(r.toolError?.kind).toBe("V");
  expect(r.reason).toContain("로그인 화면(/login)으로 튕김");
  expect(reads).toEqual([]);
  expect(toolErrorCount([r])).toBe(1);
  const row = excludedRows([r], () => "C11", { round: "R10" })[0]!;
  expect(row.kind).toBe("V");
  expect(row.action).toContain("새로 로그인해 토큰을 바꾼 뒤");
});

test("실패한 뒤 401 을 받았으면 NA(V), 로그인 설정이 없거나 401 이 없으면 그대로 FAIL", async () => {
  const drain = async () => ({ console: [], pageErrors: [], failedRequests: ["401 GET /api/l2/datasets/1/time-anchor"] });
  const ctx = fakeCtx({ text: async () => "", drain });
  ctx.cfg.auth = { localStorage: { t: "x" } };
  const r = await runCase(ctx, mk("V-2"));
  expect(r.toolError?.kind).toBe("V");
  expect(r.reason).toContain("401 받음: 401 GET /api/l2/datasets/1/time-anchor");
  const noAuth = await runCase(fakeCtx({ text: async () => "빈 목록", drain }), mk("V-3"));
  expect(noAuth.status).toBe("FAIL");
  const ctx2 = fakeCtx({ text: async () => "빈 목록" });
  ctx2.cfg.auth = { localStorage: { t: "x" } };
  expect((await runCase(ctx2, mk("V-4"))).status).toBe("FAIL");
});

test("시작 전 점검: 심을 토큰의 남은 시간이 짧으면 라운드를 시작하지 않고, 새 토큰이면 시작한다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-ax-"));
  const p = new Project(root);
  p.ensure();
  writeFileSync(join(root, "plan.md"), "# 기획서");
  p.writeJson("sources.json", [{ id: "S01", kind: "plan", title: "기획서", location: join(root, "plan.md"), addedAt: "" }]);
  p.saveCases([mk("V-9")]);
  aPrestart(p, { dataPolicy: "keep", maxRounds: 10, login: "none", account: { mode: "none" }, acknowledged: true });
  const cfg = p.config();
  cfg.auth = { localStorage: { auth: jwt(Date.now() / 1000 + 30 * 60) }, loginPath: "^/login", minRemainingMin: 120 };
  p.saveConfig(cfg);
  const pre: any = precheck(p, { data: "keep" });
  expect(pre.ok).toBe(false);
  expect(pre.error).toContain("120분보다 짧습니다");
  cfg.auth.localStorage = { auth: jwt(Date.now() / 1000 + 12 * 3600) };
  p.saveConfig(cfg);
  expect((precheck(p, { data: "keep" }) as any).ok).toBe(true);
});

test("선행 챕터가 로그인 만료(V)로 끝나면 하위 챕터는 누르지 않고 NA(R) — 재시험 대기열로 간다", async () => {
  const { DefectGuard } = await import("../src/chapter.ts");
  const g = new DefectGuard((c) => c.chapter!);
  const c11 = mk("C11-1");
  const c12: Case = { ...mk("C12-1"), chapter: "C12", requires: ["C11"] };
  const ctx = fakeCtx({ url: async () => "http://fake/login" });
  ctx.cfg.auth = { loginPath: "^/login" };
  g.record(c11, await runCase(ctx, c11));
  const by = g.toolBlockedBy(c12)!;
  expect(by).toEqual({ chapter: "C11", by: ["C11-1"] });
  const r = g.toolNaResult(c12, by);
  expect(r.toolError?.kind).toBe("R");
  expect(r.retest?.after).toBe("C11");
});
