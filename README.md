# cc-status

A clean, dependency-free **status line for [Claude Code](https://claude.com/claude-code)** that shows your
real usage at a glance — directly in the terminal footer, updated in real time.

```
Opus  ·  my-project  ·  ctx 35%  ·  70k/200k
5h ████░░░░░░ 24%      7d ████░░░░░░ 41%
```

- **Line 1** — model · current folder · **context window** of this session (percent **and** tokens).
- **Line 2** — your **5-hour** and **7-day (weekly)** usage windows, as colored bars + percent.

No `/usage` command, no desktop app, no log scraping. The 5h/weekly numbers come straight from the
official `rate_limits` field Claude Code passes to status line scripts — the same numbers `/usage` shows.

## Why

If you're on a Claude Max/Pro plan you constantly want to know *how close am I to the 5-hour and weekly
limits?* — without breaking flow to run `/usage`. This puts both windows permanently in your footer and
refreshes them automatically.

## Requirements

- **Claude Code ≥ 2.1.80** (when the `rate_limits` field was added to the status line input).
- A **Pro or Max** Claude.ai subscription — `rate_limits` is only populated for subscribers, and only
  after the first model response in a session. Before that (or on API-key billing) the bars show `--%`.
- **Node.js** on your PATH (Claude Code already requires it).

## Install

### Option A — installer (Windows / PowerShell)

```powershell
git clone https://github.com/wpt888/cc-status.git C:\Development\CC-status
cd C:\Development\CC-status
./install.ps1
```

The installer backs up your `~/.claude/settings.json` and inserts the `statusLine` block pointing at
`statusline.js`. Re-running it is safe (idempotent).

### Option B — manual

1. Put `statusline.js` somewhere stable (e.g. `C:\Development\CC-status\statusline.js`).
2. Add this to `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"C:/Development/CC-status/statusline.js\"",
       "refreshInterval": 30
     }
   }
   ```

   On macOS/Linux use the path to where you cloned it, e.g.
   `"command": "node \"$HOME/cc-status/statusline.js\""`.

3. Start a new Claude Code session — the footer now shows the two lines.

`refreshInterval: 30` re-runs the script every 30s so the 5h/weekly bars stay current even when you're
reading rather than prompting. Lower it for snappier updates; remove it to only refresh on activity.

## The data it reads (stdin contract)

Claude Code sends a JSON object on stdin. cc-status uses:

| Field | Used for |
|---|---|
| `model.display_name` | model label |
| `workspace.current_dir` (or `cwd`) | folder name |
| `context_window.used_percentage` | session context % |
| `context_window.total_input_tokens` / `context_window_size` | session context tokens |
| `rate_limits.five_hour.used_percentage` | 5-hour bar |
| `rate_limits.seven_day.used_percentage` | weekly bar |

Every field is read defensively — missing or `null` values degrade to `--%` / `0%` instead of crashing,
so the footer never breaks. See the [official statusline docs](https://code.claude.com/docs/en/statusline)
for the full contract.

## Color thresholds

Bars are colored by the percentage they represent: green `<50%`, yellow `50–64%`, orange `65–79%`,
red `≥80%`.

## License

MIT — see [LICENSE](./LICENSE).
