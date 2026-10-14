import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../types.ts";
import { expandEnv } from "../store.ts";
import type { DPage, Drained, Driver, Session } from "./index.ts";
import { LIB } from "./inpage.ts";

class PwPage implements DPage {
  constructor(private page: Page, private d: Drained, private timeout: number) {}
  private L(sel: string) {
    return this.page.locator(sel);
  }
  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "load", timeout: 30000 });
    await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  }
  async reload() {
    await this.page.reload({ waitUntil: "load" });
    await this.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  }
  async click(sel: string) {
    await this.L(sel).click({ timeout: this.timeout });
  }
  async dblclick(sel: string) {
    await this.L(sel).dblclick({ timeout: this.timeout });
  }
  async hover(sel: string) {
    await this.L(sel).hover({ timeout: this.timeout });
  }
  async fill(sel: string, value: string) {
    await this.L(sel).fill(value, { timeout: this.timeout });
  }
  async selectOption(sel: string, value: string) {
    await this.L(sel).selectOption(value, { timeout: this.timeout });
  }
  async check(sel: string, on: boolean) {
    await this.L(sel).setChecked(on, { timeout: this.timeout });
  }
  async press(sel: string | null, key: string) {
    if (sel) await this.L(sel).press(key, { timeout: this.timeout });
    else await this.page.keyboard.press(key);
  }
  async waitFor(sel: string, state: "visible" | "hidden" | "attached" | "detached", timeout: number) {
    await this.L(sel).first().waitFor({ state, timeout });
  }
  async count(sel: string) {
    return this.L(sel).count();
  }
  async isVisible(sel: string) {
    return this.L(sel).first().isVisible();
  }
  async text(sel: string) {
    return (await this.L(sel).first().innerText({ timeout: this.timeout })).trim();
  }
  async value(sel: string) {
    return this.L(sel).first().inputValue({ timeout: this.timeout });
  }
  async evaluate<T = any>(expr: string): Promise<T> {
    return this.page.evaluate(`(() => { ${LIB}; return (${expr}); })()`) as Promise<T>;
  }
  async url() {
    return this.page.url();
  }
  async title() {
    return this.page.title();
  }
  async screenshot(path: string) {
    await this.page.screenshot({ path, fullPage: false });
  }
  async drain(): Promise<Drained> {
    const out = { console: [...this.d.console], pageErrors: [...this.d.pageErrors], failedRequests: [...this.d.failedRequests] };
    this.d.console.length = 0;
    this.d.pageErrors.length = 0;
    this.d.failedRequests.length = 0;
    return out;
  }
}

export class PwDriver implements Driver {
  name: string;
  capabilities = { video: true, network: true };
  private browser?: Browser;
  constructor(private cfg: Config, private pick: "chrome" | "chromium") {
    this.name = pick === "chrome" ? "playwright+chrome" : "playwright+chromium";
  }
  async open() {
    this.browser = await chromium.launch({
      headless: this.cfg.headless,
      channel: this.pick === "chrome" ? "chrome" : undefined,
    });
  }
  async newSession(evidenceDir: string): Promise<Session> {
    mkdirSync(evidenceDir, { recursive: true });
    const vp = this.cfg.viewport;
    const ctx = await this.browser!.newContext({
      viewport: vp,
      ignoreHTTPSErrors: true,
      recordVideo: { dir: join(evidenceDir, "_video"), size: vp },
    });
    const kv = Object.fromEntries(Object.entries(this.cfg.auth?.localStorage ?? {}).map(([k, v]) => [k, expandEnv(v)]));
    if (Object.keys(kv).length) {
      await ctx.addInitScript((data: Record<string, string>) => {
        try {
          if (sessionStorage.getItem("__e2e_auth")) return;
          for (const k of Object.keys(data)) localStorage.setItem(k, data[k]!);
          sessionStorage.setItem("__e2e_auth", "1");
        } catch {}
      }, kv);
    }
    if (this.cfg.auth?.cookies?.length) {
      const base = new URL(this.cfg.baseUrl);
      await ctx.addCookies(this.cfg.auth.cookies.map((c) => ({ ...c, value: expandEnv(c.value), url: c.url ?? (c.domain ? undefined : base.origin) })));
    }
    await ctx.addInitScript(LIB);
    await ctx.tracing.start({ screenshots: true, snapshots: true });
    const page = await ctx.newPage();
    const d: Drained = { console: [], pageErrors: [], failedRequests: [] };
    const uniq = (arr: string[], s: string) => {
      if (!arr.includes(s) && arr.length < 50) arr.push(s);
    };
    page.on("console", (m) => {
      if (m.type() === "error") uniq(d.console, `${m.text().slice(0, 300)}${m.location().url ? " @" + m.location().url.replace(/^https?:\/\/[^/]+/, "") : ""}`);
    });
    page.on("pageerror", (e) => uniq(d.pageErrors, String(e.message).slice(0, 300)));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      if (/ERR_ABORTED|cancel/i.test(err)) return;
      uniq(d.failedRequests, `ERR ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")} (${err})`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) uniq(d.failedRequests, `${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
    });
    const wrapped = new PwPage(page, d, this.cfg.stepTimeoutMs);
    return {
      page: wrapped,
      finish: async (passed: boolean) => {
        const res: { video?: string; trace?: string } = {};
        const video = page.video();
        try {
          if (!passed) {
            const tp = join(evidenceDir, "trace.zip");
            await ctx.tracing.stop({ path: tp });
            res.trace = tp;
          } else await ctx.tracing.stop();
        } catch {}
        await page.close().catch(() => {});
        try {
          const vp = await video?.path();
          if (vp && existsSync(vp)) {
            const dest = join(evidenceDir, "video.webm");
            renameSync(vp, dest);
            res.video = dest;
          }
        } catch {}
        await ctx.close().catch(() => {});
        return res;
      },
    };
  }
  async close() {
    await this.browser?.close().catch(() => {});
  }
}
