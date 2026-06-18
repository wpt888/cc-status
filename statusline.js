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
//   Fix: a shared on-disk cache where any active window publishes its fresh
//   numbers and every window displays the freshest known. The 5h/7d windows are
//   SLIDING — the percentage can go DOWN within the same `resets_at` as old
//   usage ages out — so freshness must be decided by *observation time*, never
//   by magnitude (an earlier "higher is newer" guess latched onto the high-water
//   mark and never came back down).
//
//   We can't read a capture time off stdin directly, but Claude Code appends to
//   the session's `transcript_path` on every API response — so that file's mtime
//   is ~when this session last received `rate_limits`. We use it as an ABSOLUTE
//   observation timestamp: an idle session has an old transcript mtime, an active
//   one a fresh mtime. The cache keeps, per window, the entry with the newest
//   `observed_at` (a rolled window — greater `resets_at` — wins first). So stale
//   idle data can never overwrite fresh data, and a value that legitimately drops
//   within the same window is honored because its observation is more recent.

const TFIELD = ['five_hour', 'seven_day'];
const CACHE_PATH = path.join(os.homedir(), '.claude', 'cc-status-ratelimits.json');

// Read the shared cache: { windows: {five_hour, seven_day} }. Returns a
// well-formed empty shape on any error (missing/corrupt) — the cache is
// best-effort and must never break rendering.
function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw.replace(/^﻿/, ''));
    const windows = obj && typeof obj.windows === 'object' && obj.windows ? obj.windows : {};
    return { windows };
  } catch (_) {
    return { windows: {} };
  }
}

// Atomically write the cache back. Unique temp name (session + pid) avoids
// collisions between concurrent windows; rename is atomic on the OS. Any failure
// is swallowed — a lost write self-heals on the next tick.
function writeCache(cache, sessionId) {
  try {
    const tag = `${sessionId || 'x'}-${process.pid}`;
    const tmp = `${CACHE_PATH}.${tag}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (_) {
    /* best-effort */
  }
}

// When did this session last receive data? Transcript mtime ≈ last API response.
// Falls back to now if the path is missing/unreadable (treat as fresh).
function observedAt(transcriptPath, nowSec) {
  try {
    if (transcriptPath) return Math.floor(fs.statSync(transcriptPath).mtimeMs / 1000);
  } catch (_) {
    /* fall through */
  }
  return nowSec;
}

// Extract a {used_percentage, resets_at} pair for one window, or null if absent.
function getWin(rl, key) {
  const w = rl && rl[key];
  if (!w || typeof w.used_percentage !== 'number') return null;
  return {
    used_percentage: w.used_percentage,
    resets_at: typeof w.resets_at === 'number' ? w.resets_at : 0,
  };
}

// Pick the fresher of two timestamped window entries {used_percentage,
// resets_at, observed_at}. A rolled window (greater resets_at) always wins;
// within the same window the more recently OBSERVED value wins — even if its
// percentage is lower, which is the whole point for a sliding limit.
function fresherEntry(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.resets_at !== b.resets_at) return a.resets_at > b.resets_at ? a : b;
  return (a.observed_at || 0) >= (b.observed_at || 0) ? a : b;
}

// Merge this session's stdin snapshot into the shared cache using the transcript
// mtime as the observation time. Returns { rate_limits, cache, dirty }:
// rate_limits is what to render, cache is the object to persist, dirty whether a
// write is warranted.
function mergeRateLimits(stdinRL, cache, transcriptPath, nowSec) {
  const obs = observedAt(transcriptPath, nowSec);
  const windows = {};
  let dirty = false;
  for (const key of TFIELD) {
    const cached = cache.windows[key] || null;
    const mine = getWin(stdinRL, key);
    const myEntry = mine ? { ...mine, observed_at: obs } : null;
    const best = fresherEntry(myEntry, cached);
    if (best) windows[key] = best;
    if (best && best !== cached) dirty = true; // our value superseded the cache
  }
  return { rate_limits: windows, cache: { windows }, dirty };
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
      const res = mergeRateLimits(stdinRL, readCache(), data.transcript_path, nowSec);
      data.rate_limits = res.rate_limits;
      if (res.dirty) writeCache(res.cache, data.session_id);
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
