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

// Render a 10-segment bar for a 0–100 percentage.
// Filled portion is colored by threshold; the unused portion is a solid block
// in dim gray (no hatched `░` glyph — renders cleanly without GPU acceleration).
function bar(pct) {
  const p = clampPct(pct);
  const filled = Math.max(0, Math.min(10, Math.round(p / 10)));
  const c = pctColor(p);
  const filledBar = '█'.repeat(filled);
  const emptyBar = '█'.repeat(10 - filled);
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
  if (model) segs.push(`${ANSI.bold}${model}${ANSI.reset}`);

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
