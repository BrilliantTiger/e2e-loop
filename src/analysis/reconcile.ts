// 코드 분석 결과를 사이트 전수 탐색 결과와 맞춰 본다: 코드에는 있는데 탐색으로 못 닿은 것을 찾는다.
import type { Inventory, InvElement } from "../types.ts";
import type { CodeAnalysis, CodeApi, CodeEvent, CodeRoute } from "./code.ts";
import { routeRegex } from "./code.ts";

export interface RouteStatus {
  route: CodeRoute;
  /** link=링크로 닿음, code-only=코드 분석으로 알게 되어 직접 열어서 확인함(링크로는 못 닿음), unreached=열어 보지 못함, dynamic=:id 같은 값이 필요해 열 수 없음, not-crawled=아직 탐색 전 */
  status: "link" | "code-only" | "unreached" | "dynamic" | "not-crawled";
}

export interface Reconciled {
  routes: RouteStatus[];
  /** 코드에는 있고 화면에서 맞는 요소를 못 찾은 이벤트(단서가 있는 것만) */
  eventsNotOnScreen: CodeEvent[];
  /** 화면 요소와 맞춰 볼 단서가 없어 대조하지 못한 이벤트 수 */
  eventsUnmatchable: number;
  /** 코드에서 부르는데 탐색 중 브라우저에서 보이지 않은 API */
  apisNotObserved: CodeApi[];
  summary: { codeRoutes: number; link: number; codeOnly: number; unreached: number; dynamic: number };
}

const pathOnly = (u: string) => u.split("?")[0]!.replace(/\/$/, "") || "/";

export function matchesElement(h: CodeEvent["hints"], els: InvElement[]): boolean {
  const low = (s?: string) => (s ?? "").trim().toLowerCase();
  return els.some((e) => {
    if (h.id && (e.selector.includes(`#${h.id}`) || e.selector.includes(`[id="${h.id}"]`) || e.formKey === h.id)) return true;
    if (h.testid && e.selector.includes(h.testid)) return true;
    if (h.name && e.selector.includes(`[name="${h.name}"]`)) return true;
    if (h.ariaLabel && low(e.label) === low(h.ariaLabel)) return true;
    if (h.text && low(e.label) === low(h.text)) return true;
    return false;
  });
}

export function reconcile(analyses: CodeAnalysis[], inv: Inventory | null): Reconciled {
  const routes: RouteStatus[] = [];
  const seen = new Set<string>();
  for (const a of analyses) for (const r of a.routes) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    if (!inv) {
      routes.push({ route: r, status: r.dynamic ? "dynamic" : "not-crawled" });
      continue;
    }
    const re = routeRegex(r.path);
    const hit = inv.pages.filter((p) => re.test(pathOnly(p.path)) || re.test(pathOnly(p.path).replace(/\.html?$/, "")));
    if (hit.length) routes.push({ route: r, status: hit.some((p) => (p.via ?? "link") === "link") ? "link" : "code-only" });
    else routes.push({ route: r, status: r.dynamic ? "dynamic" : "unreached" });
  }

  const els = inv?.elements ?? [];
  const routeOpened = new Map(routes.map((x) => [x.route.path, x.status]));
  const eventsNotOnScreen: CodeEvent[] = [];
  let unmatchable = 0;
  for (const a of analyses) for (const ev of a.events) {
    const h = ev.hints;
    if (!(h.id || h.testid || h.name || h.ariaLabel || h.text)) {
      unmatchable++;
      continue;
    }
    // 화면을 못 연 라우트의 이벤트는 화면 단위로 이미 "못 닿음"으로 보고되므로 중복해서 세지 않는다
    if (ev.route && ["unreached", "dynamic", "not-crawled"].includes(routeOpened.get(ev.route) ?? "")) continue;
    if (inv && !matchesElement(h, els)) eventsNotOnScreen.push(ev);
  }

  const observed = inv?.apis ?? [];
  const apisNotObserved: CodeApi[] = [];
  const seenApi = new Set<string>();
  for (const a of analyses) for (const api of a.apis) {
    if (api.defined) continue;
    const k = `${api.method} ${pathOnly(api.url)}`;
    if (seenApi.has(k)) continue;
    seenApi.add(k);
    const re = routeRegex(pathOnly(api.url).replace(/:param/g, ":p"));
    if (!observed.some((o) => o.method === api.method && re.test(o.path))) apisNotObserved.push(api);
  }

  const count = (s: RouteStatus["status"]) => routes.filter((r) => r.status === s).length;
  return {
    routes, eventsNotOnScreen, eventsUnmatchable: unmatchable, apisNotObserved,
    summary: { codeRoutes: routes.length, link: count("link"), codeOnly: count("code-only"), unreached: count("unreached"), dynamic: count("dynamic") },
  };
}
