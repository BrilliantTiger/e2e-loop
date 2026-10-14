// 사이트 탐색·코드 분석·API 관측에서 자동 점검 케이스(probe)를 만들고 저장한다.
import { createHash } from "node:crypto";
import type { Case, Config, Inventory } from "../types.ts";
import { Project } from "../store.ts";
import { mergeProbeCases, probeCases } from "../discover.ts";
import { loadAnalyses } from "./store.ts";
import type { CodeAnalysis } from "./code.ts";
import { reconcile } from "./reconcile.ts";
import { applyOsPolicy } from "./os.ts";

const h6 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 6);
const pathOnly = (u: string) => u.split("?")[0]!;

const sameOriginUrl = (url: string, baseUrl: string): string | null => {
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    return u.origin === new URL(baseUrl).origin ? u.pathname + u.search : null;
  } catch {
    return null;
  }
};

/** 탐색 결과(API 관측·직접 열어 본 화면)와 코드 분석(부르는 API)에서 만드는 케이스 */
export function extraCases(cfg: Config, inv: Inventory | null, analyses: CodeAnalysis[]): Case[] {
  const out: Case[] = [];
  const recon = reconcile(analyses, inv);
  const codeLoc = (path: string) => {
    const r = analyses.flatMap((a) => a.routes).find((x) => x.path === path);
    return r ? `코드 ${r.file}:${r.line}` : undefined;
  };

  // 1) 링크로는 닿지 않은 화면(코드·시작 주소로 연 화면): 열리는지
  for (const p of inv?.pages ?? []) {
    if ((p.via ?? "link") === "link") continue;
    const path = p.path.split("?")[0]!;
    out.push({
      id: `PG-${h6(p.path)}`, type: "probe", event: "page", screen: path, feature: "화면 열림", area: path, risk: "safe",
      title: `화면 열림 ${p.path}${p.via === "code" ? " (코드에는 있으나 링크로는 닿지 않음)" : ""}`,
      source_ref: p.via === "code" ? codeLoc(path) : undefined,
      steps: [{ op: "goto", url: p.path }, { op: "probe", kind: "page", label: p.path }],
    });
  }

  // 2) 탐색 중 브라우저가 보낸 API: 읽기(GET)만 다시 불러 상태코드·응답 모양을 확인
  const seen = new Set<string>();
  for (const a of inv?.apis ?? []) {
    if (!a.sameOrigin || a.status >= 400 || a.method !== "GET") continue;
    const k = `${a.method} ${a.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: `A-${h6(k)}`, type: "probe", event: "api", screen: a.page, feature: "API 호출", area: a.page, risk: "safe",
      title: `API GET ${a.path} → ${a.status < 300 ? "2xx" : a.status}${a.jsonKeys?.length ? ` · 응답 키 ${a.jsonKeys.slice(0, 4).join(",")}` : a.jsonArray ? " · 배열 응답" : ""}`,
      source_ref: `사이트 관측 ${a.page}`,
      steps: [
        { op: "goto", url: a.page },
        { op: "api", via: "page", method: "GET", url: a.sample, status: a.status < 300 ? "2xx" : a.status, ...(a.jsonKeys?.length ? { jsonHas: a.jsonKeys.slice(0, 10) } : {}), ...(a.jsonArray ? { jsonArray: true } : {}) },
      ],
    });
  }

  // 3) 코드가 부르는데 탐색 중 보이지 않은 읽기(GET) API
  for (const api of recon.apisNotObserved) {
    if (api.method !== "GET" || api.dynamic) continue;
    const rel = sameOriginUrl(api.url, cfg.baseUrl);
    if (!rel) continue;
    const k = `${api.method} ${pathOnly(rel)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: `CA-${h6(k)}`, type: "probe", event: "api", screen: "(API)", feature: "API 호출", area: "(API)", risk: "safe", tags: ["code-api"],
      title: `API GET ${pathOnly(rel)} (코드에서 호출) → 400 미만`,
      source_ref: `코드 ${api.file}:${api.line}`,
      steps: [{ op: "goto", url: "/" }, { op: "api", via: "page", method: "GET", url: rel, status: "<400" }],
    });
  }
  return out;
}

/** 현재 인벤토리·코드 분석으로 자동 점검 케이스를 다시 만든다(spec 케이스는 그대로 둔다). */
export function regenerateProbes(project: Project) {
  const cfg = project.config();
  const inv = project.inventory();
  const analyses = loadAnalyses(project);
  const probes: Case[] = cfg.probes === "off" ? [] : [...(inv ? probeCases(cfg, inv) : []), ...extraCases(cfg, inv, analyses)];
  const seen = new Set<string>();
  const unique = probes.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const merged = mergeProbeCases(project.cases(), unique);
  project.saveCases(merged.cases);
  const os = applyOsPolicy(project);
  return { ...merged, total: unique.length, os };
}
