// 라이브 사이트를 돌며 클릭·입력·선택·토글·모달 등 모든 이벤트 후보를 모으고, 자동 점검 케이스를 만든다.
import { createHash } from "node:crypto";
import type { Case, Config, InvElement, Inventory, Risk, Step } from "./types.ts";
import type { DPage } from "./drivers/index.ts";
import { resolveDriver } from "./drivers/index.ts";
import { inventoryExpr } from "./drivers/inpage.ts";
import { Project, nowIso } from "./store.ts";
import { closeModal, observe, sleep } from "./probes.ts";

const h6 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 6);

function riskOf(cfg: Config, e: { label: string; href?: string; submit?: boolean; kind: string }): Risk {
  const re = new RegExp(cfg.destructivePattern, "i");
  if (re.test(e.label) || (e.href && re.test(e.href))) return "destructive";
  if (e.submit) return "mutating";
  return "safe";
}

function normalizePath(u: URL) {
  return u.pathname.replace(/\/$/, "") || "/";
}

export async function discover(
  project: Project,
  opts: { seeds?: string[]; maxPages?: number; reveal?: boolean; driver?: any; onProgress?: (m: string) => void } = {},
): Promise<Inventory> {
  const cfg = project.config();
  const base = new URL(cfg.baseUrl);
  const driver = await resolveDriver({ ...cfg, headless: cfg.headless }, opts.driver);
  await driver.open();
  const session = await driver.newSession(project.p("discover-tmp"));
  const page = session.page;
  const log = opts.onProgress ?? (() => {});
  const ignore = cfg.crawl.ignore.map((r) => new RegExp(r, "i"));
  const maxPages = opts.maxPages ?? cfg.crawl.maxPages;
  const doReveal = opts.reveal ?? cfg.crawl.reveal;
  const inv: Inventory = { generatedAt: nowIso(), baseUrl: cfg.baseUrl, pages: [], elements: [], skipped: [] };
  const seenPages = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: cfg.baseUrl, depth: 0 }, ...[...cfg.crawl.seeds, ...(opts.seeds ?? [])].map((s) => ({ url: new URL(s, base).toString(), depth: 0 }))];

  const collect = async (path: string, layer: string, scope: string | null) => {
    const r = await page.evaluate<{ elements: any[]; links: string[]; forms: number; title: string }>(inventoryExpr(scope));
    const out: InvElement[] = r.elements.map((e) => {
      const risk = riskOf(cfg, e);
      return { ...e, id: "E-" + h6(`${path}|${layer}|${e.selector}|${e.kind}`), page: path, layer, risk, attrs: Object.fromEntries(Object.entries(e.attrs ?? {}).filter(([, v]) => v)) } as InvElement;
    });
    return { out, links: r.links, forms: r.forms, title: r.title };
  };

  try {
    while (queue.length && inv.pages.length < maxPages) {
      const { url, depth } = queue.shift()!;
      const u = new URL(url);
      if (u.origin !== base.origin) continue;
      const key = normalizePath(u) + (u.search || "");
      if (seenPages.has(key)) continue;
      seenPages.add(key);
      if (ignore.some((re) => re.test(u.pathname + u.search))) {
        inv.skipped.push({ url, reason: "ignore 패턴" });
        continue;
      }
      log(`방문 ${key}`);
      try {
        await page.goto(url);
        await sleep(300);
      } catch (e: any) {
        inv.pages.push({ path: key, title: "", elements: 0, forms: 0, depth, error: String(e.message).slice(0, 200) });
        continue;
      }
      const landed = new URL(await page.url());
      const path = normalizePath(landed) + (landed.search || "");
      if (landed.origin !== base.origin) {
        inv.skipped.push({ url, reason: "다른 도메인으로 이동" });
        continue;
      }
      const first = await collect(path, "page", null);
      inv.pages.push({ path, title: first.title, elements: first.out.length, forms: first.forms, depth });
      inv.elements.push(...first.out);

      // 링크 큐
      for (const href of first.links) {
        try {
          const lu = new URL(href);
          if (lu.origin === base.origin && depth + 1 <= cfg.crawl.maxDepth) queue.push({ url: lu.origin + lu.pathname + lu.search, depth: depth + 1 });
        } catch {}
      }

      // 모달/패널 드러내기: 안전한 버튼만 눌러 본다
      if (doReveal) {
        const triggers = first.out.filter((e) => ["button", "tab", "summary"].includes(e.kind) && e.risk === "safe" && !e.disabled && !(e as any).submit).slice(0, cfg.crawl.maxRevealPerPage);
        for (const t of triggers) {
          try {
            await page.goto(url);
            const before = await observe(page);
            await page.click(t.selector);
            await sleep(500);
            const after = await observe(page);
            if (after.dialogs.length > before.dialogs.length) {
              t.opensModal = true;
              const scope = '[role=dialog], dialog[open], [aria-modal=true], .modal.show';
              const inner = await collect(path, `modal:${t.id}`, scope);
              const mine = inner.out.filter((e) => !first.out.some((o) => o.selector === e.selector));
              inv.elements.push(...mine);
              log(`  모달 발견: ${t.label} (요소 ${mine.length})`);
              await closeModal(page);
            }
          } catch {
            /* 눌러볼 수 없는 버튼은 건너뜀 */
          }
        }
      }
    }
  } finally {
    await session.finish(true).catch(() => {});
    await driver.close();
  }
  // 중복 제거(같은 id)
  const seen = new Set<string>();
  inv.elements = inv.elements.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  project.writeJson("inventory.json", inv);
  return inv;
}

/** 인벤토리 → 자동 점검 케이스. 같은 id 는 덮어쓴다(사람이 만든 spec 케이스는 건드리지 않는다). */
export function probeCases(cfg: Config, inv: Inventory): Case[] {
  const byId = new Map(inv.elements.map((e) => [e.id, e]));
  const cases: Case[] = [];
  const forms = new Map<string, InvElement[]>();
  for (const e of inv.elements) if (e.formKey) forms.set(`${e.page}|${e.layer}|${e.formKey}`, [...(forms.get(`${e.page}|${e.layer}|${e.formKey}`) ?? []), e]);

  const pre = (e: InvElement): Step[] => {
    const s: Step[] = [{ op: "goto", url: e.page }];
    if (e.layer.startsWith("modal:")) {
      const trig = byId.get(e.layer.slice(6));
      if (trig) s.push({ op: "click", sel: trig.selector }, { op: "wait", sel: "[role=dialog], dialog[open], [aria-modal=true], .modal.show", state: "visible", timeout: 4000 });
    }
    return s;
  };

  // 모든 페이지에 똑같이 있는 메뉴·푸터 요소는 한 번만 점검한다(같은 결함이 페이지 수만큼 부풀지 않게)
  const seenShared = new Map<string, number>();
  for (const e of inv.elements) {
    if (e.disabled) continue;
    const dup = `${e.layer}|${e.kind}|${e.selector}|${e.href ?? ""}|${e.label}`;
    if (e.layer === "page" && seenShared.has(dup)) {
      seenShared.set(dup, seenShared.get(dup)! + 1);
      continue;
    }
    seenShared.set(dup, 1);
    const base = { type: "probe" as const, element: e.id, area: e.page + (e.layer === "page" ? "" : ` · ${e.layer}`), risk: e.risk };
    const label = e.label.slice(0, 40);
    const common = { sel: e.selector, label: e.label, inputType: e.inputType, attrs: e.attrs, options: e.options, href: e.href, newTab: (e as any).newTab };
    let kind: string | null = null;
    let title = "";
    if (e.kind === "link") {
      if (e.external) {
        kind = "nav";
        title = `링크(외부) “${label}”`;
        (common as any).newTab = true;
      } else {
        kind = "nav";
        title = `링크 “${label}” → ${e.href}`;
      }
    } else if (e.kind === "button") {
      if ((e as any).submit && e.formKey) continue; // 폼 점검에서 다룬다
      kind = "click";
      title = `버튼 “${label}” 클릭`;
    } else if (e.kind === "tab") { kind = "tab"; title = `탭 “${label}” 전환`; }
    else if (e.kind === "summary") { kind = "summary"; title = `펼침 “${label}”`; }
    else if (e.kind === "input") { kind = "input"; title = `입력 “${label}”(${e.inputType ?? "text"})`; }
    else if (e.kind === "select") { kind = "select"; title = `선택 “${label}”`; }
    else if (e.kind === "toggle") { kind = "toggle"; title = `토글 “${label}”`; }
    else continue;
    cases.push({
      ...base,
      id: `P-${e.id.slice(2)}`,
      title,
      event: kind,
      steps: [...pre(e), { op: "probe", kind, ...common }],
    });
  }

  for (const c of cases) {
    const e = c.element ? byId.get(c.element) : undefined;
    if (!e) continue;
    const n = seenShared.get(`${e.layer}|${e.kind}|${e.selector}|${e.href ?? ""}|${e.label}`) ?? 1;
    if (n > 1) c.area = `${c.area} (+같은 요소가 ${n - 1}개 페이지에 더 있음)`;
  }

  // 폼 점검: 빈 제출, 유효 제출
  for (const [key, els] of forms) {
    const submit = els.find((e) => (e as any).submit);
    if (!submit) continue;
    const fields = els.filter((e) => ["input", "select", "toggle"].includes(e.kind) && !e.disabled);
    const required = fields.some((f) => f.required);
    const first = els[0]!;
    const fid = "F-" + h6(key);
    const pf = pre(first);
    if (required)
      cases.push({ id: fid + "-empty", type: "probe", event: "form-empty", element: submit.id, area: first.page, risk: "safe", title: `폼 “${submit.label}” 필수값 비우고 제출 → 검증`, steps: [...pf, { op: "probe", kind: "form-empty", sel: submit.selector, label: submit.label }] });
    cases.push({
      id: fid + "-valid", type: "probe", event: "form-valid", element: submit.id, area: first.page,
      risk: riskOf(cfg, submit) === "destructive" ? "destructive" : "mutating",
      title: `폼 “${submit.label}” 유효한 값으로 제출`,
      steps: [...pf, { op: "probe", kind: "form-valid", sel: submit.selector, label: submit.label, fields: fields.map((f) => ({ sel: f.selector, kind: f.kind, inputType: f.inputType, label: f.label, options: f.options })) }],
    });
  }
  return cases;
}

/** 기존 케이스와 합친다: probe 는 새 인벤토리 기준으로 교체, spec 은 그대로 둔다. */
export function mergeProbeCases(existing: Case[], probes: Case[]): { cases: Case[]; added: number; removed: number; kept: number } {
  const keep = existing.filter((c) => c.type === "spec");
  const old = new Map(existing.filter((c) => c.type === "probe").map((c) => [c.id, c]));
  let added = 0;
  const next = probes.map((p) => {
    const prev = old.get(p.id);
    if (!prev) added++;
    // 사람이 blocked/na 로 바꾼 상태는 유지
    return prev && prev.status && prev.status !== "active" ? { ...p, status: prev.status, reason: prev.reason } : p;
  });
  const removed = [...old.keys()].filter((id) => !probes.some((p) => p.id === id)).length;
  return { cases: [...keep, ...next], added, removed, kept: keep.length };
}
