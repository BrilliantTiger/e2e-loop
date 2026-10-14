import { writeFileSync } from "node:fs";
import type { CaseResult, RoundMeta } from "./types.ts";
import { Project } from "./store.ts";
import { coverage } from "./coverage.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface Diff {
  prev?: string;
  fixed: string[];
  regressed: string[];
  stillFailing: string[];
  newFailures: string[];
  newCases: string[];
}

export function diffWithPrevious(project: Project, meta: RoundMeta, results: CaseResult[]): Diff {
  const prev = [...project.rounds()].reverse().find((r) => r.n < meta.n && r.status === "finished");
  const d: Diff = { prev: prev?.id, fixed: [], regressed: [], stillFailing: [], newFailures: [], newCases: [] };
  if (!prev) return d;
  const old = new Map(project.readJson<CaseResult[]>(`rounds/${prev.id}/results.json`, []).map((r) => [r.id, r.status]));
  for (const r of results) {
    const o = old.get(r.id);
    if (o === undefined) {
      d.newCases.push(r.id);
      if (r.status === "FAIL") d.newFailures.push(r.id);
    } else if (o === "FAIL" && r.status === "PASS") d.fixed.push(r.id);
    else if (o === "PASS" && r.status === "FAIL") d.regressed.push(r.id);
    else if (o === "FAIL" && r.status === "FAIL") d.stillFailing.push(r.id);
  }
  return d;
}

export interface TrendRow { round: string; scope: string; issues: number; fail: number; skip: number; warn: number; pass: number; total: number; tainted: boolean }
/** 회차별 이슈 수 추이. 이슈 = FAIL + 검증 못 한 SKIP. 0 에 수렴하면 끝. */
export function trend(project: Project, upTo?: RoundMeta, upToResults?: CaseResult[]): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const r of project.rounds()) {
    if (r.status === "running" && r.id !== upTo?.id) continue;
    const res = r.id === upTo?.id && upToResults ? upToResults : project.readJson<CaseResult[]>(`rounds/${r.id}/results.json`, []);
    const fail = res.filter((x) => x.status === "FAIL").length;
    const skip = res.filter((x) => x.status === "SKIP").length;
    rows.push({ round: r.id, scope: r.scope, issues: fail + skip, fail, skip, warn: res.filter((x) => x.status === "PASS" && x.warnings.length).length, pass: res.filter((x) => x.status === "PASS").length, total: res.length, tainted: !!r.tainted });
  }
  return rows;
}

function fixHint(r: CaseResult): string {
  const m = r.reason ?? "";
  if (/Timeout|waiting for|locator|요소를 찾지/i.test(m) && !/보여야|보임/.test(m)) return "선택자가 맞지 않거나 요소가 화면에 없음 → 화면 코드의 해당 요소/라벨/테스트 id 확인 (기획서와 다르게 바뀌었는지 비교)";
  if (/JS 오류/.test(m)) return "화면 JS 오류 → 콘솔 오류의 파일·줄을 확인";
  if (/서버\/네트워크 오류/.test(m)) return "서버 5xx 또는 연결 오류 → 해당 API 로그 확인";
  if (/모달/.test(m)) return "모달 닫기 동작 누락 → Esc·닫기 버튼 처리 확인";
  if (/제출이 진행됨/.test(m)) return "필수값 검증 누락 → 폼 검증 로직 확인";
  if (/오류처럼|404/.test(m)) return "링크 대상 화면이 404/오류 → 링크 주소 또는 해당 라우트 확인";
  if (/주소|링크 이동/.test(m)) return "링크 대상 경로가 다르거나 라우팅 누락";
  if (/텍스트|값이 다름|개수/.test(m)) return "화면 값이 기대와 다름 → 기획서/디자인의 기대값과 실제 데이터를 비교(데이터 상태 영향 가능)";
  return "실패 단계와 증거(스크린샷·영상·trace)를 보고 원인 확인";
}

export function writeReports(project: Project, meta: RoundMeta, results: CaseResult[]) {
  const dir = project.roundDir(meta.id);
  const diff = diffWithPrevious(project, meta, results);
  const cov = coverage(project);
  const tr = trend(project, meta, results);
  const fails = results.filter((r) => r.status === "FAIL").sort((a, b) => (a.priority ?? "P9").localeCompare(b.priority ?? "P9"));
  const warned = results.filter((r) => r.status === "PASS" && r.warnings.length);
  const skipped = results.filter((r) => r.status === "SKIP");
  const s = meta.summary!;
  const verdict = meta.status !== "finished" ? "INCOMPLETE" : meta.tainted ? "TAINTED" : s.FAIL > 0 ? "FAIL" : s.SKIP > 0 ? "PASS_WITH_SKIPS" : "PASS";

  // ── AI용 JSON ──
  const json = {
    round: meta.id, verdict, scope: meta.scope, driver: meta.driver, data: meta.data, startedAt: meta.startedAt, finishedAt: meta.finishedAt,
    tainted: meta.tainted ?? null, error: meta.error ?? null, code: meta.code, summary: s, diff,
    trend: tr,
    pendingFeedback: meta.pendingFeedback ?? [],
    injected: meta.injected ?? [],
    failures: fails.map((r) => ({
      id: r.id, title: r.title, priority: r.priority, type: r.type, event: r.event, source_ref: r.source_ref, element: r.element,
      reason: r.reason, failedStep: r.steps.find((x) => x.status === "fail") ?? null,
      pageErrors: r.pageErrors, failedRequests: r.failedRequests, console: r.console.slice(0, 5),
      evidence: { screenshot: r.steps.find((x) => x.status === "fail")?.shot, video: r.video, trace: r.trace }, hint: fixHint(r),
    })),
    warnings: warned.map((r) => ({ id: r.id, title: r.title, warnings: r.warnings })),
    skipped: skipped.map((r) => ({ id: r.id, title: r.title, reason: r.reason })),
    coverage: { elements: { total: cov.elements.total, uncovered: cov.elements.uncovered }, cases: cov.cases, uncoveredSections: cov.sources.flatMap((x) => x.uncoveredSections.map((n) => `${x.title}: ${n}`)) },
  };
  writeFileSync(`${dir}/report.json`, JSON.stringify(json, null, 2));

  // ── AI용 MD (짧게: 실패와 다음 행동만) ──
  const L: string[] = [];
  L.push(`# E2E ${meta.id} — ${verdict}`);
  L.push(`- 범위 ${meta.scope === "full" ? "전체" : "부분"} · 브라우저 ${meta.driver} · 데이터 ${meta.data.decision} · 코드 ${meta.code.head ?? "?"}${meta.code.dirtyHash ? ` (+변경 ${meta.code.dirtyHash})` : ""}`);
  L.push(`- PASS ${s.PASS} · FAIL ${s.FAIL} · SKIP ${s.SKIP} · BLOCKED ${s.BLOCKED} · NA ${s.NA} / ${s.total}`);
  if (meta.tainted) L.push(`- ⚠ ${meta.tainted}`);
  if (meta.error) L.push(`- ⚠ ${meta.error}`);
  if (diff.prev) L.push(`- 이전 ${diff.prev} 대비: 고쳐짐 ${diff.fixed.length} · 새로 깨짐 ${diff.regressed.length} · 계속 실패 ${diff.stillFailing.length} · 새 케이스 ${diff.newCases.length}${diff.regressed.length ? ` (회귀: ${diff.regressed.join(", ")})` : ""}`);
  L.push(`- 이슈 추이: ${tr.map((t) => `${t.round}=${t.issues}`).join(" → ")} (0 에 수렴하면 종료)`);
  if (meta.pendingFeedback?.length) L.push(`- ⚠ 이 회차 시작 때 아직 반영 안 된 사용자 요청 ${meta.pendingFeedback.length}건: ${meta.pendingFeedback.map((f) => `${f.id} ${f.text.slice(0, 40)}`).join(" / ")}`);
  if (meta.injected?.length) L.push(`- ⚠ 회차 도중 끼워 넣은 케이스 ${meta.injected.length}건(이 회차는 완료 근거 아님): ${meta.injected.join(", ")}`);
  if (fails.length) {
    L.push("", "## 실패 (우선순위순)");
    for (const r of fails) {
      const st = r.steps.find((x) => x.status === "fail");
      L.push(`- **${r.priority} ${r.id}** ${r.title}${r.source_ref ? ` [근거: ${r.source_ref}]` : ""}`);
      L.push(`  - 단계 ${st ? `${st.i + 1}. ${st.desc}` : "-"} → ${r.reason}`);
      if (r.pageErrors.length) L.push(`  - JS 오류: ${r.pageErrors[0]}`);
      const bad = r.failedRequests.filter((x) => /^(5\d\d|ERR)/.test(x));
      if (bad.length) L.push(`  - 오류 요청: ${bad.slice(0, 3).join(" ; ")}`);
      L.push(`  - 힌트: ${fixHint(r)}`);
      L.push(`  - 증거: ${[st?.shot, r.video, r.trace].filter(Boolean).map((p) => `rounds/${meta.id}/${p}`).join(" , ")}`);
    }
  }
  if (skipped.length) L.push("", `## 검증 못 함(SKIP) ${skipped.length}건`, ...skipped.slice(0, 15).map((r) => `- ${r.id} ${r.title}`), "→ 데이터 초기화 회차에서 실행해야 완료 판정 가능");
  if (warned.length) L.push("", `## 경고(PASS 지만 확인 필요) ${warned.length}건`, ...warned.slice(0, 15).map((r) => `- ${r.id} ${r.title}: ${r.warnings[0]}`));
  if (cov.elements.uncovered) L.push("", `## 커버리지: 케이스가 없는 요소 ${cov.elements.uncovered}개 (e2e_coverage 로 목록 확인)`);
  const us = json.coverage.uncoveredSections;
  if (us.length) L.push("", `## 케이스가 없는 문서 절 ${us.length}개`, ...us.slice(0, 15).map((x) => `- ${x}`));
  L.push("", "## 다음 행동");
  L.push(verdict === "PASS" ? "- 전체 회차면 e2e_complete_check 로 완료 판정." : "- 이 회차가 끝난 지금 결함을 우선순위대로 수정(회차 도중 수정 금지) → e2e_round_start 로 전체 회차를 처음부터 다시.");
  writeFileSync(`${dir}/report.md`, L.join("\n") + "\n");

  // ── 사람용 HTML ──
  const badge = (st: string) => `<span class="b ${st}">${st}</span>`;
  const rows = results
    .map((r) => {
      const steps = r.steps
        .map((x) => `<tr class="${x.status}"><td>${x.i + 1}</td><td>${esc(x.desc)}</td><td>${x.status}</td><td>${x.ms}ms</td><td>${x.shot ? `<a href="${esc(x.shot)}" target="_blank"><img loading="lazy" src="${esc(x.shot)}"></a>` : ""}</td></tr>${x.error ? `<tr class="err"><td></td><td colspan="4">${esc(x.error)}</td></tr>` : ""}`)
        .join("");
      const sig = [...r.pageErrors.map((e) => `JS 오류: ${e}`), ...r.failedRequests.map((e) => `요청: ${e}`), ...r.console.map((e) => `console.error: ${e}`)];
      return `<details class="case ${r.status}" ${r.status === "FAIL" ? "open" : ""}><summary>${badge(r.status)} <b>${esc(r.id)}</b> ${esc(r.title)} ${r.priority ? `<span class="p">${r.priority}</span>` : ""}<span class="m">${r.durationMs}ms${r.warnings.length ? ` · 경고 ${r.warnings.length}` : ""}</span></summary>
      <div class="body">${r.reason ? `<p class="reason">${esc(r.reason)}</p>` : ""}${r.source_ref ? `<p>근거: ${esc(r.source_ref)}</p>` : ""}
      ${r.video ? `<video controls preload="none" src="${esc(r.video)}"></video>` : ""}${r.trace ? `<p><a href="${esc(r.trace)}">trace.zip</a> (<code>bunx playwright show-trace</code>)</p>` : ""}
      <table class="steps"><tr><th>#</th><th>단계</th><th>결과</th><th>시간</th><th>화면</th></tr>${steps}</table>
      ${r.warnings.length ? `<ul class="warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${sig.length ? `<ul class="sig">${sig.slice(0, 12).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div></details>`;
    })
    .join("\n");
  const list = (ids: string[]) => (ids.length ? ids.map(esc).join(", ") : "없음");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E2E ${meta.id} 결과</title>
<style>
:root{--bg:#fff;--fg:#1c2230;--mut:#667;--card:#f4f6fa;--line:#dde2ea;--pass:#1a7f4b;--fail:#c0392b;--warn:#b7791f;--skip:#6b7280}
@media(prefers-color-scheme:dark){:root{--bg:#10141c;--fg:#e6e9ef;--mut:#98a2b3;--card:#181e29;--line:#2a3342}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Apple SD Gothic Neo",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 80px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.meta{color:var(--mut)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.card b{font-size:22px;display:block}
.v{display:inline-block;padding:3px 12px;border-radius:99px;color:#fff;font-weight:700}.v.PASS{background:var(--pass)}.v.FAIL,.v.TAINTED,.v.INCOMPLETE{background:var(--fail)}.v.PASS_WITH_SKIPS{background:var(--warn)}
.b{font-size:11px;font-weight:700;padding:1px 7px;border-radius:5px;color:#fff;margin-right:6px}.b.PASS{background:var(--pass)}.b.FAIL{background:var(--fail)}.b.SKIP,.b.NA,.b.BLOCKED{background:var(--skip)}
details.case{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--card)}details.case.FAIL{border-color:var(--fail)}
summary{cursor:pointer;padding:8px 12px}.m{float:right;color:var(--mut);font-size:12px}.p{color:var(--fail);font-weight:700;margin-left:6px}
.body{padding:4px 14px 14px}.reason{color:var(--fail);font-weight:600}video{max-width:100%;border-radius:8px;margin:6px 0}
table.steps{border-collapse:collapse;width:100%;font-size:13px}.steps td,.steps th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
tr.fail td{color:var(--fail);font-weight:600}tr.err td{color:var(--fail);font-size:12px}tr.skip td{color:var(--mut)}.steps img{height:54px;border-radius:4px;border:1px solid var(--line)}
.warn li{color:var(--warn)}.sig li{color:var(--mut);font-size:12px}code{background:var(--card);padding:1px 5px;border-radius:4px}
.trend{display:flex;gap:14px;align-items:flex-end;margin:8px 0 16px}.tb{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12px}.bar{width:28px;border-radius:4px 4px 0 0}
.tw{background:#fff3cd;color:#664d03;border:1px solid #ffe69c;padding:8px 12px;border-radius:8px;margin:12px 0}
</style></head><body><main>
<h1>E2E ${meta.id} 결과 <span class="v ${verdict}">${verdict}</span></h1>
<div class="meta">${esc(meta.baseUrl)} · ${meta.scope === "full" ? "전체 회차" : "부분 회차"} · 브라우저 ${esc(meta.driver)} · 데이터 ${esc(meta.data.decision)} · 코드 ${esc(meta.code.head ?? "-")} · ${esc(meta.startedAt)} ~ ${esc(meta.finishedAt ?? "")}</div>
${meta.tainted ? `<div class="tw">⚠ ${esc(meta.tainted)}</div>` : ""}${meta.error ? `<div class="tw">⚠ ${esc(meta.error)}</div>` : ""}
<div class="cards"><div class="card"><b style="color:var(--pass)">${s.PASS}</b>PASS</div><div class="card"><b style="color:var(--fail)">${s.FAIL}</b>FAIL</div><div class="card"><b>${s.SKIP}</b>SKIP</div><div class="card"><b>${s.BLOCKED + s.NA}</b>BLOCKED/NA</div><div class="card"><b>${s.total}</b>전체</div><div class="card"><b>${warned.length}</b>경고</div></div>
${diff.prev ? `<h2>이전 회차(${diff.prev})와 비교</h2><p>고쳐짐: ${list(diff.fixed)}<br>새로 깨짐: ${list(diff.regressed)}<br>계속 실패: ${list(diff.stillFailing)}<br>새 케이스: ${diff.newCases.length}건</p>` : ""}
<h2>이슈 추이 <small class="meta">(이슈 = FAIL + 검증 못 한 SKIP, 0 이 되면 종료)</small></h2>
<div class="trend">${tr.map((t) => `<div class="tb"><div class="bar" style="height:${Math.min(100, 6 + t.issues * 8)}px;background:${t.issues ? "var(--fail)" : "var(--pass)"}"></div><b>${t.issues}</b><span>${t.round}${t.scope === "partial" ? "·부분" : ""}${t.tainted ? "·무효" : ""}</span></div>`).join("")}</div>
${meta.pendingFeedback?.length ? `<div class="tw">이 회차 시작 때 아직 반영되지 않은 요청 ${meta.pendingFeedback.length}건: ${meta.pendingFeedback.map((f) => esc(f.id + " " + f.text)).join(" / ")}</div>` : ""}${meta.injected?.length ? `<div class="tw">회차 도중 끼워 넣은 케이스 ${meta.injected.length}건 — 이 회차는 완료 근거가 아닙니다: ${meta.injected.map(esc).join(", ")}</div>` : ""}
<h2>결함 ${fails.length}건 (우선순위순)</h2>
${fails.length ? `<table class="steps"><tr><th>순위</th><th>케이스</th><th>원인</th><th>힌트</th></tr>${fails.map((r) => `<tr><td>${r.priority}</td><td><b>${esc(r.id)}</b> ${esc(r.title)}</td><td>${esc(r.reason)}</td><td>${esc(fixHint(r))}</td></tr>`).join("")}</table>` : "<p>없음</p>"}
<h2>커버리지</h2><p>화면 요소 ${cov.elements.total}개 중 케이스 없음 ${cov.elements.uncovered}개 · 케이스 ${cov.cases.total}건(기획서 기반 ${cov.cases.spec} / 자동 점검 ${cov.cases.probe})${json.coverage.uncoveredSections.length ? `<br>케이스 없는 문서 절: ${json.coverage.uncoveredSections.map(esc).join(", ")}` : ""}</p>
<h2>케이스별 결과</h2>
${rows}
</main></body></html>`;
  writeFileSync(`${dir}/report.html`, html);
  return { verdict, files: { html: `${dir}/report.html`, md: `${dir}/report.md`, json: `${dir}/report.json` } };
}
