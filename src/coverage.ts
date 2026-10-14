import { Project } from "./store.ts";

export interface Coverage {
  elements: { total: number; coveredBySpec: number; coveredByProbe: number; uncovered: number; uncoveredList: { id: string; page: string; kind: string; label: string; selector: string; risk: string }[] };
  sources: { id: string; title: string; kind: string; sections: { name: string; cases: number }[]; uncoveredSections: string[] }[];
  cases: { total: number; spec: number; probe: number; blocked: number; na: number; withoutSourceRef: string[] };
  notes: string[];
}

export function coverage(project: Project): Coverage {
  const inv = project.inventory();
  const cases = project.cases();
  const cfg = project.config();
  const spec = cases.filter((c) => c.type === "spec" && (c.status ?? "active") === "active");
  const probe = cases.filter((c) => c.type === "probe" && (c.status ?? "active") === "active");
  const specSel = new Set<string>();
  const specEl = new Set<string>();
  for (const c of spec) {
    if (c.element) specEl.add(c.element);
    for (const s of c.steps) if (typeof s.sel === "string") specSel.add(s.sel);
  }
  const probeEl = new Set(probe.map((c) => c.element).filter(Boolean) as string[]);
  const els = inv?.elements ?? [];
  const bySpec = els.filter((e) => specEl.has(e.id) || specSel.has(e.selector));
  const byProbe = els.filter((e) => probeEl.has(e.id) && cfg.probes === "auto");
  const covered = new Set([...bySpec, ...byProbe].map((e) => e.id));
  // 모든 화면에 똑같이 있는 메뉴·푸터 요소는 한 곳에서만 점검하므로, 같은 요소가 점검됐으면 덮인 것으로 센다
  const keyOf = (e: (typeof els)[number]) => `${e.layer}|${e.kind}|${e.selector}|${e.href ?? ""}|${e.label}`;
  const coveredKeys = new Set(els.filter((e) => covered.has(e.id)).map(keyOf));
  const uncovered = els.filter((e) => !covered.has(e.id) && !coveredKeys.has(keyOf(e)) && !e.disabled);
  const notes: string[] = [];
  if (!inv) notes.push("인벤토리가 없음 — 개발된 사이트가 있으면 e2e_discover 로 모든 요소를 수집하세요.");
  if (cfg.probes === "off") notes.push("자동 점검(probes)이 꺼져 있어 spec 케이스만 실행됩니다.");
  const sources = project.sources().map((s) => {
    const sections = (s.sections ?? []).map((name) => ({ name, cases: spec.filter((c) => (c.source_ref ?? "").includes(name)).length }));
    return { id: s.id, title: s.title, kind: s.kind, sections, uncoveredSections: sections.filter((x) => x.cases === 0).map((x) => x.name) };
  });
  for (const s of sources) if (s.kind !== "live-site" && s.kind !== "code" && s.sections.length === 0) notes.push(`근거 “${s.title}” 에 sections 가 없어 절 단위 커버리지를 못 셉니다. e2e_source_add 에 sections 를 넣으세요.`);
  if (sources.some((s) => s.kind !== "live-site" && s.kind !== "code") && !spec.length) notes.push("기획서/디자인/기능정의서가 등록돼 있는데 spec 케이스가 0건입니다. 문서의 기대 동작을 e2e_case_upsert 로 옮기세요.");
  return {
    elements: { total: els.length, coveredBySpec: bySpec.length, coveredByProbe: byProbe.length, uncovered: uncovered.length, uncoveredList: uncovered.slice(0, 60).map((e) => ({ id: e.id, page: e.page, kind: e.kind, label: e.label, selector: e.selector, risk: e.risk })) },
    sources,
    cases: {
      total: cases.length, spec: spec.length, probe: probe.length,
      blocked: cases.filter((c) => c.status === "blocked").length, na: cases.filter((c) => c.status === "na").length,
      withoutSourceRef: spec.filter((c) => !c.source_ref).map((c) => c.id),
    },
    notes,
  };
}
