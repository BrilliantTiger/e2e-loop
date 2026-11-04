// 이슈 흐름: 라운드마다 이슈가 새로 생겼는지·계속 남았는지·다시 생겼는지·고쳐졌는지 세고, 이슈마다 라운드별 상태를 모은다.
// 사람용 보고서(report.html)와 현황판이 같은 계산과 같은 그림(SVG)을 쓴다.
import { existsSync, statSync } from "node:fs";
import type { CaseResult, RoundMeta, Verdict } from "./types.ts";
import { Project } from "./store.ts";
import { isIssue } from "./issues.ts";
import { langTable, tx } from "./i18n.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface RoundFlow {
  round: string;
  scope: RoundMeta["scope"];
  status: RoundMeta["status"];
  /** 비교한 앞 라운드(전체 라운드는 앞 전체 라운드, 부분 라운드는 바로 앞 라운드 — 이전 라운드 비교와 같은 규칙) */
  prev?: string;
  /** 이 라운드의 이슈 수 = still + added + reopened */
  issues: number;
  /** 앞 라운드에도 이슈였고 지금도 이슈 */
  still: number;
  /** 지금 처음 이슈가 됨(앞 라운드들에서 한 번도 이슈가 아니었음) */
  added: number;
  /** 앞 라운드에서는 이슈가 아니었는데, 그 전에 이슈였던 적이 있음(고쳐졌다가 다시 깨짐) */
  reopened: number;
  /** 앞 라운드에서 이슈였고 지금 통과 */
  fixed: number;
}

export type HistoryNow = "open" | "fixed" | "other";
export interface IssueHistory {
  id: string;
  title: string;
  /** 라운드별 상태. 그 라운드에서 돌리지 않았으면 status 가 없다 */
  cells: { round: string; status?: Verdict; issue: boolean }[];
  /** 처음 이슈가 된 라운드 */
  first: string;
  /** 이슈였던 라운드 수 */
  times: number;
  /** 마지막으로 돌린 라운드 기준: 아직 이슈 / 고쳐짐(통과) / 그 밖(스킵·해당 없음) */
  now: HistoryNow;
  /** 고쳐짐이면 고쳐진 라운드(이슈 → 통과로 바뀐 마지막 라운드) */
  fixedIn?: string;
}

export interface IssueFlow {
  rounds: RoundFlow[];
  issues: IssueHistory[];
}

const cache = new Map<string, IssueFlow>();

/**
 * 라운드별 이슈 흐름과 이슈별 이력. 이슈의 정의는 이슈 수 추이와 같다(실패 + 불안정 + 검증 못 한 것, 스킵 제외).
 * upTo 를 주면 그 라운드까지만 본다(그 라운드의 결과는 upToResults 로 줄 수 있다).
 */
export function issueFlow(project: Project, upTo?: RoundMeta, upToResults?: CaseResult[]): IssueFlow {
  const cfg = project.config();
  const metas = project.rounds().filter((r) => (r.status !== "running" || r.id === upTo?.id) && (!upTo || r.n <= upTo.n));
  // 현황판은 1초 남짓마다 묻는다 — 라운드 결과 파일이 그대로면 다시 읽지 않는다
  const key = upToResults ? "" : project.root + "|" + cfg.acceptedSkips.join(",") + "|" + metas.map((m) => `${m.id}:${m.status}:${m.scope}:${mtime(project.p("rounds", m.id, "results.json"))}`).join(",");
  if (key && cache.has(key)) return cache.get(key)!;
  const results = new Map<string, CaseResult[]>(metas.map((m) => [m.id, m.id === upTo?.id && upToResults ? upToResults : project.readJson<CaseResult[]>(`rounds/${m.id}/results.json`, [])]));
  const issueSet = (id: string) => new Set(results.get(id)!.filter((r) => isIssue(r, cfg)).map((r) => r.id));
  const sets = new Map(metas.map((m) => [m.id, issueSet(m.id)]));
  const rounds: RoundFlow[] = metas.map((m, i) => {
    const now = sets.get(m.id)!;
    // 이전 라운드 비교(diffWithPrevious)와 같은 규칙: 끝까지 돈 라운드만, 전체 라운드는 앞 전체 라운드와
    const prev = metas.slice(0, i).reverse().find((p) => p.status === "finished" && (m.scope !== "full" || p.scope === "full"));
    const before = prev ? sets.get(prev.id)! : new Set<string>();
    const earlier = new Set(metas.slice(0, i).flatMap((p) => [...sets.get(p.id)!]));
    const status = new Map(results.get(m.id)!.map((r) => [r.id, r.status]));
    let still = 0, added = 0, reopened = 0, fixed = 0;
    for (const id of now) {
      if (before.has(id)) still++;
      else if (earlier.has(id)) reopened++;
      else added++;
    }
    for (const id of before) if (status.get(id) === "PASS") fixed++;
    return { round: m.id, scope: m.scope, status: m.status, prev: prev?.id, issues: now.size, still, added, reopened, fixed };
  });
  const ids = [...new Set(metas.flatMap((m) => [...sets.get(m.id)!]))];
  const issues: IssueHistory[] = ids.map((id) => {
    const cells = metas.map((m) => {
      const r = results.get(m.id)!.find((x) => x.id === id);
      return { round: m.id, status: r?.status, issue: !!r && isIssue(r, cfg) };
    });
    const ran = cells.filter((c) => c.status);
    const last = ran.at(-1)!;
    const now: HistoryNow = last.issue ? "open" : last.status === "PASS" ? "fixed" : "other";
    let fixedIn: string | undefined;
    if (now === "fixed") for (let i = 1; i < ran.length; i++) if (ran[i - 1]!.issue && ran[i]!.status === "PASS") fixedIn = ran[i]!.round;
    const title = [...metas].reverse().map((m) => results.get(m.id)!.find((x) => x.id === id)?.title).find(Boolean) ?? id;
    return { id, title, cells, first: cells.find((c) => c.issue)!.round, times: cells.filter((c) => c.issue).length, now, fixedIn };
  });
  const rank: Record<HistoryNow, number> = { open: 0, other: 1, fixed: 2 };
  issues.sort((a, b) => rank[a.now] - rank[b.now] || roundNo(a.first) - roundNo(b.first) || a.id.localeCompare(b.id));
  const out = { rounds, issues };
  if (key) {
    if (cache.size > 20) cache.clear();
    cache.set(key, out);
  }
  return out;
}

const roundNo = (id: string) => Number(id.replace(/^R/, "")) || 0;
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);

/** 그래프·이력 표의 색과 모양. 보고서와 현황판이 같이 쓴다(밝은·어두운 화면 모두) */
export const FLOW_CSS = `
.fmeta{color:var(--mut);font-size:12px}.flow{overflow-x:auto;margin:8px 0}.flow svg{display:block}.flow text{fill:var(--mut);font-size:11px;font-family:inherit}.flow text.n{fill:var(--fg);font-weight:700}
.flow .ax{stroke:var(--line);stroke-width:1}.f-still{fill:#c0392b}.f-added{fill:#e67e22}.f-reopened{fill:#8e44ad}.f-fixed{fill:#1a7f4b}.flow .partial{opacity:.5}
.lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--mut);margin:2px 0 6px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.lg .f-still{background:#c0392b}.lg .f-added{background:#e67e22}.lg .f-reopened{background:#8e44ad}.lg .f-fixed{background:#1a7f4b}
.hist{overflow-x:auto}.hist table{border-collapse:collapse;font-size:12px}.hist td,.hist th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;white-space:nowrap}.hist td.t{white-space:normal;min-width:160px}
.hist .c{text-align:center;padding:3px 2px}.hist .c span{display:inline-block;min-width:20px;border-radius:3px;font-weight:700;font-size:11px;padding:0 3px}
.hc-FAIL{background:#c0392b;color:#fff}.hc-FLAKY{background:#9a6a12;color:#fff}.hc-BLOCKED{background:#475569;color:#fff}.hc-PASS{background:#1a7f4b;color:#fff}.hc-SKIP,.hc-NA{background:var(--line);color:var(--fg)}.hc-none{color:var(--mut)}
.hn-open{color:#c0392b;font-weight:700}.hn-fixed{color:#1a7f4b;font-weight:700}.hn-other{color:var(--mut)}
`;

const legend = () =>
  tx(
    `<div class="lg"><span><i class="f-still"></i>계속 남음</span><span><i class="f-added"></i>새로 생김</span><span><i class="f-reopened"></i>다시 생김(고쳐졌다가 다시 깨짐)</span><span><i class="f-fixed"></i>고쳐짐(축 아래)</span><span>흐린 막대 = 부분 라운드</span></div>`,
    `<div class="lg"><span><i class="f-still"></i>still open</span><span><i class="f-added"></i>new</span><span><i class="f-reopened"></i>reopened (fixed, then broken again)</span><span><i class="f-fixed"></i>fixed (below the axis)</span><span>faded bar = partial round</span></div>`,
  );

/** 라운드별 이슈 흐름 막대그래프(SVG). 축 위는 이 라운드의 이슈(계속 남음·다시 생김·새로 생김), 축 아래는 이 라운드에 고쳐진 이슈 */
export function flowChartSvg(rounds: RoundFlow[]): string {
  if (!rounds.length) return `<p class="fmeta">${tx("아직 끝난 라운드가 없습니다", "No round has finished yet")}</p>`;
  const slot = 46, bw = 26, left = 8, top = 18, H = 150;
  const up = Math.max(1, ...rounds.map((r) => r.issues));
  const down = Math.max(0, ...rounds.map((r) => r.fixed));
  const unit = H / (up + down || 1);
  const y0 = top + up * unit;
  const bottom = y0 + down * unit + (down ? 14 : 0);
  const width = left * 2 + rounds.length * slot;
  const height = bottom + 30;
  const bars = rounds
    .map((r, i) => {
      const x = left + i * slot + (slot - bw) / 2;
      const cx = x + bw / 2;
      let y = y0;
      const seg = (n: number, cls: string) => {
        if (!n) return "";
        const h = n * unit;
        y -= h;
        return `<rect class="${cls}" x="${x}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="2"/>`;
      };
      const stack = seg(r.still, "f-still") + seg(r.reopened, "f-reopened") + seg(r.added, "f-added");
      const fixedH = r.fixed * unit;
      const fixed = r.fixed ? `<rect class="f-fixed" x="${x}" y="${y0.toFixed(1)}" width="${bw}" height="${fixedH.toFixed(1)}" rx="2"/><text x="${cx}" y="${(y0 + fixedH + 11).toFixed(1)}" text-anchor="middle">✓${r.fixed}</text>` : "";
      const tip = tx(
        `${r.round}${r.scope === "partial" ? " (부분 라운드)" : ""}${r.status === "aborted" ? " (중단됨)" : ""} — 이슈 ${r.issues}건: 계속 남음 ${r.still} · 새로 생김 ${r.added} · 다시 생김 ${r.reopened} / 고쳐짐 ${r.fixed}${r.prev ? ` (${r.prev} 와 비교)` : " (비교할 앞 라운드 없음)"}`,
        `${r.round}${r.scope === "partial" ? " (partial round)" : ""}${r.status === "aborted" ? " (aborted)" : ""} — issues: ${r.issues} (still open ${r.still} · new ${r.added} · reopened ${r.reopened}) / fixed ${r.fixed}${r.prev ? ` (compared with ${r.prev})` : " (no earlier round to compare)"}`,
      );
      return `<g${r.scope === "partial" ? ' class="partial"' : ""}><title>${esc(tip)}</title>${stack}${fixed}<text class="n" x="${cx}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${r.issues}</text><text x="${cx}" y="${(height - 14).toFixed(1)}" text-anchor="middle">${esc(r.round)}</text>${r.scope === "partial" ? `<text x="${cx}" y="${(height - 2).toFixed(1)}" text-anchor="middle">${tx("부분", "partial")}</text>` : r.status === "aborted" ? `<text x="${cx}" y="${(height - 2).toFixed(1)}" text-anchor="middle">${tx("중단", "aborted")}</text>` : ""}</g>`;
    })
    .join("");
  return `<div class="flow"><svg role="img" aria-label="${tx("라운드별 이슈 흐름", "Issue flow per round")}" width="${width}" height="${height.toFixed(0)}" viewBox="0 0 ${width} ${height.toFixed(0)}"><line class="ax" x1="${left}" x2="${width - left}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"/>${bars}</svg></div>${legend()}`;
}

/** 판정 이름(실패 · 통과 …) */
export const STATUS_LABEL: Record<string, string> = langTable({
  ko: { FAIL: "실패", FLAKY: "불안정", BLOCKED: "검증 못 함", PASS: "통과", SKIP: "스킵", NA: "해당 없음" },
  en: { FAIL: "failed", FLAKY: "flaky", BLOCKED: "unverified", PASS: "passed", SKIP: "skipped", NA: "not applicable" },
});
const STATUS_MARK: Record<string, string> = langTable({
  ko: { FAIL: "실패", FLAKY: "불안", BLOCKED: "검증X", PASS: "✓", SKIP: "스킵", NA: "N/A" },
  en: { FAIL: "FAIL", FLAKY: "FLAKY", BLOCKED: "BLOCKED", PASS: "✓", SKIP: "SKIP", NA: "N/A" },
});
/** 이슈의 지금 상태 이름(남음 · 고쳐짐 · 판정 안 됨) */
export const NOW_LABEL: Record<HistoryNow, string> = langTable({
  ko: { open: "남음", fixed: "고쳐짐", other: "판정 안 됨" },
  en: { open: "open", fixed: "fixed", other: "not judged" },
});

/** 이슈 목록(라운드별 이력). 이슈였던 적이 있는 케이스마다 라운드별 상태 칸을 붙인다. 열은 최근 maxRounds 라운드까지 */
export function issueHistoryHtml(flow: IssueFlow, maxRounds = 12): string {
  if (!flow.issues.length) return `<p class="fmeta">${tx("이슈였던 케이스가 없습니다", "No case has been an issue")}</p>`;
  const shown = flow.rounds.slice(-maxRounds).map((r) => r.round);
  const cut = flow.rounds.length - shown.length;
  const open = flow.issues.filter((i) => i.now === "open").length;
  const fixed = flow.issues.filter((i) => i.now === "fixed").length;
  const head = `<tr>${tx("<th>케이스</th><th>지금</th><th>처음</th><th>고쳐진 라운드</th><th>이슈 횟수</th>", "<th>Case</th><th>Now</th><th>First</th><th>Fixed in</th><th>Times an issue</th>")}${shown.map((r) => `<th class="c">${esc(r)}</th>`).join("")}</tr>`;
  const rows = flow.issues
    .map((i) => {
      const cells = i.cells.filter((c) => shown.includes(c.round));
      return `<tr><td class="t"><b>${esc(i.title)}</b><br><span class="fmeta">${esc(i.id)}</span></td><td class="hn-${i.now}">${NOW_LABEL[i.now]}</td><td>${esc(i.first)}</td><td>${esc(i.fixedIn ?? "-")}</td><td>${i.times}</td>${cells.map((c) => `<td class="c">${c.status ? `<span class="hc-${c.status}" title="${esc(`${c.round}: ${STATUS_LABEL[c.status] ?? c.status}`)}">${STATUS_MARK[c.status] ?? esc(c.status)}</span>` : `<span class="hc-none" title="${esc(`${c.round}: ${tx("돌리지 않음", "not run")}`)}">–</span>`}</td>`).join("")}</tr>`;
    })
    .join("");
  const lead = tx(
    `이슈였던 케이스 ${flow.issues.length}건 — 남음 ${open} · 고쳐짐 ${fixed} · 판정 안 됨 ${flow.issues.length - open - fixed}${cut ? ` · 앞 ${cut}개 라운드는 열에서 생략` : ""}. 칸: 실패 · 불안(불안정) · 검증X(검증 못 함) · ✓(통과) · 스킵 · N/A(해당 없음) · –(그 라운드에서 돌리지 않음)`,
    `Cases that have been an issue: ${flow.issues.length} — open ${open} · fixed ${fixed} · not judged ${flow.issues.length - open - fixed}${cut ? ` · the first ${cut} rounds are left out of the columns` : ""}. Cells: FAIL (failed) · FLAKY (flaky) · BLOCKED (unverified) · ✓ (passed) · SKIP (skipped) · N/A (not applicable) · – (not run in that round)`,
  );
  return `<p class="fmeta">${lead}</p><div class="hist"><table>${head}${rows}</table></div>`;
}
