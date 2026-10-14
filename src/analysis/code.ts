// 코드 분석: 소스에서 화면(라우트)·이벤트·API 호출·다운로드/업로드 후보를 뽑는다.
// 프레임워크마다 추출기를 따로 두어 늘릴 수 있게 했다(ROUTE_EXTRACTORS 에 추가).
// 정규식 기반의 근사 분석이라 "후보"를 뽑을 뿐이고, 실제 화면과의 대조는 reconcile.ts 가 한다.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

export interface CodeRoute {
  path: string;
  file: string;
  line: number;
  framework: string;
  /** :id [id] 같은 값이 들어가는 경로 — 값을 알 수 없어 그대로는 열어 볼 수 없다 */
  dynamic: boolean;
  /** 이 화면을 그리는 컴포넌트 이름(있으면) */
  component?: string;
}

export interface CodeEvent {
  /** click change submit input keydown ... */
  kind: string;
  handler?: string;
  file: string;
  line: number;
  route?: string;
  /** 화면의 요소와 맞춰 볼 단서 */
  hints: { id?: string; name?: string; testid?: string; text?: string; ariaLabel?: string };
}

export interface CodeApi {
  method: string;
  url: string;
  file: string;
  line: number;
  /** 주소에 ${...} 같은 값이 들어감 */
  dynamic: boolean;
  /** 서버 쪽 코드에서 정의된 API(Next 의 pages/api 등)면 true, 화면 쪽에서 부르는 곳이면 false */
  defined: boolean;
}

export interface CodeFileOp {
  type: "download" | "upload";
  file: string;
  line: number;
  route?: string;
  hint: string;
}

export interface CodeAnalysis {
  root: string;
  generatedAt: string;
  frameworks: string[];
  files: number;
  routes: CodeRoute[];
  events: CodeEvent[];
  apis: CodeApi[];
  fileOps: CodeFileOp[];
  notes: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", "out", "coverage", ".e2e", "vendor", ".svelte-kit", ".turbo", ".cache", "__tests__", "__mocks__", "storybook-static"]);
const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".svelte", ".html", ".htm"]);
const MAX_FILES = 3000;
const MAX_BYTES = 400_000;
const CAPS = { routes: 500, events: 1500, apis: 500, fileOps: 200 };

interface SrcFile {
  abs: string;
  rel: string;
  text: string;
  lines: string[];
}

function walk(root: string): { files: SrcFile[]; truncated: boolean } {
  const files: SrcFile[] = [];
  let truncated = false;
  const rec = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    names.sort();
    for (const n of names) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = join(dir, n);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n) && !n.startsWith(".")) rec(abs);
      } else if (CODE_EXT.has(extname(n)) && st.size <= MAX_BYTES && !/\.(test|spec|stories)\.[jt]sx?$/.test(n) && !/\.d\.ts$/.test(n)) {
        const text = readFileSync(abs, "utf8");
        files.push({ abs, rel: relative(root, abs).split(sep).join("/"), text, lines: text.split("\n") });
      }
    }
  };
  rec(root);
  return { files, truncated };
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const isDynamic = (p: string) => /[:*]|\[|\$\{|\{[a-zA-Z]/.test(p);

function normRoute(p: string): string {
  let r = p.trim().replace(/\?.*$/, "");
  if (!r.startsWith("/")) r = "/" + r;
  r = r.replace(/\/+/g, "/");
  if (r.length > 1) r = r.replace(/\/$/, "");
  return r;
}

// ---------- 라우트 추출기 ----------

interface Ctx {
  root: string;
  files: SrcFile[];
  deps: Set<string>;
}

type RouteExtractor = { id: string; applies: (c: Ctx) => boolean; extract: (c: Ctx) => CodeRoute[] };

const stripExt = (s: string) => s.replace(/\.(tsx|jsx|ts|js|mjs|vue|svelte)$/, "");
const fileComponentName = (rel: string) => {
  const b = stripExt(basename(rel));
  return b === "index" || b === "page" ? stripExt(basename(rel.replace(/\/[^/]+$/, ""))) : b;
};

/** Next.js app router: app/**\/page.tsx, Next.js pages router: pages/**, Nuxt: pages/**.vue, SvelteKit: routes/**\/+page.svelte */
function convention(c: Ctx, framework: string, dirRe: RegExp, kind: "next-app" | "next-pages" | "nuxt" | "svelte"): CodeRoute[] {
  const out: CodeRoute[] = [];
  for (const f of c.files) {
    const m = f.rel.match(dirRe);
    if (!m) continue;
    let sub = m[1]!;
    if (kind === "next-app" && !/^(.*\/)?page\.(tsx|jsx|ts|js)$/.test(sub)) continue;
    if (kind === "next-pages" && (/^_/.test(basename(sub)) || /^api(\/|$)/.test(sub) || !/\.(tsx|jsx|ts|js)$/.test(sub))) continue;
    if (kind === "nuxt" && !sub.endsWith(".vue")) continue;
    if (kind === "svelte" && !/\+page\.svelte$/.test(sub)) continue;
    let p = stripExt(sub).replace(/\/(page|\+page)$/, "").replace(/^(page|\+page)$/, "");
    p = p
      .split("/")
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@") && s !== "index")
      .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[\[(.+)\]\]$/, ":$1").replace(/^\[(.+)\]$/, ":$1").replace(/^_(.+)$/, ":$1"))
      .join("/");
    const path = normRoute(p);
    out.push({ path, file: f.rel, line: 1, framework, dynamic: isDynamic(path), component: fileComponentName(f.rel) });
  }
  return out;
}

/** JSX 태그의 속성 부분: 중괄호 안의 > 는 태그 끝으로 보지 않는다 */
const ATTRS = String.raw`(?:[^>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?`;
const TAG_RE = new RegExp(String.raw`<[A-Za-z][\w.-]*(?:[^>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*>`);

function objectRoutes(c: Ctx, framework: string, only: (f: SrcFile) => boolean): CodeRoute[] {
  const out: CodeRoute[] = [];
  for (const f of c.files) {
    if (!only(f)) continue;
    // <Route path="/x" element={<X />} /> 또는 component={X}
    for (const m of f.text.matchAll(new RegExp(`<Route\\b(${ATTRS})\\/?>`, "g"))) {
      const attrs = m[1]!;
      const p = attrs.match(/\bpath\s*=\s*(?:\{\s*)?(['"`])([^'"`]+)\1/)?.[2];
      if (p === undefined) continue;
      const comp = attrs.match(/\belement\s*=\s*\{\s*<\s*([A-Z]\w*)/)?.[1] ?? attrs.match(/\b(?:component|Component)\s*=\s*\{\s*([A-Z]\w*)/)?.[1];
      out.push({ path: normRoute(p), file: f.rel, line: lineOf(f.text, m.index!), framework, dynamic: isDynamic(p), component: comp });
    }
    // { path: '/x', element: <X /> } / component: X / component: () => import('./X.vue')
    for (const m of f.text.matchAll(/\bpath\s*:\s*(['"`])([^'"`]*)\1\s*,([^{}]*?)(?=[},])/g)) {
      const p = m[2]!;
      if (p === "" || p === "*") continue;
      const rest = m[3] ?? "";
      const comp = rest.match(/(?:element\s*:\s*<\s*|component\s*:\s*|Component\s*:\s*)([A-Z]\w*)/)?.[1] ?? rest.match(/import\(\s*['"][^'"]*?([A-Za-z0-9_]+)(?:\.\w+)?['"]/)?.[1];
      out.push({ path: normRoute(p), file: f.rel, line: lineOf(f.text, m.index!), framework, dynamic: isDynamic(p), component: comp });
    }
  }
  return out;
}

const ROUTE_EXTRACTORS: RouteExtractor[] = [
  { id: "next-app", applies: (c) => c.deps.has("next") || c.files.some((f) => /(^|\/)app\/.*page\.(tsx|jsx|ts|js)$/.test(f.rel)), extract: (c) => convention(c, "next-app", /^(?:.*\/)?app\/(.+)$/, "next-app") },
  { id: "next-pages", applies: (c) => c.deps.has("next"), extract: (c) => convention(c, "next-pages", /^(?:.*\/)?pages\/(.+)$/, "next-pages") },
  { id: "nuxt", applies: (c) => c.deps.has("nuxt"), extract: (c) => convention(c, "nuxt", /^(?:.*\/)?pages\/(.+)$/, "nuxt") },
  { id: "sveltekit", applies: (c) => c.deps.has("@sveltejs/kit"), extract: (c) => convention(c, "sveltekit", /^(?:.*\/)?routes\/(.+)$/, "svelte") },
  {
    id: "react-router",
    applies: (c) => [...c.deps].some((d) => d === "react-router" || d === "react-router-dom" || d === "@tanstack/react-router") || c.files.some((f) => /from\s+['"]react-router/.test(f.text)),
    extract: (c) => objectRoutes(c, "react-router", (f) => /react-router|createBrowserRouter|createHashRouter|useRoutes|<Route\b/.test(f.text)),
  },
  {
    id: "vue-router",
    applies: (c) => c.deps.has("vue-router") || c.files.some((f) => /from\s+['"]vue-router/.test(f.text)),
    extract: (c) => objectRoutes(c, "vue-router", (f) => /vue-router|createRouter|routes\s*[:=]/.test(f.text)),
  },
  {
    id: "static-html",
    applies: (c) => c.files.some((f) => /\.html?$/.test(f.rel)),
    extract: (c) =>
      c.files
        .filter((f) => /\.html?$/.test(f.rel))
        .map((f) => {
          const rel = f.rel.replace(/^(public|static|www|site|src)\//, "");
          const path = normRoute(rel.replace(/(^|\/)index\.html?$/, "$1"));
          return { path, file: f.rel, line: 1, framework: "static-html", dynamic: false } as CodeRoute;
        }),
  },
];

// ---------- 이벤트·API·파일 추출 ----------

const EVT_NORMAL: Record<string, string> = { onclick: "click", ondblclick: "dblclick", onchange: "change", onsubmit: "submit", oninput: "input", onkeydown: "keydown", onkeyup: "keyup", onkeypress: "keypress", onfocus: "focus", onblur: "blur", onmouseenter: "hover", onmouseover: "hover", ondrop: "drop", onscroll: "scroll" };

function hintsAround(lines: string[], idx: number, col = 0): CodeEvent["hints"] {
  // 이벤트가 붙은 태그는 같은 줄이거나 앞뒤 몇 줄 안에 있다.
  const from = Math.max(0, idx - 4);
  let open = idx;
  for (let i = idx; i >= from; i--) {
    if (/<[A-Za-z]/.test(lines[i]!)) {
      open = i;
      break;
    }
  }
  const block = lines.slice(open, Math.min(lines.length, idx + 5)).join(" ");
  const pos = lines.slice(open, idx).reduce((n, l) => n + l.length + 1, 0) + col;
  const tags = [...block.matchAll(new RegExp(TAG_RE.source, "g"))];
  const hit = tags.find((m) => m.index! <= pos && pos < m.index! + m[0].length) ?? tags[0];
  const tag = hit?.[0] ?? block;
  const attr = (n: string) => tag.match(new RegExp(`(?:^|[\\s<])${n}\\s*=\\s*(?:\\{\\s*)?(['"\`])([^'"\`]+)\\1`))?.[2];
  const after = hit ? block.slice(hit.index! + tag.length) : "";
  const text = after.match(/^\s*([^<>{}$]{1,40}?)\s*</)?.[1]?.trim();
  return { id: attr("id"), name: attr("name"), testid: attr("data-testid") ?? attr("data-test") ?? attr("data-cy"), ariaLabel: attr("aria-label"), text: text || attr("title") || attr("value") };
}

function extractEvents(f: SrcFile): CodeEvent[] {
  const out: CodeEvent[] = [];
  f.lines.forEach((ln, i) => {
    // JSX / Svelte on:xxx / HTML onclick=
    for (const m of ln.matchAll(/\b(on[A-Z][A-Za-z]+)\s*=\s*\{\s*([^}]*?)\s*\}/g)) out.push({ kind: m[1]!.slice(2).toLowerCase().replace(/^doubleclick$/, "dblclick"), handler: m[2]!.slice(0, 60), file: f.rel, line: i + 1, hints: hintsAround(f.lines, i, m.index!) });
    for (const m of ln.matchAll(/\b(on(?:click|dblclick|change|submit|input|keydown|keyup|keypress|focus|blur|mouseenter|mouseover|drop|scroll))\s*=\s*(['"])(.*?)\2/g)) out.push({ kind: EVT_NORMAL[m[1]!] ?? m[1]!.slice(2), handler: m[3]!.slice(0, 60), file: f.rel, line: i + 1, hints: hintsAround(f.lines, i, m.index!) });
    for (const m of ln.matchAll(/(?:@|v-on:|on:)([a-z][a-z.-]*)(?:\.[a-z]+)*\s*=\s*(['"{])([^'"}]*)/g)) out.push({ kind: m[1]!.split(".")[0]!, handler: m[3]!.slice(0, 60), file: f.rel, line: i + 1, hints: hintsAround(f.lines, i, m.index!) });
    for (const m of ln.matchAll(/\bv-model(?:\.[a-z]+)?\s*=\s*(['"])([^'"]+)\1/g)) out.push({ kind: "input", handler: m[2], file: f.rel, line: i + 1, hints: hintsAround(f.lines, i, m.index!) });
    for (const m of ln.matchAll(/addEventListener\(\s*(['"`])([a-z]+)\1\s*,\s*([A-Za-z_$][\w$.]*)?/g)) out.push({ kind: m[2]!, handler: m[3], file: f.rel, line: i + 1, hints: {} });
    for (const m of ln.matchAll(/(?:querySelector|getElementById)\(\s*(['"`])#?([^'"`]+)\1\s*\)\s*\.\s*(on[a-z]+)\s*=/g)) {
      const id = ln.includes("getElementById") ? m[2] : m[2]!.startsWith(".") ? undefined : m[2];
      out.push({ kind: EVT_NORMAL[m[3]!] ?? m[3]!.slice(2), file: f.rel, line: i + 1, hints: { id } });
    }
    for (const m of ln.matchAll(/\$\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.\s*(click|on|change|submit)\(\s*(?:(['"`])([a-z]+)\4)?/g)) {
      const sel = m[2]!;
      out.push({ kind: m[5] ?? m[3]!, file: f.rel, line: i + 1, hints: { id: sel.startsWith("#") ? sel.slice(1) : undefined } });
    }
  });
  return out;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

function cleanUrl(raw: string): { url: string; dynamic: boolean } {
  const dynamic = /\$\{/.test(raw);
  return { url: raw.replace(/\$\{[^}]*\}/g, ":param"), dynamic };
}

function extractApis(f: SrcFile): CodeApi[] {
  const out: CodeApi[] = [];
  const push = (method: string, raw: string, index: number) => {
    const { url, dynamic } = cleanUrl(raw);
    if (!url || /^(data:|blob:|#|mailto:|javascript:)/.test(url)) return;
    out.push({ method: method.toUpperCase(), url, file: f.rel, line: lineOf(f.text, index), dynamic, defined: false });
  };
  for (const m of f.text.matchAll(/\bfetch\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([^}]*)\})?/g)) {
    const opt = m[3] ?? "";
    const meth = opt.match(/method\s*:\s*(['"`])([A-Za-z]+)\1/)?.[2] ?? "GET";
    push(meth, m[2]!, m.index!);
  }
  for (const m of f.text.matchAll(/\b(?:axios|api|http|client|request|\$http|\$axios|ky)\s*\.\s*(get|post|put|patch|delete|head)\(\s*(['"`])([^'"`]+)\2/g)) push(m[1]!, m[3]!, m.index!);
  for (const m of f.text.matchAll(/\baxios\(\s*\{([^}]*)\}/g)) {
    const url = m[1]!.match(/url\s*:\s*(['"`])([^'"`]+)\1/)?.[2];
    if (url) push(m[1]!.match(/method\s*:\s*(['"`])([A-Za-z]+)\1/)?.[2] ?? "GET", url, m.index!);
  }
  for (const m of f.text.matchAll(/\$\.(get|post)\(\s*(['"`])([^'"`]+)\2/g)) push(m[1]!, m[3]!, m.index!);
  for (const m of f.text.matchAll(/\$\.ajax\(\s*\{([^}]*)\}/g)) {
    const url = m[1]!.match(/url\s*:\s*(['"`])([^'"`]+)\1/)?.[2];
    if (url) push(m[1]!.match(/(?:type|method)\s*:\s*(['"`])([A-Za-z]+)\1/)?.[2] ?? "GET", url, m.index!);
  }
  for (const m of f.text.matchAll(/\.open\(\s*(['"`])([A-Za-z]+)\1\s*,\s*(['"`])([^'"`]+)\3/g)) if (METHODS.has(m[2]!.toLowerCase())) push(m[2]!, m[4]!, m.index!);
  for (const m of f.text.matchAll(/\buse(?:SWR|Fetch|Query)\(\s*(['"`])(\/[^'"`]+)\1/g)) push("GET", m[2]!, m.index!);
  return out;
}

/** 서버 쪽 코드에서 정의된 API: Next pages/api, app/**\/route.ts, express 류 app.get('/x') */
function extractDefinedApis(f: SrcFile): CodeApi[] {
  const out: CodeApi[] = [];
  const def = (method: string, path: string, index: number) => {
    const { url, dynamic } = cleanUrl(path);
    out.push({ method: method.toUpperCase(), url: normRoute(url), file: f.rel, line: lineOf(f.text, index), dynamic: dynamic || isDynamic(path), defined: true });
  };
  const pagesApi = f.rel.match(/^(?:.*\/)?pages\/(api\/.+)$/);
  if (pagesApi && /\.(ts|js)x?$/.test(f.rel)) {
    const p = "/" + stripExt(pagesApi[1]!).replace(/\/index$/, "").replace(/\[\.\.\.(.+?)\]/g, ":$1*").replace(/\[(.+?)\]/g, ":$1");
    def("ANY", p, 0);
  }
  const route = f.rel.match(/^(?:.*\/)?app\/(.+)\/route\.(ts|js)$/);
  if (route) {
    const p = "/" + route[1]!.split("/").filter((s) => !/^\(.*\)$/.test(s)).join("/").replace(/\[\.\.\.(.+?)\]/g, ":$1*").replace(/\[(.+?)\]/g, ":$1");
    for (const m of f.text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) def(m[1]!, p, m.index!);
  }
  for (const m of f.text.matchAll(/\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]*)\2/g)) def(m[1]!, m[3]!, m.index!);
  return out;
}

function extractFileOps(f: SrcFile): CodeFileOp[] {
  const out: CodeFileOp[] = [];
  const add = (type: "download" | "upload", index: number, hint: string) => out.push({ type, file: f.rel, line: lineOf(f.text, index), hint });
  for (const m of f.text.matchAll(/<a\b[^>]*\bdownload\b/g)) add("download", m.index!, "a[download]");
  for (const m of f.text.matchAll(/URL\.createObjectURL\(/g)) add("download", m.index!, "URL.createObjectURL");
  for (const m of f.text.matchAll(/\bsaveAs\(/g)) add("download", m.index!, "saveAs(file-saver)");
  for (const m of f.text.matchAll(/responseType\s*:\s*(['"`])blob\1/g)) add("download", m.index!, "responseType: blob");
  for (const m of f.text.matchAll(/Content-Disposition/gi)) add("download", m.index!, "Content-Disposition");
  for (const m of f.text.matchAll(/<input\b[^>]*\btype\s*=\s*(?:\{\s*)?(['"`])file\1/g)) add("upload", m.index!, "input[type=file]");
  for (const m of f.text.matchAll(/new\s+FormData\(/g)) add("upload", m.index!, "FormData");
  return out;
}

// ---------- 진입점 ----------

export function analyzeCode(root: string): CodeAnalysis {
  const notes: string[] = [];
  if (!existsSync(root)) throw new Error(`코드 경로가 없습니다: ${root}`);
  const st = statSync(root);
  const base = st.isDirectory() ? root : join(root, "..");
  const { files, truncated } = st.isDirectory() ? walk(root) : { files: [{ abs: root, rel: basename(root), text: readFileSync(root, "utf8"), lines: readFileSync(root, "utf8").split("\n") }], truncated: false };
  if (truncated) notes.push(`파일이 ${MAX_FILES}개를 넘어 일부만 읽었습니다.`);
  const deps = new Set<string>();
  try {
    const pj = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    for (const k of Object.keys({ ...pj.dependencies, ...pj.devDependencies })) deps.add(k);
  } catch {}
  const ctx: Ctx = { root, files, deps };

  const frameworks: string[] = [];
  let routes: CodeRoute[] = [];
  for (const ex of ROUTE_EXTRACTORS) {
    if (!ex.applies(ctx)) continue;
    const r = ex.extract(ctx);
    if (r.length) {
      frameworks.push(ex.id);
      routes.push(...r);
    }
  }
  const seenRoute = new Set<string>();
  routes = routes.filter((r) => (seenRoute.has(r.path) ? false : (seenRoute.add(r.path), true)));

  // 컴포넌트 이름 → 화면 경로 (파일 이름이나 export 이름이 같으면 그 화면의 이벤트로 본다)
  const byComp = new Map<string, string>();
  const byFile = new Map<string, string>();
  for (const r of routes) {
    if (r.component) byComp.set(r.component, r.path);
    byFile.set(r.file, r.path);
  }
  const routeOfFile = (f: SrcFile): string | undefined => {
    if (byFile.has(f.rel)) return byFile.get(f.rel);
    const names = new Set<string>([fileComponentName(f.rel)]);
    for (const m of f.text.matchAll(/export\s+default\s+(?:function\s+|class\s+)?([A-Z]\w*)/g)) names.add(m[1]!);
    for (const m of f.text.matchAll(/export\s+(?:default\s+)?(?:const|function)\s+([A-Z]\w*)/g)) names.add(m[1]!);
    for (const n of names) if (byComp.has(n)) return byComp.get(n);
    return undefined;
  };

  const events: CodeEvent[] = [];
  const apis: CodeApi[] = [];
  const fileOps: CodeFileOp[] = [];
  for (const f of files) {
    const route = routeOfFile(f);
    for (const e of extractEvents(f)) events.push({ ...e, route });
    apis.push(...extractApis(f), ...extractDefinedApis(f));
    for (const o of extractFileOps(f)) fileOps.push({ ...o, route });
  }
  const dedupe = <T>(arr: T[], key: (x: T) => string) => {
    const s = new Set<string>();
    return arr.filter((x) => (s.has(key(x)) ? false : (s.add(key(x)), true)));
  };
  const out: CodeAnalysis = {
    root,
    generatedAt: new Date().toISOString(),
    frameworks: [...new Set(frameworks)],
    files: files.length,
    routes: routes.slice(0, CAPS.routes),
    events: dedupe(events, (e) => `${e.file}:${e.line}:${e.kind}:${e.handler ?? ""}:${Object.values(e.hints).join("|")}`).slice(0, CAPS.events),
    apis: dedupe(apis, (a) => `${a.method} ${a.url} ${a.file}:${a.line}`).slice(0, CAPS.apis),
    fileOps: dedupe(fileOps, (o) => `${o.type} ${o.file}:${o.line}`).slice(0, CAPS.fileOps),
    notes,
  };
  if (!out.frameworks.length) notes.push("라우터를 찾지 못했습니다. 지원하는 패턴: Next(app·pages), React Router, Vue Router, Nuxt, SvelteKit, 정적 HTML. 이벤트·API 후보는 그대로 뽑았습니다.");
  if (out.events.length >= CAPS.events || out.apis.length >= CAPS.apis) notes.push("후보가 많아 일부만 담았습니다.");
  return out;
}

/** 경로 템플릿(:id, [id], *)을 정규식으로 바꾼다. */
export function routeRegex(path: string): RegExp {
  const esc = path
    .split("/")
    .map((seg) => (/^:.+\*$/.test(seg) ? ".+" : /^:/.test(seg) || seg === "*" ? "[^/]+" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${esc}/?$`);
}
