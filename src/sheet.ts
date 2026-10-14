// 테스트 시트: 화면 → 기능 단위 → 케이스로 묶고, 케이스마다 근거를 적는다.
// 라운드 시작 전에 요약을 사용자에게 한 번 보여 준다(기본은 묻지 않고 바로 시작, 사용자가 원하면 확인 후 시작).
import type { Case } from "./types.ts";
import { Project, caseHash, nowIso } from "./store.ts";
import { loadAnalyses } from "./analysis/store.ts";
import { reconcile } from "./analysis/reconcile.ts";
import { coverage } from "./coverage.ts";
import { readIntake } from "./session.ts";

export interface SheetCase {
  id: string;
  title: string;
  type: string;
  event?: string;
  source_ref?: string;
  risk?: string;
  status: string;
  needs_os?: boolean;
  skip?: string;
}

export interface Sheet {
  generatedAt: string;
  caseHash: string;
  baseUrl: string;
  confirmedAt?: string;
  totals: { screens: number; features: number; cases: number; spec: number; probe: number; blocked: number; na: number; skip: number; needsOs: number };
  screens: { screen: string; features: { feature: string; cases: SheetCase[] }[] }[];
  sources: { id: string; kind: string; title: string; location: string }[];
  gaps: {
    unreachedRoutes: { path: string; where: string }[];
    dynamicRoutes: { path: string; where: string }[];
    codeOnlyRoutes: { path: string; where: string }[];
    eventsNotOnScreen: { kind: string; where: string; hint: string }[];
    apisNeedingInput: { method: string; url: string; where: string }[];
    uncoveredElements: number;
    blockedCases: { id: string; reason: string }[];
  };
}

const screenOf = (c: Case): string => {
  if (c.screen) return c.screen;
  const g = c.steps.find((s) => s.op === "goto" && typeof s.url === "string");
  if (g) {
    try {
      return new URL(g.url, "http://x").pathname || "/";
    } catch {}
  }
  return "(화면 미지정)";
};
const featureOf = (c: Case): string => c.feature ?? c.source_ref ?? "(기능 미지정)";

export function buildSheet(p: Project): Sheet {
  const cfg = p.config();
  const cases = p.cases();
  const byScreen = new Map<string, Map<string, SheetCase[]>>();
  for (const c of cases) {
    const sc = screenOf(c);
    const ft = featureOf(c);
    const f = byScreen.get(sc) ?? new Map<string, SheetCase[]>();
    const list = f.get(ft) ?? [];
    list.push({ id: c.id, title: c.title, type: c.type, event: c.event, source_ref: c.source_ref, risk: c.risk, status: c.status ?? "active", needs_os: c.needs_os, skip: c.skipReason });
    f.set(ft, list);
    byScreen.set(sc, f);
  }
  // 눌러 볼 요소가 없어 케이스가 없는 화면도 시트에 올린다(열리는지는 다른 화면의 링크 케이스가 본다)
  for (const pg of p.inventory()?.pages ?? []) {
    const path = pg.path.split("?")[0]!;
    if (!byScreen.has(path)) byScreen.set(path, new Map());
  }
  const screens = [...byScreen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([screen, fm]) => ({ screen, features: [...fm.entries()].map(([feature, cs]) => ({ feature, cases: cs })) }));

  const analyses = loadAnalyses(p);
  const rec = reconcile(analyses, p.inventory());
  const where = (r: { file: string; line: number }) => `${r.file}:${r.line}`;
  const cov = p.inventory() ? coverage(p) : null;
  const prev = p.readJson<Sheet | null>("sheet.json", null);
  const hash = caseHash(cases.filter((c) => (c.status ?? "active") === "active"));
  const sheet: Sheet = {
    generatedAt: nowIso(),
    caseHash: hash,
    baseUrl: cfg.baseUrl,
    confirmedAt: prev && prev.caseHash === hash ? prev.confirmedAt : undefined,
    totals: {
      screens: screens.length,
      features: screens.reduce((n, s) => n + s.features.length, 0),
      cases: cases.length,
      spec: cases.filter((c) => c.type === "spec").length,
      probe: cases.filter((c) => c.type === "probe").length,
      blocked: cases.filter((c) => c.status === "blocked").length,
      na: cases.filter((c) => c.status === "na").length,
      skip: cases.filter((c) => c.skipReason).length,
      needsOs: cases.filter((c) => c.needs_os).length,
    },
    screens,
    sources: p.sources().map((s) => ({ id: s.id, kind: s.kind, title: s.title, location: s.location })),
    gaps: {
      unreachedRoutes: rec.routes.filter((r) => r.status === "unreached").map((r) => ({ path: r.route.path, where: where(r.route) })),
      dynamicRoutes: rec.routes.filter((r) => r.status === "dynamic").map((r) => ({ path: r.route.path, where: where(r.route) })),
      codeOnlyRoutes: rec.routes.filter((r) => r.status === "code-only").map((r) => ({ path: r.route.path, where: where(r.route) })),
      eventsNotOnScreen: rec.eventsNotOnScreen.slice(0, 30).map((e) => ({ kind: e.kind, where: `${e.file}:${e.line}`, hint: Object.values(e.hints).filter(Boolean).join(" / ") })),
      apisNeedingInput: rec.apisNotObserved.filter((a) => a.method !== "GET" || a.dynamic).slice(0, 30).map((a) => ({ method: a.method, url: a.url, where: `${a.file}:${a.line}` })),
      uncoveredElements: cov?.elements.uncovered ?? 0,
      blockedCases: cases.filter((c) => c.status === "blocked").map((c) => ({ id: c.id, reason: c.reason ?? "(사유 없음)" })),
    },
  };
  return sheet;
}

const STATUS_MARK: Record<string, string> = { active: "", blocked: " [보류]", na: " [해당 없음]" };

export function renderSheetMd(s: Sheet, opts: { full?: boolean } = {}): string {
  const out: string[] = [];
  const t = s.totals;
  out.push(`# 테스트 시트 — ${s.baseUrl}`);
  out.push("");
  out.push(`화면 ${t.screens}개 · 기능 단위 ${t.features}개 · 케이스 ${t.cases}건 (기획서·디자인 등에서 옮긴 ${t.spec}건, 자동 점검 ${t.probe}건)`);
  if (t.blocked || t.na || t.skip) out.push(`보류 ${t.blocked}건 · 해당 없음 ${t.na}건 · 스킵 ${t.skip}건`);
  if (s.sources.length) out.push(`근거: ${s.sources.map((x) => `${x.kind} “${x.title}”`).join(", ")}`);
  out.push("");
  const limit = opts.full ? 9999 : 3;
  for (const sc of s.screens) {
    const n = sc.features.reduce((a, f) => a + f.cases.length, 0);
    out.push(`## ${sc.screen} — 케이스 ${n}건${n === 0 ? " (눌러 볼 요소가 없는 화면. 열리는지는 다른 화면의 링크 케이스가 확인)" : ""}`);
    for (const f of sc.features) {
      out.push(`- **${f.feature}** (${f.cases.length}건)`);
      for (const c of f.cases.slice(0, limit)) out.push(`  - ${c.id} ${c.title}${STATUS_MARK[c.status] ?? ""}${c.skip ? " [스킵]" : ""}${c.source_ref ? ` — 근거: ${c.source_ref}` : ""}`);
      if (f.cases.length > limit) out.push(`  - … 외 ${f.cases.length - limit}건`);
    }
  }
  const g = s.gaps;
  const gapLines: string[] = [];
  if (g.unreachedRoutes.length) gapLines.push(`- 코드에는 있는데 열어 보지 못한 화면 ${g.unreachedRoutes.length}개: ${g.unreachedRoutes.slice(0, 8).map((r) => `${r.path} (${r.where})`).join(", ")}`);
  if (g.codeOnlyRoutes.length) gapLines.push(`- 링크로는 닿지 않고 코드로만 알게 되어 직접 연 화면 ${g.codeOnlyRoutes.length}개: ${g.codeOnlyRoutes.slice(0, 8).map((r) => `${r.path} (${r.where})`).join(", ")}`);
  if (g.dynamicRoutes.length) gapLines.push(`- 값(:id 등)이 있어야 열리는 화면 ${g.dynamicRoutes.length}개 — 샘플 값을 알려 주면 케이스로 만든다: ${g.dynamicRoutes.slice(0, 8).map((r) => r.path).join(", ")}`);
  if (g.eventsNotOnScreen.length) gapLines.push(`- 코드의 이벤트 중 화면에서 요소를 못 찾은 것 ${g.eventsNotOnScreen.length}건(로그인·특정 상태에서만 보일 수 있음): ${g.eventsNotOnScreen.slice(0, 5).map((e) => `${e.kind} ${e.hint} (${e.where})`).join(", ")}`);
  if (g.apisNeedingInput.length) gapLines.push(`- 요청 본문·값이 있어야 점검할 수 있는 API ${g.apisNeedingInput.length}건 — 기능정의서의 요청 예시로 케이스를 만든다: ${g.apisNeedingInput.slice(0, 6).map((a) => `${a.method} ${a.url}`).join(", ")}`);
  if (g.uncoveredElements) gapLines.push(`- 케이스가 없는 화면 요소 ${g.uncoveredElements}개`);
  if (g.blockedCases.length) gapLines.push(`- 보류 케이스 ${g.blockedCases.length}건: ${g.blockedCases.slice(0, 5).map((b) => `${b.id}(${b.reason})`).join(", ")}`);
  if (gapLines.length) out.push("", "## 빈틈과 주의", ...gapLines);
  return out.join("\n");
}

export function aSheet(p: Project, a: { confirm?: boolean; confirm_before_start?: boolean; full?: boolean }) {
  const intake = readIntake(p);
  if (a.confirm_before_start !== undefined) {
    intake.sheetConfirm = a.confirm_before_start;
    intake.updatedAt = nowIso();
    p.writeJson("intake.json", intake);
  }
  const sheet = buildSheet(p);
  if (a.confirm) sheet.confirmedAt = nowIso();
  p.writeJson("sheet.json", sheet);
  const md = renderSheetMd(sheet, { full: true });
  p.ensure();
  Bun.write(p.p("sheet.md"), md);
  const needConfirm = !!intake.sheetConfirm;
  const ready = !needConfirm || !!sheet.confirmedAt;
  const hasCases = sheet.totals.cases > 0;
  return {
    summary: renderSheetMd(sheet, { full: !!a.full }),
    paths: { json: p.p("sheet.json"), markdown: p.p("sheet.md") },
    confirm_before_start: needConfirm,
    confirmed: !!sheet.confirmedAt,
    ready_to_start: ready && hasCases,
    next: !hasCases
      ? "케이스가 없습니다. e2e_discover 와 e2e_case_upsert 로 시트를 채우세요."
      : needConfirm && !sheet.confirmedAt
        ? "사용자가 시트 확인을 원했습니다. summary 를 보여 주고 승인을 받은 뒤 e2e_sheet 를 confirm=true 로 다시 호출하세요. 그 전에는 라운드를 시작할 수 없습니다."
        : "summary 를 사용자에게 한 번 보여 주고, 묻지 말고 바로 시작 전 질문(데이터 초기화·상한·계정)으로 넘어가 라운드를 시작하세요.",
  };
}

/** 라운드를 시작해도 되는지: 사용자가 확인을 원했다면 확인된 시트여야 한다. */
export function sheetGate(p: Project): { ok: true } | { ok: false; error: string } {
  if (!readIntake(p).sheetConfirm) return { ok: true };
  const sh = p.readJson<Sheet | null>("sheet.json", null);
  const hash = caseHash(p.cases().filter((c) => (c.status ?? "active") === "active"));
  if (sh?.confirmedAt && sh.caseHash === hash) return { ok: true };
  return { ok: false, error: "사용자가 시트를 확인한 뒤 시작하기를 원했습니다. e2e_sheet 로 요약을 보여 주고 승인을 받아 confirm=true 로 확정하세요(케이스가 바뀌면 다시 확인이 필요합니다)." };
}
