// 6단계 시험: 현황판이 내부망 IP 로 뜨고, 접속 토큰 없는 접속은 막히고, 토큰 있는 접속은 되는지.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardToken, lanAddresses, startDashboard, type DashboardInfo } from "../src/dashboard.ts";
import { Project } from "../src/store.ts";
import * as A from "../src/actions.ts";

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));
const tmp = () => mkdtempSync(join(tmpdir(), "e2e-loop-s6-"));
const start = (p: Project, port: number, opts: Parameters<typeof startDashboard>[2] = {}): DashboardInfo => {
  const d = startDashboard(p, port, opts);
  stops.push(d.stop);
  return d;
};
const hasLan = lanAddresses().length > 0;

test("내부망 주소만 고른다: 192.168.x.x·10.x.x.x. 루프백·내부용·그 밖의 주소·IPv6 는 제외", () => {
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
  const ifaces = {
    lo0: [v4("127.0.0.1", true)],
    en0: [v4("192.168.0.5"), { ...v4("fe80::1"), family: "IPv6" as const }],
    en1: [v4("10.2.3.4")],
    utun: [v4("172.16.0.5"), v4("169.254.1.1"), v4("8.8.8.8")],
  } as any;
  expect(lanAddresses(ifaces)).toEqual([{ name: "en0", address: "192.168.0.5" }, { name: "en1", address: "10.2.3.4" }]);
  expect(lanAddresses({ lo0: [v4("127.0.0.1", true)] } as any)).toEqual([]);
});

test("내부망 IP 가 없으면 이 컴퓨터에서만 접속된다고 경고하고, 내부망이 아닌 호스트 지정은 거부한다", async () => {
  const p = new Project(tmp());
  p.ensure();
  const d = start(p, 7810, { ifaces: {} });
  expect(d.lan).toBe(false);
  expect(d.warn).toContain("내부망 IP");
  expect(() => startDashboard(p, 7815, { host: "8.8.8.8", ifaces: {} })).toThrow("내부망 주소");
});

test.skipIf(!hasLan)("내부망 IP 로 바인딩한다: 그 주소로는 접속되고 localhost 로는 접속되지 않는다", async () => {
  const p = new Project(tmp());
  p.ensure();
  const d = start(p, 7820);
  expect(d.lan).toBe(true);
  expect(d.host).toMatch(/^(192\.168\.|10\.)/);
  expect(d.url).toBe(`http://${d.host}:${d.port}`);
  expect(d.access_url).toBe(`${d.url}/?token=${d.token}`);
  const ok = await fetch(d.access_url, { redirect: "manual" });
  expect(ok.status).toBe(302);
  await expect(fetch(`http://127.0.0.1:${d.port}/`)).rejects.toThrow(); // 루프백에는 열려 있지 않다
});

test.skipIf(!hasLan)("토큰 없는 접속은 막고, 토큰이 있으면 허용한다(주소·헤더·쿠키), 응답에는 내용이 새지 않는다", async () => {
  const root = tmp();
  const p = new Project(root);
  p.ensure();
  p.saveConfig({ ...p.config() });
  const d = start(p, 7830);
  const get = (path: string, init: RequestInit = {}) => fetch(d.url + path, { redirect: "manual", ...init });

  for (const path of ["/", "/api/state", "/files/R01/report.html", "/files/..%2Fconfig.json"]) {
    const r = await get(path);
    expect(r.status).toBe(401);
    const body = await r.text();
    expect(body).toContain("접속 토큰이 필요");
    expect(body).not.toContain(root); // 프로젝트 경로·상태가 새지 않는다
  }
  expect((await get("/?token=wrong")).status).toBe(401);
  expect((await get("/", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await get("/", { headers: { cookie: "e2e_token=wrong" } })).status).toBe(401);
  expect((await get(`/?token=${d.token.slice(0, -1)}0`)).status).toBe(401); // 거의 맞는 토큰도 안 됨

  // 주소의 토큰 → 쿠키로 바꿔 심고 주소에서 지움
  const first = await get(`/?token=${d.token}`);
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe("/");
  const cookie = first.headers.get("set-cookie")!;
  expect(cookie).toContain(`e2e_token=${d.token}`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  const page = await get("/", { headers: { cookie: `e2e_token=${d.token}` } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("E2E 실시간");
  expect(html).not.toContain("\\uC2E4"); // 한글이 유니코드 이스케이프 글자로 깨지지 않는다
  const st: any = await (await get("/api/state", { headers: { authorization: `Bearer ${d.token}` } })).json();
  expect(st.notice).toContain("테스트 데이터와 테스트 계정만 입력");
  expect(st.counts).toEqual({ pass: 0, issue: 0, skip: 0, warn: 0 });
  expect(st.trend).toEqual([]);
});

test.skipIf(!hasLan)("영상 되감기(Range)와 파일 경로 가두기", async () => {
  const p = new Project(tmp());
  p.ensure();
  mkdirSync(p.p("rounds/R01/evidence"), { recursive: true });
  writeFileSync(p.p("rounds/R01/evidence/video.mp4"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  writeFileSync(p.p("secret.json"), '{"secret":1}');
  const d = start(p, 7840);
  const h = { authorization: `Bearer ${d.token}` };
  const full = await fetch(`${d.url}/files/R01/evidence/video.mp4`, { headers: h });
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect((await full.arrayBuffer()).byteLength).toBe(1000);
  const part = await fetch(`${d.url}/files/R01/evidence/video.mp4`, { headers: { ...h, range: "bytes=10-19" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
  const tail = await fetch(`${d.url}/files/R01/evidence/video.mp4`, { headers: { ...h, range: "bytes=-50" } });
  expect(tail.headers.get("content-range")).toBe("bytes 950-999/1000");
  expect((await fetch(`${d.url}/files/R01/evidence/video.mp4`, { headers: { ...h, range: "bytes=5000-6000" } })).status).toBe(416);
  // .e2e/rounds 밖으로 나가는 경로는 막는다
  const out = await fetch(`${d.url}/files/..%2Fsecret.json`, { headers: h });
  expect([403, 404]).toContain(out.status);
  expect(await out.text()).not.toContain("secret");
});

test.skipIf(!hasLan)("토큰은 프로젝트에 계속 남고, rotate 하면 옛 토큰은 거부되며, 틀린 시도가 많으면 막는다", async () => {
  const p = new Project(tmp());
  p.ensure();
  const t1 = dashboardToken(p);
  expect(t1).toMatch(/^[0-9a-f]{48}$/);
  expect(dashboardToken(p)).toBe(t1); // 다시 띄워도 같은 주소
  const rotated = dashboardToken(p, true);
  expect(rotated).not.toBe(t1);
  const d = start(p, 7850);
  expect(d.token).toBe(rotated);
  expect((await fetch(d.url + "/api/state", { headers: { authorization: `Bearer ${t1}` } })).status).toBe(401);
  expect((await fetch(d.url + "/api/state", { headers: { authorization: `Bearer ${rotated}` } })).status).toBe(200);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await fetch(d.url + "/", { headers: { authorization: "Bearer nope" } })).status;
  expect(last).toBe(429);
  // 막힌 뒤에는 맞는 토큰도 잠시 거부된다(무차별 대입 방지)
  expect((await fetch(d.url + "/api/state", { headers: { authorization: `Bearer ${rotated}` } })).status).toBe(429);
});

test.skipIf(!hasLan)("e2e_dashboard: 토큰이 붙은 내부망 주소와 안내를 돌려주고, 다시 불러도 같은 서버", async () => {
  const root = tmp();
  const a: any = await A.aDashboard({ project: root });
  stops.push(() => (A as any).aDashboard);
  expect(a.lan).toBe(true);
  expect(a.access_url).toMatch(/^http:\/\/(192\.168\.|10\.)[\d.]+:\d+\/\?token=[0-9a-f]{48}$/);
  expect(a.notice).toContain("토큰");
  expect(a.notice).toContain("테스트 데이터와 테스트 계정만 입력");
  const b: any = await A.aDashboard({ project: root });
  expect(b.access_url).toBe(a.access_url);
  const r = await fetch(a.url + "/api/state");
  expect(r.status).toBe(401);
  const rot: any = await A.aDashboard({ project: root, rotate_token: true });
  expect(rot.access_url).not.toBe(a.access_url);
});
