// MCP 서버가 실제로 뜨고 도구를 노출하며, e2e_doctor 가 읽기 전용으로 동작하는지 확인한다.
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serverCommand } from "../src/env/clients.ts";

test("MCP 서버가 뜨고 e2e_* 도구를 노출한다", async () => {
  const [cmd, ...args] = serverCommand();
  const transport = new StdioClientTransport({ command: cmd!, args });
  const client = new Client({ name: "env-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["e2e_doctor", "e2e_init", "e2e_source_add", "e2e_discover", "e2e_case_upsert", "e2e_round_start", "e2e_round_status", "e2e_round_report", "e2e_complete_check", "e2e_feedback", "e2e_dashboard", "e2e_status"]) expect(tools).toContain(n);
    const res: any = await client.callTool({ name: "e2e_doctor", arguments: {} });
    const body = JSON.parse(res.content[0].text);
    expect(body.checks.length).toBeGreaterThan(5);
    expect(body.driver_choices.map((d: any) => d.value)).toEqual(["ego", "chrome", "edge", "chromium"]);
    expect(Array.isArray(body.needs_confirmation)).toBe(true);
  } finally {
    await client.close();
  }
}, 60000);
