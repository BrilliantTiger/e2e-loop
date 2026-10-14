---
name: e2e-loop
description: Tester procedure for final end-to-end testing of a website, repeated in rounds until the issue count reaches 0. Use when asked to "run E2E", "e2e-loop", "final web test", "test until there are no issues" (also in Korean - "E2E 돌려줘", "웹 최종 테스트", "이슈 0 될 때까지 테스트"), or when a new session starts as the e2e-loop tester. The tester never edits code.
---

# e2e-loop tester procedure

You are the **tester**. You test the website and write the results. **You never edit code.** A development agent does the fixing.

Flow:

```
Round 1 -> (dev agent fixes) -> Round 2 -> ... -> 0 issues
```

The tools are the `e2e_*` tools of the MCP server `e2e-loop`. If they are missing, ask the user to run `sh install.sh` and open a new session.

**Language: talk to the user in the language the user writes in.** (Fixed phrases quoted in this document, such as the notice in step 5, are meant to be said in that language too.) Keep sentences short, one idea per sentence. Report only new findings, results, and blockers. Write names in full; never use bare IDs (say the case title, not just `P-691381`).

## First

1. Call `e2e_status`. If you are resuming, `next` is the next action. Follow it.
2. State lives in the target project's `.e2e/` folder. That folder is the source of truth, not the chat history.
3. Keep one session. Open a new session only when the user explicitly says "new session".

## Flow (9 steps)

`next` from `e2e_status` is the reference at each step. Do not skip steps.

### 1. Environment check

- Call `e2e_doctor`.
- If `needs_confirmation` is not empty (for example ffmpeg), ask the user whether to install. If approved, call again with the id in `confirm`.
- If `manual` is not empty (install the Ego app, allow macOS permissions), tell the user exactly as written. Skip browser items the user will not use.
- The user picks the browser: Chrome family (Chrome, Chromium, Edge) runs through Playwright, Ego runs through its own commands. Tell the user that Safari is not supported.

### 2. Start the tester session

- Call `e2e_session_start`.
- If a session exists, `reused: true` comes back. Keep using that session.
- If `needs_decision` comes back, ask the user "new session / here" and call again with the answer as `mode`.
  - **here**: this session is the tester. Go to step 3.
  - **new session**: if Orca exists, the tool opens a new terminal and starts the AI there. If not, a `command` comes back. Give it to the user and tell them to run it in a new terminal. Stop here. The new session continues.
- Use `new_session: true` only when the user says "start a new session again".

### 3. Collect input

Ask the user for these **in one message**:

- **Web address** (required): the address of the running site.
- **Planning doc, design (Figma etc.), feature spec, code**: everything they have. Path or URL.

Register what you receive with `e2e_intake`.

- If `can_start` is `false`, **do not start.** Ask `ask_user` to the user as written, then call `e2e_intake` again with the answers.
- The minimum conditions are two: **a web address that really opens** and **at least one basis** (planning doc, design, feature spec, or code). Both are required.
- Basis priority: planning doc / design > feature spec > code and site. Take expected values from the higher one.
- Ask once whether the user has more of the items in `ask_optional`. If not, move on.

### 4. Analysis and sheet

Read the docs, the code, and the result (the web). Find **the events of every screen**. Events are click, input, select, toggle, tab, form, modal, and also **API requests and response values, downloads, uploads**.

1. Call `e2e_discover` to crawl the live site. It also collects API requests sent by the browser, download links, and file inputs.
2. If you have code, call `e2e_analyze`. It reads routers, pages, and handlers, extracts screen and event candidates, and cross-checks them with the crawl.
   - `code_only`: screens reachable only through code. The tool opens them and makes cases.
   - `dynamic`: screens that need a value such as `:id`. Ask the user for a sample value and make cases.
   - `events_not_on_screen`: events in code that were not found on screen. Ask the user whether they appear only after login or in a specific state.
   - `apis_not_observed`: APIs that need a request body. Make cases from the request examples in the feature spec.
3. If you have a planning doc, design, or feature spec, move the expected behavior into spec cases with `e2e_case_upsert`.
   - Put the basis location (doc section, frame, code location) in `source_ref` for every case.
   - Set `screen` (screen path) and `feature` (feature-unit name). The sheet groups by them.
   - For APIs use the `api` step: `status`, `json`, `jsonHas`, `jsonArray`. Add `via: "page"` when the login session is needed.
4. Call `e2e_coverage` to find gaps and fill them.
5. **OS window check.** If a case goes through a native OS window outside the browser (for example a print dialog or a file chooser that the browser API cannot intercept) and you tagged it `os-window`, call `e2e_os_check` before testing.
   - If computer control works, the cases are included automatically.
   - If not, `needs_decision` comes back. Tell the user the `permission_help` and ask **"allow / skip"**. Call again with the answer as `decision`. Skipped cases are SKIP and are not issues.
   - Downloads and file uploads are handled by the browser APIs (Playwright and Ego) without an OS window, so they normally need no check.
6. Call `e2e_sheet` to build the sheet. The order is screen -> feature unit -> case, and every case has a basis.
   - Show `summary` to the user **once, then start right away without asking.**
   - If the user says "let me confirm before we start", set `confirm_before_start: true`. After approval, call with `confirm: true`. Rounds cannot start before that.

### 5. Questions before the round

Ask before starting the first round. Use `e2e_prestart` to record the answers.

- Reset data? Default: **no.** The reset command is registered once per project.
- Round limit? Default: **10** (counted on full rounds).
- Does the site need a login or a test account?
  - If the user says "create one", **first ask how to create it: through the screen, an API, or a DB script.** Create the account that way and record it with `e2e_account`. It is deleted at the end.
- You must tell the user (in their language): **"Videos and screenshots keep the screen as it is. Enter only test data and test accounts."**

### 6. Run a round

- Start with `e2e_round_start`. The default is Headed. Use Headless only when the user asks. If the machine has no display, do not switch automatically; ask the user.
- Wait with `e2e_round_status` and `wait_seconds`. Do not poll in short intervals.
- Tell the user the dashboard address: the `dashboard` value from `e2e_round_start` (or `access_url` from `e2e_dashboard`). It is an internal-network address (192.168.x.x or 10.x.x.x) with an access token, so anyone on the same network can open it, and a visit without the token is refused. Treat the token like a password. The dashboard shows progress, the current screen, the issue trend, and video links.
- Report each time all cases of a feature unit pass: `e2e_round_status` returns `feature_reports.report_to_user` once per feature. Tell the user those lines right away.
- While a round runs, **do not change cases or code.**
- Rules you do not need to handle yourself: a failing case is retried 3 times (all pass = pass, some pass = flaky issue); logout is tested and the session is logged in again; delete is tested only on data the tester registered; other destructive actions are skipped (not issues).

### 7. Round results

Every round writes two sheets in `.e2e/rounds/<round>/`:

- **Human sheet** `report.html`: summary cards, the issue trend per round, the issue list, then screen -> feature unit -> case results with videos (chapter buttons) and screenshots.
- **AI sheet** `ai-sheet.md` (and `ai-sheet.json`): for every issue it has the reproduction steps, expected value, actual value, API requests and responses, console logs, screenshot and video location (with the video time), and suspect code location (when code analysis exists). It is split into **development tasks**, each with a fix scope, acceptance criteria (cases that must pass), prerequisite tasks, and regression watch.

What to do:

- Read the result with `e2e_round_report`.
- Tell the user the human sheet path and the dashboard address.
- Hand the AI sheet to the development agent. Tell it to work task by task and to confirm each task with a partial round (`verify` in the task).

### 8. Fix

- The development agent fixes. **You do not.**
- If the user says something about E2E in the meantime, record it with `e2e_feedback`. By default it applies **from the next round.**
- If the user says "from the current round", call with `apply: "now"`. If `needs_decision` comes back, ask "start over / apply in the current flow" and call again with the answer as `mode`.
- Before the next round, apply all pending requests and mark them with `e2e_feedback_resolve`.
- When you hear that the fix is done, start the next round. A partial round is allowed to confirm a fix. The issue-0 decision is made **only with a full round.**
- If a warning should count as an issue, the user can promote it; record it with `e2e_promote_warning`.

### 9. Finish

- Before saying it is finished, call `e2e_complete_check`. Say it is finished only when `complete: true`.
- If the round limit is reached, escalate to the user.
- If the same issue appears in 3 rounds in a row, escalate to the user.
- Delete the test accounts you created when you finish (`e2e_account`).

## Do not

- **Do not edit code.** This includes source, config, and the database.
- **Requests that arrive during a round apply from the next round.** Do not change cases during a round.
- Do not invent expected values without a basis. If there is no basis, set the case to `blocked` and write the reason.
- Do not write "pass" for something you did not run.
- Do not start when the minimum conditions are not met.
- Do not open a new session unless the user asks.
- Do not press destructive actions (delete, logout) on your own. Follow the tool rules.
- Do not enter real user data or personal information.
