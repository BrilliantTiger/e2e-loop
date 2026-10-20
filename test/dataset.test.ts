// 오류 P: 판정식 안에 Dataset 전용 예외 목록을 박음 — 값은 Dataset 설정에서 읽고, 다른 Dataset 의 값이 박힌 판정식이 어긋나면 FAIL 이 아니라 NA(P).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillDataset, hardValues, hardValuesIn } from "../src/dataset.ts";
import { runCase } from "../src/runner.ts";
import { excludedRows, toolErrorCount } from "../src/toolerror.ts";
import * as A from "../src/actions.ts";
import { buildSheet } from "../src/sheet.ts";
import { Project } from "../src/store.ts";
import { fakeCtx } from "./helpers/fake.ts";
import type { Case, Config } from "../src/types.ts";

const DS: NonNullable<Config["datasets"]> = {
  가: { values: { notSent: ["te", "tv"] }, basis: "POL-048" },
  나: { values: { notSent: ["ta", "ti", "ts"], shared: ["cm"] }, basis: "POL-048" },
};
DS.가!.values!.shared = ["cm"];

test("{{dataset.<이름>}}: 글 전체면 값 그대로, 스크립트 안이면 JSON, 다른 글 안이면 글자로 넣고, 없는 이름은 알려 준다", () => {
  const prof = DS.나!;
  expect(fillDataset({ op: "collect", sel: "row", contains: "{{dataset.notSent}}" }, prof).step.contains).toEqual(["ta", "ti", "ts"]);
  expect(fillDataset({ op: "eval", script: "rows.filter((r) => !{{dataset.notSent}}.includes(r.table))", equals: [] }, prof).step.script).toBe('rows.filter((r) => !["ta","ti","ts"].includes(r.table))');
  expect(fillDataset({ op: "expect", sel: "#n", textContains: "안 보냄: {{dataset.notSent}}" }, prof).step.textContains).toBe("안 보냄: ta, ti, ts");
  expect(fillDataset({ op: "expect", sel: "#n", text: "{{dataset.none}}" }, prof).missing).toEqual(["none"]);
  expect(fillDataset({ op: "expect", sel: "#n", text: "{{dataset.notSent}}" }, undefined).missing).toEqual(["notSent"]);
});

test("박힌 Dataset 전용 값 찾기: 따옴표로 감싼 값만, 여러 Dataset 에 같이 있는 값은 「전용」이 아니라 세지 않는다", () => {
  const step = { op: "eval", script: "chips.filter((c, i) => c !== '성공' && !['te','tv'].includes(rows[i]) && rows[i] !== 'cm')", equals: [] };
  expect(hardValuesIn(step, DS).map((h) => `${h.dataset}.${h.key}=${h.value}`)).toEqual(["가.notSent=te", "가.notSent=tv"]);
  const hv = hardValues({ dataset: "나", steps: [step] }, DS);
  expect(hv.foreign.length).toBe(2);
  expect(hv.own.length).toBe(0);
  // 글자 조각이 우연히 겹친 것(따옴표 없음)은 세지 않는다
  expect(hardValuesIn({ op: "expect", sel: "#t", textContains: "tested" }, DS)).toEqual([]);
});

const mk = (id: string, dataset: string, script: string): Case => ({ id, title: id, type: "spec", source_ref: "기획서 1810", screen: "/handoff", feature: "Handoff 현황", chapter: "C18", dataset, steps: [{ op: "goto", url: "/handoff" }, { op: "eval", script, equals: [], basis: "POL-048" }] });

test("다른 Dataset 의 예외 목록을 박은 판정식이 어긋나면 FAIL 이 아니라 NA(P), 설정에서 읽으면 이 Dataset 의 의도된 「안 보냄」이 통과", async () => {
  // 화면: 「안 보냄」 줄이 나 의 ta·ti·ts (의도된 동작, POL-048)
  const notSent = ["ta", "ti", "ts"];
  const evaluate = async (expr: string): Promise<any> => {
    const m = /!(\[[^\]]*\])\.includes/.exec(expr);
    if (!m) return true;
    const allowed = JSON.parse(m[1]!.replace(/'/g, '"')) as string[];
    return notSent.filter((t) => !allowed.includes(t));
  };
  const ctx = fakeCtx({ evaluate });
  ctx.cfg.datasets = DS;
  const hard = await runCase(ctx, mk("P-1", "나", "rows.filter((r) => !['te','tv'].includes(r))"));
  expect(hard.status).toBe("NA");
  expect(hard.toolError?.kind).toBe("P");
  expect(hard.reason).toContain("가.notSent=te,tv");
  expect(toolErrorCount([hard])).toBe(1);
  expect(excludedRows([hard], () => "-", { round: "R09" })[0]!.kind).toBe("P");
  const read = await runCase(ctx, mk("P-2", "나", "rows.filter((r) => !{{dataset.notSent}}.includes(r))"));
  expect(read.status).toBe("PASS");
  // 설정에 값이 없으면 판정식을 채우지 못해 NA(P)
  const none = await runCase(ctx, mk("P-3", "다", "rows.filter((r) => !{{dataset.notSent}}.includes(r))"));
  expect(none.toolError?.kind).toBe("P");
  expect(none.reason).toContain("「notSent」");
  // 진짜 어긋남(박힌 값이 없는 판정식)은 그대로 FAIL
  const real = await runCase(ctx, mk("P-4", "나", "rows.filter((r) => !['xx'].includes(r))"));
  expect(real.status).toBe("FAIL");
});

test("e2e_dataset 으로 값·근거를 기록하고, 등록 때 박힌 값을 경고하며, 시트 「빈틈과 주의」에 표시한다", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-loop-ds-"));
  new Project(root).ensure();
  const r1 = A.aDataset({ project: root, name: "가", values: { notSent: ["te", "tv"] } });
  expect(r1.warns.join()).toContain("근거(basis");
  const r2 = A.aDataset({ project: root, name: "가", basis: "POL-048" });
  expect(r2.warns).toEqual([]);
  A.aDataset({ project: root, name: "나", values: { notSent: ["ta", "ti", "ts"] }, basis: "POL-048" });
  expect(Object.keys(new Project(root).config().datasets!)).toEqual(["가", "나"]);
  const up = A.aCaseUpsert({ project: root, cases: [mk("P-9", "나", "rows.filter((r) => !['te','tv'].includes(r))"), mk("P-10", "라", "rows.filter((r) => !{{dataset.notSent}}.includes(r))")] });
  expect(up.warns.join("\n")).toContain("P-9: 판정식에 Dataset 전용 값이 박혀 있음(가.notSent=te,tv) — 다른 Dataset 의 값");
  expect(up.warns.join("\n")).toContain("P-10: dataset 「라」 이 설정에 없음");
  const sheet = buildSheet(new Project(root));
  expect(sheet.gaps.datasetValues).toEqual([{ id: "P-9", detail: "가.notSent=te,tv", foreign: true }]);
  A.aDataset({ project: root, name: "가", remove: true });
  expect(Object.keys(new Project(root).config().datasets!)).toEqual(["나"]);
});
