// 사이트 탐색으로 만든 케이스의 "판정 규칙". 기대값이 없는 상태에서도 쓸 수 있는 일반 규칙만 둔다.
import type { DPage, Drained } from "./drivers/index.ts";
import { OBSERVE } from "./drivers/inpage.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Obs {
  url: string;
  title: string;
  dialogs: string[];
  nodes: number;
  textLen: number;
  alerts: string[];
  invalid: number;
  expanded: number;
  selected: number;
  checked: number;
  openDetails: number;
  hash: string;
}

export const observe = (p: DPage) => p.evaluate<Obs>(OBSERVE);

function changed(a: Obs, b: Obs): string[] {
  const out: string[] = [];
  if (a.url !== b.url) out.push(`주소 ${a.url} → ${b.url}`);
  if (a.dialogs.length !== b.dialogs.length) out.push(`대화상자 ${a.dialogs.length} → ${b.dialogs.length}`);
  if (Math.abs(a.nodes - b.nodes) > 0) out.push(`DOM ${a.nodes} → ${b.nodes}`);
  if (Math.abs(a.textLen - b.textLen) > 0) out.push("본문 텍스트 변화");
  if (b.alerts.join("|") !== a.alerts.join("|")) out.push("알림/오류 문구 변화");
  if (a.expanded !== b.expanded || a.selected !== b.selected || a.checked !== b.checked || a.openDetails !== b.openDetails) out.push("펼침/선택 상태 변화");
  if (a.title !== b.title) out.push("제목 변화");
  return out;
}

/** 클릭 후 화면이 바뀔 때까지 최대 ~1.2초 기다리며 관찰 */
async function settle(p: DPage, before: Obs): Promise<Obs> {
  let after = before;
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 250 : 200);
    after = await observe(p);
    if (changed(before, after).length) {
      await sleep(250);
      return observe(p);
    }
  }
  return after;
}

/** 오류 신호 정리: FAIL 사유와 경고로 나눈다. */
export function judgeErrors(d: Drained, allow = false): { fails: string[]; warns: string[] } {
  const fails: string[] = [];
  const warns: string[] = [];
  for (const e of d.pageErrors) (allow ? warns : fails).push(`처리 안 된 JS 오류: ${e}`);
  for (const r of d.failedRequests) {
    if (/^(5\d\d|ERR)\b/.test(r)) (allow ? warns : fails).push(`서버/네트워크 오류 응답: ${r}`);
    else warns.push(`요청 오류 응답: ${r}`);
  }
  for (const c of d.console) warns.push(`console.error: ${c}`);
  return { fails, warns };
}

export const SAMPLE = (type: string | undefined, hint: string): string => {
  const h = hint.toLowerCase();
  if (type === "email" || /email|메일/.test(h)) return `e2e+${Date.now() % 100000}@example.com`;
  if (type === "password") return "E2e-Pass#1234";
  if (type === "tel" || /phone|tel|전화|휴대/.test(h)) return "010-1234-5678";
  if (type === "number" || type === "range") return "1";
  if (type === "url") return "https://example.com";
  if (type === "date") return "2026-01-15";
  if (type === "time") return "10:30";
  if (type === "datetime-local") return "2026-01-15T10:30";
  if (type === "month") return "2026-01";
  if (type === "week") return "2026-W03";
  if (type === "color") return "#336699";
  if (/zip|postal|우편/.test(h)) return "12345";
  return "e2e-sample";
};

const CLOSE_CANDIDATES = [
  '[data-bs-dismiss="modal"]',
  '[aria-label*="close" i]',
  '[aria-label*="닫기"]',
  'button:text-is("닫기")',
  'button:text-is("Close")',
  'button:text-is("취소")',
  'button:text-is("Cancel")',
  'button:text-is("×")',
  'button:text-is("✕")',
  ".close",
];

async function visibleDialogs(p: DPage) {
  return (await observe(p)).dialogs.length;
}

/** 열린 모달이 닫히는지 확인. 닫히면 닫은 방법을 돌려준다. */
export async function closeModal(p: DPage): Promise<{ how: string | null; warns: string[] }> {
  const warns: string[] = [];
  await p.press(null, "Escape").catch(() => {});
  await sleep(350);
  if ((await visibleDialogs(p)) === 0) return { how: "Esc 키", warns };
  warns.push("Esc 키로 모달이 닫히지 않음");
  for (const sel of CLOSE_CANDIDATES) {
    if ((await p.count(sel).catch(() => 0)) > 0 && (await p.isVisible(sel).catch(() => false))) {
      try {
        await p.click(sel);
        await sleep(350);
        if ((await visibleDialogs(p)) === 0) return { how: `닫기 버튼(${sel})`, warns };
      } catch {}
    }
  }
  try {
    await p.evaluate(`document.elementFromPoint(4, 4) && document.elementFromPoint(4, 4).click()`);
    await sleep(350);
    if ((await visibleDialogs(p)) === 0) return { how: "바깥 영역 클릭", warns };
  } catch {}
  return { how: null, warns };
}

/** 케이스를 실행하지 않고 건너뛴다(규칙에 따른 스킵). 이슈가 아니다. */
export class SkipCase extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SkipCase";
  }
}

export interface ProbePolicy {
  /** 데이터를 초기화하지 않는 회차: 삭제는 테스터가 등록한 데이터만 */
  ownDataOnly: boolean;
  /** 테스터가 입력해 등록한 값들 */
  created: string[];
  onCreated?: (value: string) => void;
}

const OWN_MARK = /e2e[-+_.]/i;
export const isOwnData = (text: string, created: string[]) => OWN_MARK.test(text) || created.some((v) => v.length >= 4 && text.includes(v));

export interface ProbeResult {
  warns: string[];
  notes: string[];
}

/** 업로드 점검에 쓰는 작은 샘플 파일. accept 에 맞는 형식으로 만든다. */
export function sampleUploadFile(accept: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-loop-upload-"));
  const a = (accept ?? "").toLowerCase();
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let name = "e2e-sample.txt";
  let data: Buffer | string = "e2e sample file\n";
  if (/image|png|jpe?g|gif|webp/.test(a)) { name = "e2e-sample.png"; data = PNG; }
  else if (/pdf/.test(a)) { name = "e2e-sample.pdf"; data = "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"; }
  else if (/csv|spreadsheet|excel|xls/.test(a)) { name = "e2e-sample.csv"; data = "a,b\n1,2\n"; }
  else if (/json/.test(a)) { name = "e2e-sample.json"; data = '{"e2e":true}'; }
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

export async function runProbe(
  p: DPage,
  step: Record<string, any>,
  drainErrors: () => Promise<Drained>,
  baseUrl: string,
  allowErrors = false,
  evidenceDir?: string,
  policy?: ProbePolicy,
): Promise<ProbeResult> {
  const kind: string = step.kind;
  const sel: string = step.sel;
  const warns: string[] = [];
  const notes: string[] = [];
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const finish = async (): Promise<ProbeResult> => {
    const d = await drainErrors();
    const j = judgeErrors(d, allowErrors);
    if (j.fails.length) fail(j.fails.join(" / "));
    warns.push(...j.warns);
    return { warns, notes };
  };

  if (kind === "nav") {
    const href: string = step.href ?? "";
    if (step.newTab) {
      const r = await fetch(new URL(href, baseUrl).toString(), { redirect: "follow", signal: AbortSignal.timeout(10000) }).catch((e) => fail(`새 탭 링크에 접속 못 함: ${e}`));
      if ((r as Response).status >= 400) fail(`새 탭 링크 응답 ${(r as Response).status}: ${href}`);
      notes.push(`새 탭 링크는 클릭 대신 응답만 확인(${(r as Response).status})`);
      return finish();
    }
    const before = await observe(p);
    await p.click(sel);
    const after = await settle(p, before);
    const target = new URL(href, baseUrl);
    const here = new URL(after.url, baseUrl);
    if (target.hash && !href.startsWith("/") ) {
      if (after.hash !== target.hash && changed(before, after).length === 0) warns.push("같은 쪽 앵커 링크인데 위치/상태 변화가 없음");
    } else if (here.pathname.replace(/\/$/, "") !== target.pathname.replace(/\/$/, "")) {
      fail(`링크 이동 실패: 기대 ${target.pathname} / 실제 ${here.pathname}`);
    }
    if (/\b(404|not found|error|오류|찾을 수 없)/i.test(after.title)) fail(`이동한 화면 제목이 오류처럼 보임: "${after.title}"`);
    return finish();
  }

  if (kind === "delete") {
    // 같은 목록의 앞선 삭제 케이스가 이 줄을 이미 지웠으면 대상이 없다 — 결함이 아니라 순서 때문이므로 이유를 적어 스킵한다
    if ((await p.count(sel).catch(() => 0)) === 0) throw new SkipCase(`삭제 대상이 화면에 없음(“${step.label ?? sel}”) — 같은 목록의 앞선 삭제로 이미 지워졌을 수 있어 스킵함. 이슈가 아님`);
    // 삭제는 그 줄(행·카드)에 테스터가 등록한 데이터가 있을 때만 누른다
    const row = await p.evaluate<{ found: boolean; text: string }>(
      `(() => { const E = window.__e2e; const e = E.resolve(${JSON.stringify(sel)})[0]; if (!e) return { found: false, text: '' }; let c = e; for (let i = 0; i < 6 && c.parentElement; i++) { c = c.parentElement; if (c.matches('li,tr,[role=row],[role=listitem],article,.card,.item')) return { found: true, text: E.textOf(c) }; } return { found: false, text: E.textOf(e) }; })()`,
    );
    if (policy?.ownDataOnly && !(row.found && isOwnData(row.text, policy.created))) throw new SkipCase(`삭제 대상이 테스터가 등록한 데이터가 아니라 삭제하지 않음(“${step.label ?? sel}”) — 규칙에 따른 스킵이며 이슈가 아님`);
    const before = await observe(p);
    await p.click(sel, step.label);
    const after = await settle(p, before);
    const diff = changed(before, after);
    if (!diff.length) warns.push("NO_EFFECT: 삭제를 눌러도 화면 변화가 보이지 않음(확인 창이 떴거나 기능이 비어 있을 수 있음)");
    else notes.push("삭제 후 변화: " + diff.slice(0, 4).join(", "));
    return finish();
  }

  if (kind === "logout") {
    const before = await observe(p);
    await p.click(sel, step.label);
    const after = await settle(p, before);
    const diff = changed(before, after);
    if (!diff.length) fail("로그아웃을 눌렀는데 주소·화면 변화가 없음");
    notes.push("로그아웃 후 변화: " + diff.slice(0, 4).join(", "));
    return finish();
  }

  if (kind === "relogin-check") {
    const ok = await p.isVisible(sel).catch(() => false);
    if (!ok) fail("다시 로그인한 뒤에도 로그인 상태 요소(로그아웃 버튼)가 보이지 않음");
    notes.push("다시 로그인 확인됨");
    return finish();
  }

  if (kind === "page") {
    const t = await p.title();
    if (/\b(404|not found|error|오류|찾을 수 없)/i.test(t)) fail(`화면 제목이 오류처럼 보임: "${t}"`);
    notes.push(`화면 열림: "${t}"`);
    return finish();
  }

  if (kind === "download") {
    const dir = join(evidenceDir ?? mkdtempSync(join(tmpdir(), "e2e-loop-dl-")), "downloads");
    mkdirSync(dir, { recursive: true });
    const got = await p.download(sel, dir, step.soft ? 2500 : 8000);
    if (!got) {
      if (!step.soft) fail("눌렀는데 다운로드가 시작되지 않음");
      warns.push("다운로드가 시작되지 않음(버튼 이름이 다운로드처럼 보여 확인했지만, 파일을 내려받는 버튼이 아닐 수 있음)");
    } else {
      if (got.size === 0) fail(`내려받은 파일이 비어 있음: ${got.filename}`);
      notes.push(`다운로드: ${got.filename} (${got.size}바이트)`);
    }
    return finish();
  }

  if (kind === "upload") {
    const file = sampleUploadFile(step.attrs?.accept);
    await p.upload(sel, file);
    const n = await p.evaluate<number>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e && e.files ? e.files.length : -1; })()`);
    if (n === 0) fail("파일을 넣었는데 input 에 반영되지 않음");
    await sleep(300);
    notes.push(`샘플 파일 업로드(${file.split("/").pop()}), input.files=${n}`);
    return finish();
  }

  if (kind === "click" || kind === "tab" || kind === "summary") {
    const before = await observe(p);
    await p.click(sel, step.label);
    const after = await settle(p, before);
    const diff = changed(before, after);
    if (kind === "tab") {
      const ok = await p.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && (e.getAttribute('aria-selected') === 'true' || e.classList.contains('active') || e.classList.contains('selected')); })()`);
      if (!ok) warns.push("탭을 눌렀지만 선택 상태(aria-selected/active)가 표시되지 않음");
    }
    if (kind === "summary") {
      const ok = after.openDetails !== before.openDetails;
      if (!ok) fail("summary 를 눌러도 details 가 열리고 닫히지 않음");
    }
    if (after.dialogs.length > before.dialogs.length) {
      notes.push(`모달 열림: ${after.dialogs[after.dialogs.length - 1] || "(제목 없음)"}`);
      const c = await closeModal(p);
      warns.push(...c.warns);
      if (!c.how) fail("모달이 열렸지만 Esc·닫기 버튼·바깥 클릭으로 닫을 수 없음");
      notes.push(`모달 닫힘: ${c.how}`);
    } else if (!diff.length && kind !== "tab") {
      warns.push("NO_EFFECT: 클릭해도 주소·화면·모달 변화가 보이지 않음(요청만 보냈거나 기능이 비어 있을 수 있음)");
    } else {
      notes.push("변화: " + diff.slice(0, 4).join(", "));
    }
    return finish();
  }

  if (kind === "input") {
    const dis = await p.evaluate<{ d: boolean; ro: boolean }>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return { d: !!e && !!e.disabled, ro: !!e && !!e.readOnly }; })()`);
    if (dis.d || dis.ro) {
      notes.push("비활성/읽기 전용이라 입력 점검 생략");
      return finish();
    }
    const t: string | undefined = step.inputType;
    const sample = SAMPLE(t, step.label ?? "");
    policy?.onCreated?.(sample);
    await p.fill(sel, sample);
    const got = await p.value(sel);
    const same = t === "number" || t === "range" ? Number(got) === Number(sample) : got === sample || (t === "date" || t === "time" || t === "datetime-local" || t === "month" || t === "week" || t === "color");
    if (!same && got !== sample) fail(`입력한 값이 유지되지 않음: 입력 "${sample}" / 현재 "${got}"`);
    const ml = Number(step.attrs?.maxlength);
    if (ml > 0 && (t === "text" || t === "search" || t === "tel" || t === "url" || t === "email" || t === "password" || !t)) {
      await p.fill(sel, "x".repeat(ml + 5));
      const g2 = await p.value(sel);
      if (g2.length > ml) warns.push(`maxlength=${ml} 인데 ${g2.length}자까지 입력됨`);
    }
    if (t === "email" || t === "url" || step.attrs?.pattern) {
      await p.fill(sel, t === "email" ? "not-an-email" : t === "url" ? "not a url" : "###");
      const valid = await p.evaluate<boolean>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return !!e && e.validity ? e.validity.valid : true; })()`);
      if (valid) warns.push("잘못된 형식을 넣어도 브라우저 검증이 통과함(서버/스크립트 검증에 의존하는지 확인)");
    }
    await p.fill(sel, "");
    return finish();
  }

  if (kind === "select") {
    const opts: string[] = step.options ?? [];
    if (!opts.length) {
      notes.push("선택지 없음");
      return finish();
    }
    for (const o of opts.slice(0, 8)) {
      await p.selectOption(sel, o);
      const v = await p.value(sel);
      if (v !== o) {
        const txt = await p.evaluate<string>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e && e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].text : ''; })()`);
        if (txt !== o) fail(`선택값이 반영되지 않음: 선택 "${o}" / 현재 value "${v}", 표시 "${txt}"`);
      }
    }
    return finish();
  }

  if (kind === "toggle") {
    const read = () => p.evaluate<boolean | null>(`(() => { const e = window.__e2e.resolve(${JSON.stringify(sel)})[0]; return e ? (typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true') : null; })()`);
    const a = await read();
    if (a === null) fail("토글 요소를 찾지 못함");
    await p.click(sel);
    await sleep(200);
    const b = await read();
    if (a === b && step.inputType !== "radio") fail("클릭해도 체크 상태가 바뀌지 않음");
    if (step.inputType === "radio" && b !== true) fail("라디오를 눌러도 선택되지 않음");
    if (step.inputType !== "radio" && b !== a) await p.click(sel);
    return finish();
  }

  if (kind === "form-empty") {
    const before = await observe(p);
    await p.click(sel);
    const after = await settle(p, before);
    if (after.url !== before.url) fail(`필수 입력이 비었는데 제출이 진행됨(주소 ${before.url} → ${after.url})`);
    if (after.invalid === 0 && after.alerts.join("") === before.alerts.join("") && after.dialogs.length === before.dialogs.length) {
      warns.push("필수 입력이 비었는데 검증 신호(invalid·오류 문구)가 보이지 않음");
    } else notes.push(`빈 제출 검증 신호: invalid ${after.invalid}, 알림 ${after.alerts.length}`);
    return finish();
  }

  if (kind === "form-valid") {
    const fields: { sel: string; kind: string; inputType?: string; label: string; options?: string[]; accept?: string }[] = step.fields ?? [];
    for (const f of fields) {
      try {
        if (f.kind === "input") {
          const v = SAMPLE(f.inputType, f.label);
          policy?.onCreated?.(v);
          await p.fill(f.sel, v);
        }
        else if (f.kind === "select" && f.options?.length) await p.selectOption(f.sel, f.options.find((o) => o) ?? f.options[0]!);
        else if (f.kind === "toggle") await p.check(f.sel, true);
        else if (f.kind === "file") await p.upload(f.sel, sampleUploadFile(f.accept));
      } catch (e) {
        if ((e as Error).name === "OsWindowRequired") throw e;
        notes.push(`채우기 생략(${f.label}): ${String(e).slice(0, 80)}`);
      }
    }
    const before = await observe(p);
    await p.click(sel);
    const after = await settle(p, before);
    if (!changed(before, after).length) warns.push("유효한 값으로 제출했지만 화면 변화(성공 문구·이동)가 보이지 않음");
    else notes.push("제출 후 변화: " + changed(before, after).slice(0, 4).join(", "));
    return finish();
  }

  fail(`알 수 없는 probe 종류: ${kind}`);
  return { warns, notes };
}
