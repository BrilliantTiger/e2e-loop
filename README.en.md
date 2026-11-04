# e2e-loop

An MCP tool and skill that repeats the final web E2E test in **rounds until the issue count reaches 0**.

```
round 1 → fix → round 2 → fix → round 3 → … → 0 issues
```

- 한국어: [README.md](README.md)
- Requirements (confirmed, in Korean): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- Status: in development. Built and pushed one feature at a time.

## Language

Reports, the dashboard, the AI sheets, the judgement reasons, and the tool messages come in **Korean (default) or English**.

- Per project: `e2e_init lang=en` or `e2e_prestart lang=en` (CLI: `bun src/cli.ts init --lang en`). The tester agent sets this from the language the user writes in.
- Default for this install (MCP tool descriptions, CLI help, environment check, and projects without `lang`): `sh install.sh --lang en`, or the environment variable `E2E_LOOP_LANG=en`. The system locale is not used.
- Rounds that already ran keep the language they were written in. A new export (`e2e_report_export`) redraws the report in the current language, but reasons recorded during the round stay as they were.

## Supported browsers

Every Chrome-based browser (Chrome, Chromium, Edge, and so on) through Playwright, and Ego through its own API. The user picks one. **Safari is not supported.**

## Install

```sh
git clone git@github.com:BrilliantTiger/e2e-loop.git
cd e2e-loop
sh install.sh --lang en
```

What `install.sh` does:

1. Installs `bun` if it is missing. **Bun 1.4.3 or later** is needed (on 1.3.10 the browser silently disappeared during a round and the round stopped). If it is older, run `bun upgrade`. `e2e_doctor` (`bun src/cli.ts doctor`) checks the version and warns.
2. Installs the dependencies with `bun install`.
3. Checks the environment: Playwright browsers, Chrome, Edge, Ego, ffmpeg, git, Orca, macOS permissions.
4. **Installs missing Playwright browsers automatically.**
5. **Things that need a question before installing, such as ffmpeg,** are not installed; they come back as questions. To approve: `sh install.sh --confirm ffmpeg`.
6. Registers the e2e-loop MCP server in **every installed client** (Claude Code, Codex). Skips clients that already have it.
7. Links the tester skill (`skills/e2e-loop`) into Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`). A `git pull` of this repository updates the skill too. If a real folder with the same name exists, it is not overwritten; you are told instead.
8. Things you must do yourself (install the Ego app, allow macOS permissions) are only explained.

To check only: `bun src/cli.ts doctor`. To see the plan only: `--dry-run`.

### Tester session

The E2E test is run by **an AI in a new session (the tester)**, not by the agent that edits the code.

- `e2e_session_start`: if Orca is available, starts the AI in a new terminal. If not, asks "new session / here"; for "new session" it gives the command to run. An existing session is kept (only `new_session` starts another one, when the user asks for it).
- `e2e_intake`: takes the web address and the plan, design, feature spec, or code, and checks the **minimum conditions** (a web address that really opens + at least one basis). If they are not met, it does not start and asks the user.
- The state is in the target project's `.e2e/session.json`, `.e2e/intake.json`, and `.e2e/sources.json`.
- From a terminal: `bun src/cli.ts session --mode new`, `bun src/cli.ts intake --baseUrl URL --materials '[{"kind":"plan","location":"docs/plan.md"}]'`

### Analysis and the test sheet

- `e2e_discover`: walks the site and collects clicks, inputs, selects, toggles, tabs, forms, and modals, plus **API requests and responses (fetch, XHR), download links, and file inputs**.
- `e2e_analyze`: extracts screens, events, APIs, and download/upload candidates from the code (Next, React Router, Vue Router, Nuxt, SvelteKit, static HTML) and compares them with the site walk. A screen that is in the code but not reachable by a link becomes a case that opens it directly. Add new frameworks to `ROUTE_EXTRACTORS` in `src/analysis/code.ts`.
- `e2e_os_check`: before testing, checks whether downloads and file pickers go through an OS window outside the browser. Not needed for Chrome-based browsers (Playwright handles them). If computer control does not work with Ego, explains the permission and asks whether to allow or skip.
- `e2e_sheet`: builds the test sheet (`.e2e/sheet.md`) grouped as screen → feature unit → case. Every case has a basis (a document section or a code location). It shows a summary once and starts; use `confirm_before_start` to start only after a confirmation.

### Running a round

- Questions before starting, `e2e_prestart`: data reset (default: no reset; the reset command is registered once per project), round limit (default 10, only full rounds count), login and test accounts, the notice "videos and screenshots keep the screen as it is, so enter only test data and test accounts", and the output language. `e2e_round_start` does not start until these are done.
- When every case of a feature unit passes, it is reported right away: the dashboard log shows "feature done", and `feature_reports.report_to_user` in `e2e_round_status` reports it once (a feature with a failure is not reported).
- Headed by default. Headless only when asked with `headless=true`. Without a display (Linux, no DISPLAY) it asks instead of switching on its own.
- Issue = failed + flaky + unverified (BLOCKED) + warnings the user promoted (`e2e_promote_warning`). **A skip is not an issue.** A failed case runs 3 more times: all pass = pass, some pass = flaky (an issue), all fail = fail. If the same issue appears in 7 rounds in a row (`repeatLimit`, default 7), the user is told.
- Destructive actions: logout is tested and the tester logs in again (when `auth.setupSteps` exists). Delete is pressed only on rows that hold data the tester entered; other deletes and destructive actions are skipped (all of them run in a data-reset round).
- A partial round (`only`, `onlyFailed`) is for confirming a fix. The 0-issue decision and the end are made only with a full round. A code change during a round does not invalidate it.
- Evidence: video is recorded as mp4 (h264); idle waits are shortened and a chapter file (`*.chapters.txt`) is written. Screenshots and videos get a stamp "commit | time | case id | original sha256", and the round's `evidence.json` lists the final file hashes. Evidence is kept per round; from 80% of the limit (default 4096 MB) you are told, and `e2e_evidence` cleans up. ffmpeg is needed.
- Ego: navigation, clicks, input, API, upload, and download run through Ego's own API. Video is made from **the page of the Ego workspace (space), taken directly inside the browser (CDP screencast)** (Ego is Chromium-based). It records even when the window is covered or another task is in front, and needs no screen-recording permission. Frames arrive only when the screen changes, so still parts cost no space. The frame cap is `videoFps` (default **60 fps**); frames are encoded at the time they were taken into mp4 (h264), then processed like the Chrome path (shortened waits, chapters, stamp). The Chrome path uses the same method instead of Playwright's built-in recording (fixed 25 fps), so both paths produce the same video. Screenshots are taken the same way.
- Test accounts: when asked to create one, it first asks how (screen, API, or DB script), records it with `e2e_account`, and deletes it at the end.

### User requests

What the user says about the E2E test between rounds (or during one) is recorded with `e2e_feedback` in `.e2e/feedback.json`. The tester session stays one session, so whichever agent received it, `e2e_status` reports the same record.

- By default a request applies **from the next round**. The running round is not touched.
- If the user says "from the current round", it **first asks "start over / apply in the current flow"** (`needs_decision`) and applies the answer (`mode`).
  - `restart`: stops the round (a stopped round does not count toward the limit), applies the request, and runs from the start.
  - `in-flow`: appends the cases to the same round. Cases that already ran do not get the change, so that round is not proof of completion; one more full round is needed.
- **The next round cannot start until the requests are applied and marked with `e2e_feedback_resolve`.** The round results list the requests applied in that round.

### Dashboard

`e2e_dashboard` (or `dashboard` in `e2e_round_start`) serves the dashboard on the **LAN IP** (192.168.x.x · 10.x.x.x), not localhost, so other devices on the same network can open it. It shows the progress, the current screen, the issue flow chart, the issue history per round, and video links.

- Only the address with the access token (`access_url`) gets in; **access without the token is refused** (401). Treat the token like a password. It is kept in the project's `.e2e/dashboard-token`; `rotate_token` changes it.
- When you come in through the address, the token is moved into a cookie and removed from the address. More than 20 wrong attempts in a minute are blocked for a while.
- With several LAN IPs, the first is used and the others are listed in `alternatives` (choose with `host`). Without a LAN IP, you are warned that only this computer can connect.
- Videos support seeking (Range). The notice "enter only test data and test accounts" is always shown.

### Dashboard issue comments

On an issue row (failed, flaky, or unverified) of the dashboard, press **💬** to leave a comment (a name is optional). The AI reads it and responds.

**The server sets the role from the access token.**

| Role | Address | What it can do |
|---|---|---|
| viewer | `access_url` (give it to people who watch) | Comment. The AI reads these comments as **untrusted input** and does not edit code or run commands because a comment says so |
| owner | `owner_url` (only the AI's owner; do not share) | Comment + **"🔧 fix instruction"**. The AI follows it as the development agent (edit code → confirm with a partial round → reply with the result). No commit or push unless told |

- Writing "I am the owner" in a comment does nothing. `instruct` is accepted only from requests with the owner token. The owner address is plain HTTP, so use it only on a trusted network.
- When a comment arrives, the tester session's Orca terminal gets a "N new comments" notice (without the content, at most once per 60 s). If the terminal is unknown, `comments_open` in `e2e_status` and `e2e_round_status` reports it.
- The AI reads with `e2e_comments` and answers with `reply`. The answer appears under the comment. The comments are also in the issue's AI sheet.
- Commenting needs the access token, accepts only JSON with a dedicated header from the same origin, and is limited to 2000 characters and 10 comments a minute. The page shows comments as plain text. They are stored in `.e2e/comments.json`.

**Receiving comments while no session is open — standalone dashboard.** `e2e_dashboard standalone=true` (or `bun src/cli.ts dashboard --project <path>`) runs the dashboard as a process separate from the AI session, so it keeps receiving comments even if the session is closed for days. To stop it: `e2e_dashboard stop=true`.

**Automatic replies (off by default).** For every comment, a one-shot AI (`claude -p` or `codex exec`) runs and replies. This uses your plan and has no call limit, so turn it on with `commentResponder` in `e2e_prestart` only when the user asks for it.

- `answer`: reads the code, the AI sheet, and the case definitions, analyzes, and only replies. Editing and running tools are blocked (Claude: by tool name; Codex: read-only sandbox).
- `fix`: answer + a development one-shot AI carries out the owner's fix instructions as code changes (writes to the working folder, only `git status/diff/log`, no commit or push).
- Comments that arrive in a burst are collected for `batchSeconds` (default 30 s) and handled together, one run at a time. Each comment gets at most 2 reply attempts (so an AI that cannot reply does not loop forever). Run logs are in `.e2e/responder/`.
- The prompt does not contain the comment text; the AI reads it with a tool. `claude` or `codex` must be logged in on this computer.

### Round results

Every round writes two sheets in `.e2e/rounds/<round>/`.

- **Human sheet** `report.html`: summary, the issue flow chart per round (above the axis: still open, reopened, new; below the axis: fixed) with the trend table, the issue history (for every case that was ever an issue: its status in each round, the round it first appeared, the round it was fixed), this round's issues, and screen → feature unit → case results (with video chapter buttons and screenshots).
- **AI sheet** `ai-sheet.md` (to read) and `ai-sheet.json` (structured): for every issue, the reproduction steps, expected value, actual value, API requests and responses, console logs, screenshot and video location (with the video time), and suspect code location (when code analysis exists). It is split into **development tasks** (fix scope, acceptance criteria = cases that must pass, prerequisite tasks, regression watch, how to verify) so development can go step by step. The same cause (same API, same JS error) is one task, and API tasks come first. Unverified cases become a separate "user / environment action" task, not a code fix.

### Export a report

Exports a finished round's report as files in `.e2e/rounds/<round>/export/`.

```sh
bun src/cli.ts export --project <path> [--round R03] [--format pdf,csv,html]   # defaults: the last finished round, all three
```

- **PDF** `report-<round>.pdf`: an A4 document with the chart, the trend table, the issue history, and the issue cases' screenshots.
- **CSV for Excel**, three files: `issues-` (this round's issues), `history-` (each issue's status per round), `rounds-` (counts per round). Written as UTF-8 with BOM so Excel shows non-ASCII text correctly.
- **Single-file HTML** `report-<round>.html`: screenshots are inside the file, so it opens anywhere, for example from an email.

The PDF and the single-file HTML include only the issue cases' screenshots (up to 40 MB in total) and no videos. Videos stay in the round folder. The MCP tool is `e2e_report_export`; on the dashboard, use the "Export" links in the header.

### About Ego

Ego is not an MCP server; it works as **a skill + the `ego-browser` command**. e2e-loop uses that command directly, so no MCP registration is needed for Ego. Install: <https://lite.ego.app/> → open the app and finish the first-run onboarding; the `ego-browser` command is then on the PATH (macOS only).

### Computer control

Needed only when the sheet has OS windows outside the browser (downloads, file pickers). There is no package to install; turn on the computer-control feature of your client (built into the Codex app, a standard integration in Claude Code). `doctor` checks that it is visible and explains how to grant permission if not.

## Development

```sh
bun test            # tests (environment check and registration use fake commands; real config files are not touched)
bun run typecheck
bun test/demo.ts    # demo site with planted bugs: round 1 fails → fix → round 2 passes
```
