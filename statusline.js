#!/usr/bin/env node
'use strict';

/*
 * cc-status — a two-line status line for Claude Code that shows:
 *   Line 1: model · folder · current-session context (percent + tokens)
 *   Line 2: 5-hour usage bar + percent · 7-day (weekly) usage bar + percent
 *
 * It reads the session JSON from stdin (the contract Claude Code passes to
 * `statusLine` commands) and prints the rendered status line to stdout.
 *
 * The 5h / weekly numbers come straight from the official `rate_limits` field
 * (the same numbers shown by `/usage`), available to Pro/Max subscribers on
 * Claude Code >= 2.1.80. No log scanning, no API calls.
 *
 * Docs: https://code.claude.com/docs/en/statusline
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- cross-session rate-limit cache -----------------------------------------
//
// Why this exists:
//   `rate_limits` on stdin comes from the most recent API response *of this
//   session* and only appears after that session's first API call. So an idle
//   window (no recent prompts) shows a FROZEN snapshot — re-running the script
//   on `refreshInterval` re-renders the same stale numbers because the input
//   never changes. Meanwhile the 5h/7d limits are account-global: another,
//   active window already knows fresher values.
//
//   Fix: every invocation merges its stdin snapshot with a shared on-disk cache
//   and writes back the freshest. An active window publishes fresh numbers; an
//   idle window picks them up on its next refresh tick. The whole account
//   converges to one truth instead of each window showing its own last-seen.

const CACHE_PATH = path.join(os.homedir(), '.claude', 'cc-status-ratelimits.json');

// Read the shared cache. Returns {} on any error (missing/corrupt) — the cache
// is best-effort and must never break rendering.
function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw.replace(/^﻿/, ''));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

// Atomically write the merged snapshot back. Unique temp name (session + pid)
// avoids collisions between concurrent windows; rename is atomic on the OS.
// Any failure is swallowed — a write loss self-heals on the next tick.
function writeCache(rl, sessionId) {
  try {
    const tag = `${sessionId || 'x'}-${process.pid}`;
    const tmp = `${CACHE_PATH}.${tag}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rl), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (_) {
    /* best-effort */
  }
}

// Is this window snapshot usable? A window whose reset time is already in the
// past has rolled over, so its percentage is stale by definition.
function isLiveWindow(w, nowSec) {
  return (
    w &&
    typeof w.used_percentage === 'number' &&
    (typeof w.resets_at !== 'number' || w.resets_at > nowSec)
  );
}

// Pick the fresher of two snapshots for ONE window (five_hour / seven_day).
// Monotonic freshness without a capture timestamp:
//   - later resets_at  => newer rolling window  => fresher
//   - same resets_at   => usage only grows      => higher used_percentage is later
// An expired window (resets_at <= now) loses to any live one automatically,
// because a live window's resets_at is in the future and thus larger.
function fresherWindow(a, b, nowSec) {
  const aLive = isLiveWindow(a, nowSec);
  const bLive = isLiveWindow(b, nowSec);
  if (!aLive) return bLive ? b : null;
  if (!bLive) return a;
  const ar = typeof a.resets_at === 'number' ? a.resets_at : 0;
  const br = typeof b.resets_at === 'number' ? b.resets_at : 0;
  if (ar !== br) return ar > br ? a : b;
  return a.used_percentage >= b.used_percentage ? a : b;
}

// Merge stdin rate_limits with the cached ones, per window. Returns the merged
// object plus whether stdin contributed anything new (so we only write when we
// actually have fresher data — keeps idle windows from churning the file).
function mergeRateLimits(stdinRL, cacheRL, nowSec) {
  const out = {};
  let changed = false;
  for (const key of ['five_hour', 'seven_day']) {
    const s = stdinRL && stdinRL[key];
    const c = cacheRL && cacheRL[key];
    const winner = fresherWindow(s, c, nowSec);
    if (winner) out[key] = winner;
    // We hold fresher data than the cache when stdin won (and differs from cache).
    if (winner && winner === s && winner !== c) changed = true;
  }
  return { merged: out, changed };
}

// ---- ANSI helpers -----------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m', // dim track for the unused portion of a bar
};

const DOT = ` ${ANSI.dim}·${ANSI.reset} `;

// Pick a color for a 0–100 usage percentage.
function pctColor(pct) {
  if (pct >= 80) return ANSI.red;
  if (pct >= 65) return ANSI.orange;
  if (pct >= 50) return ANSI.yellow;
  return ANSI.green;
}

// Color for the reasoning-effort label. Deliberately NOT the same ramp as the
// usage bars (green/yellow/orange/red mean "near the limit" there) — reusing
// those would make a normal "high" look like a warning. Cyan reads as neutral
// info for the common low/medium/high; warm tones only at xhigh/max, where the
// effort genuinely burns more tokens.
function effortColor(level) {
  switch (level) {
    case 'low': return ANSI.gray;
    case 'medium': return ANSI.green;
    case 'high': return ANSI.cyan;
    case 'xhigh': return ANSI.orange;
    case 'max': return ANSI.red;
    default: return ANSI.cyan;
  }
}

// ---- formatting -------------------------------------------------------------

// 70000 -> "70k", 1_500_000 -> "1.5M", 850 -> "850"
function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
  }
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

// Render a 10-segment line bar for a 0–100 percentage.
// Used portion is a heavy line (━) colored by threshold; the unused portion is
// a thin line (─) in dim gray. No hatched glyphs — clean without GPU acceleration.
function bar(pct) {
  const p = clampPct(pct);
  const filled = Math.max(0, Math.min(10, Math.round(p / 10)));
  const c = pctColor(p);
  const filledBar = '━'.repeat(filled);
  const emptyBar = '─'.repeat(10 - filled);
  return `${c}${filledBar}${ANSI.gray}${emptyBar}${ANSI.reset} ${c}${Math.round(p)}%${ANSI.reset}`;
}

function clampPct(p) {
  if (typeof p !== 'number' || !isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

// basename that works for both / and \ separators (Windows-friendly).
function baseName(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// ---- line builders ----------------------------------------------------------

function buildContextLine(data) {
  const segs = [];

  const model = data && data.model && data.model.display_name;
  if (model) {
    let modelSeg = `${ANSI.bold}${model}${ANSI.reset}`;
    // effort is absent when the current model doesn't support the parameter.
    const effort =
      data && data.effort && typeof data.effort.level === 'string' ? data.effort.level : null;
    if (effort) {
      modelSeg += ` ${effortColor(effort)}${effort}${ANSI.reset}`;
    }
    segs.push(modelSeg);
  }

  const dir = baseName((data && data.workspace && data.workspace.current_dir) || data.cwd);
  if (dir) segs.push(`${ANSI.dim}${dir}${ANSI.reset}`);

  const cw = (data && data.context_window) || {};
  // used_percentage may be null early in a session.
  const ctxPct = typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage) : null;
  const used = typeof cw.total_input_tokens === 'number' ? cw.total_input_tokens : null;
  const size = typeof cw.context_window_size === 'number' ? cw.context_window_size : null;

  if (ctxPct !== null) {
    const c = pctColor(ctxPct);
    let ctxStr = `${ANSI.dim}ctx${ANSI.reset} ${c}${ctxPct}%${ANSI.reset}`;
    if (used !== null && size !== null) {
      ctxStr += `${DOT}${ANSI.dim}${fmtTokens(used)}/${fmtTokens(size)}${ANSI.reset}`;
    } else if (used !== null) {
      ctxStr += `${DOT}${ANSI.dim}${fmtTokens(used)}${ANSI.reset}`;
    }
    segs.push(ctxStr);
  } else {
    segs.push(`${ANSI.dim}ctx --%${ANSI.reset}`);
  }

  return segs.join(DOT);
}

function buildLimitsLine(data) {
  const rl = (data && data.rate_limits) || {};

  function window(label, key) {
    const w = rl[key];
    if (!w || typeof w.used_percentage !== 'number') {
      return `${ANSI.dim}${label} --%${ANSI.reset}`;
    }
    return `${ANSI.dim}${label}${ANSI.reset} ${bar(w.used_percentage)}`;
  }

  const fiveHour = window('5h', 'five_hour');
  const weekly = window('7d', 'seven_day');
  return `${fiveHour}    ${weekly}`;
}

// ---- main -------------------------------------------------------------------

function render(data) {
  const line1 = buildContextLine(data);
  const line2 = buildLimitsLine(data);
  return `${line1}\n${line2}`;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let data = {};
    try {
      data = JSON.parse(raw.replace(/^﻿/, '') || '{}');
    } catch (_) {
      data = {};
    }

    // Merge this session's (possibly frozen) rate_limits with the account-wide
    // shared cache so idle windows still show the freshest known numbers.
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const stdinRL = (data && data.rate_limits) || {};
      const { merged, changed } = mergeRateLimits(stdinRL, readCache(), nowSec);
      data.rate_limits = merged;
      if (changed) writeCache(merged, data.session_id);
    } catch (_) {
      /* if the merge fails, fall back to whatever stdin gave us */
    }

    try {
      process.stdout.write(render(data));
    } catch (_) {
      // Never break the footer — emit something minimal.
      process.stdout.write('cc-status');
    }
  });
  // If stdin never closes (shouldn't happen), don't hang forever.
  process.stdin.on('error', () => process.stdout.write('cc-status'));
}

main();
