# cc-status

A clean, dependency-free **status line for [Claude Code](https://claude.com/claude-code)** that shows your
real usage at a glance — directly in the terminal footer, updated in real time.

```
Opus high  ·  my-project  ·  ctx 35%  ·  70k/200k
5h ████░░░░░░ 24%      7d ████░░░░░░ 41%
```

- **Line 1** — model + **reasoning effort** · current folder · **context window** of this session
  (percent **and** tokens).
- **Line 2** — your **5-hour** and **7-day (weekly)** usage windows, as colored bars + percent.

The effort label (`low` / `medium` / `high` / `xhigh` / `max`) sits right after the model name and
reflects the live `/effort` setting — handy because higher effort burns through your limits faster. It's
colored on its own neutral-to-warm ramp (cyan for the common `high`, warm tones at `xhigh`/`max`) so it
never gets mistaken for the usage-bar warning colors. It disappears for models that don't support effort.

No `/usage` command, no desktop app, no log scraping. The 5h/weekly numbers come straight from the
official `rate_limits` field Claude Code passes to status line scripts — the same numbers `/usage` shows.

### Always-fresh across windows

Claude Code only hands a script the `rate_limits` from **the current session's most recent API
response** — so an idle window (one you're reading, not prompting in) sees a *frozen* snapshot and would
otherwise show stale numbers for hours, even though another active window already knows the real
account-wide usage. cc-status fixes this by syncing through a tiny shared cache
(`~/.claude/cc-status-ratelimits.json`): every render merges this session's snapshot with the cache and
keeps the **freshest** value per window, so any active window's fresh numbers propagate to all the others
on their next refresh.

Freshness is decided by **observation time**, not by magnitude. The 5h/7d windows are *sliding* — the
percentage can go **down** within the same `resets_at` as older usage ages out — so "the bigger number is
newer" would be wrong and would latch onto a high-water mark forever. Instead, each session's observation
is timestamped with its `transcript_path` file's mtime (Claude Code appends to the transcript on every API
response, so its mtime ≈ when that session last saw `rate_limits`). The most recently observed value wins,
and a rolled window — a later `resets_at` — always wins first. An idle window's stale numbers therefore
can never overwrite a fresh window's, and a legitimate drop is honored.

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
       "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Development/CC-status/statusline.js\"",
       "refreshInterval": 10
     }
   }
   ```

   **Use an absolute path to `node.exe`, not a bare `node`.** Claude Code spawns the status-line
   command in whatever environment launched the session, and a bare `node` only works if it happens to
   be on that environment's `PATH`. With nvm-for-windows (or any multi-version setup) `PATH` is not
   guaranteed in every terminal/IDE, so a bare `node` makes the line render in some directories and
   silently vanish in others. Pinning the interpreter removes that dependency. Find your node with
   `(Get-Command node).Source`, preferring a stable system install like `C:\Program Files\nodejs`.

   On macOS/Linux use absolute paths too, e.g.
   `"command": "/usr/local/bin/node \"$HOME/cc-status/statusline.js\""` (`which node` to find it).

3. Start a new Claude Code session — the footer now shows the two lines.

`refreshInterval: 10` re-runs the script every 10s so an idle window picks up the freshest account-wide
5h/weekly numbers from the shared cache within ~10s, instead of waiting for its own next prompt. Raise it
to spawn the script less often; remove it to only refresh on activity (the cross-window sync still works,
just on each event rather than on a timer).

## The data it reads (stdin contract)

Claude Code sends a JSON object on stdin. cc-status uses:

| Field | Used for |
|---|---|
| `model.display_name` | model label |
| `effort.level` | reasoning-effort label after the model |
| `workspace.current_dir` (or `cwd`) | folder name |
| `context_window.used_percentage` | session context % |
| `context_window.total_input_tokens` / `context_window_size` | session context tokens |
| `rate_limits.five_hour.used_percentage` / `.resets_at` | 5-hour bar + window identity |
| `rate_limits.seven_day.used_percentage` / `.resets_at` | weekly bar + window identity |
| `transcript_path` | mtime = observation time for cross-window freshness |

Every field is read defensively — missing or `null` values degrade to `--%` / `0%` instead of crashing,
so the footer never breaks. See the [official statusline docs](https://code.claude.com/docs/en/statusline)
for the full contract.

## Color thresholds

Bars are colored by the percentage they represent: green `<50%`, yellow `50–64%`, orange `65–79%`,
red `≥80%`.

## License

MIT — see [LICENSE](./LICENSE).
