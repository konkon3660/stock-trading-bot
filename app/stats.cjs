'use strict';
// 봇 기록 폴더(orb/data-*)에서 손익·거래·보유를 읽어요. 읽기만 해요.
const fs = require('node:fs');
const path = require('node:path');
const { BOTS, readJson } = require('./supervisor.cjs');
const FLAGS = [...BOTS.map(b => b.stopFile), 'FLATTEN_GAP']; // 화면에서 켜고 끌 수 있는 정지 파일

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(v => v !== ''));
  if (!head) return [];
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}
function readCsv(file) { try { return parseCsv(fs.readFileSync(file, 'utf8')); } catch { return []; } }
const num = v => { const s = String(v ?? '').replace(/[%$,]/g, '').trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const pick = (row, ...names) => { for (const n of names) { const k = Object.keys(row).find(h => h === n || h.startsWith(n)); if (k && row[k] !== '') return row[k]; } return ''; };

function trade(key, mode, r) {
  return {
    bot: key, mode,
    date: pick(r, '날짜'),
    time: pick(r, '청산(KST)', '시각(KST)'),
    sym: pick(r, '종목'),
    reason: pick(r, '청산사유', '사유'),
    qty: num(pick(r, '매도수량', '수량')),
    pnl: num(pick(r, '손익USD')),
    ret: pick(r, '수수료후수익률', '수익률', '판단수익률'),
    // 차트에 산 곳·판 곳·목표·손절 표시용 (보유 관리 기록엔 산 곳이 없음)
    buyTime: pick(r, '체결(KST)'), buyPx: num(pick(r, '체결가')), sellPx: num(pick(r, '청산가', '매도평균가')),
    level: num(pick(r, '지정가')), target: num(pick(r, '목표가')), stop: num(pick(r, '손절가')),
  };
}

// 갭 봇 후보 보드: 가장 최근 밤에 찾은 후보와 각 후보가 어떻게 됐는지 (events.log 끝부분을 읽음)
function gapBoard(dir) {
  const yr = new Date().getFullYear(), soon = Date.now() + 86_400_000;
  const tOf = s => { const ms = Date.parse(`${yr}-${s.slice(0, 5)}T${s.slice(6)}+09:00`); return ms > soon ? Date.parse(`${yr - 1}-${s.slice(0, 5)}T${s.slice(6)}+09:00`) : ms; };
  const rows = tail(path.join(dir, 'events.log'), 800, 160 * 1024).map(l => { const m = /^\[(\d\d-\d\d \d\d:\d\d:\d\d)\] (.*)$/.exec(l); return m && { t: tOf(m[1]), msg: m[2] }; }).filter(Boolean);
  let i = rows.length - 1; while (i >= 0 && !/^후보 찾기: .* \d+개: /.test(rows[i].msg)) i--;
  if (i < 0) return null;
  const night = rows.filter(r => r.t > rows[i].t - 2 * 3_600_000 && r.t < rows[i].t + 12 * 3_600_000);
  const list = new Map(); let first = Infinity;
  for (const r of night) if (/^후보 찾기:/.test(r.msg)) for (const m of r.msg.matchAll(/([A-Z0-9.]+)\(갭 ([\d.]+)%, 전일종가 \$([\d.]+)\[[^\]]*\], 시가 \$([\d.]+), 지정가 \$([\d.]+)/g)) {
    first = Math.min(first, r.t);
    if (!list.has(m[1])) list.set(m[1], { s: m[1], gap: Number(m[2]) / 100, pc: Number(m[3]), o: Number(m[4]), level: Number(m[5]), status: 'seen' });
  }
  const set = (s, st) => { const c = list.get(s); if (c) c.status = st; };
  for (const { msg } of night) {
    let x;
    if ((x = /^(\S+) (?:실제 )?지정가 매수 주문/.exec(msg))) set(x[1], 'ordered');
    else if ((x = /^(\S+) (?:실제 )?매수 체결/.exec(msg))) set(x[1], 'held');
    else if ((x = /^(\S+) 청산\(/.exec(msg))) set(x[1], 'closed');
    else if ((x = /^(\S+): .*이미 지정가/.exec(msg))) set(x[1], 'missed');
    else if ((x = /^(\S+): 나눈 돈/.exec(msg))) set(x[1], 'nocash');
    else if ((x = /^(\S+) (?:매수 주문 취소됨|14:30까지 지정가 안 닿음|매수 주문이 \S+ 상태로 끝남)/.exec(msg))) set(x[1], 'expired');
    else if ((x = /^오늘 주문 \d+개를 다 써서 안 삼: (.*)$/.exec(msg))) for (const s of x[1].split(', ')) set(s, 'full');
  }
  const open = Math.floor((first - 20_000) / 1_800_000) * 1_800_000; // 첫 후보 찾기(9:30:20쯤) → 9:30
  return { date: new Date(open).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), open, list: [...list.values()].sort((a, b) => b.gap - a.gap) };
}

function summary(root, key, mode) {
  const dir = path.join(root, 'orb', `data-${key}${mode === 'live' ? '-live' : ''}`);
  if (!fs.existsSync(dir)) return null;
  const state = readJson(path.join(dir, 'state.json'), null);
  const trades = readCsv(path.join(dir, 'trades.csv')).map(r => trade(key, mode, r)).filter(t => t.date);
  const days = state?.days || {};
  const dates = [...new Set([...Object.keys(days), ...trades.map(t => t.date)])].sort();
  const latest = dates[dates.length - 1] || null;
  const dayTrades = trades.filter(t => t.date === latest);
  const sum = list => list.reduce((a, t) => a + (t.pnl ?? 0), 0);
  let lastLog = null;
  try { const st = fs.statSync(path.join(dir, 'events.log')); lastLog = st.mtimeMs; } catch { /* 기록 없음 */ }
  const lastLine = tail(path.join(dir, 'events.log'), 1, 4096)[0] || null;
  return {
    mode, dir,
    latestDate: latest,
    latestPnl: days[latest]?.pnl ?? (dayTrades.length ? sum(dayTrades) : null),
    latestEntries: days[latest]?.entries ?? dayTrades.length,
    cum: typeof state?.cum === 'number' ? state.cum : (trades.length ? sum(trades) : null),
    count: trades.length,
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl < 0).length,
    legs: legsOf(state),
    board: key === 'gap' ? gapBoard(dir) : null,
    lastLog, lastLine,
    trades,
  };
}
// 봇이 지금 들고 있는 종목·걸어 둔 매수 주문. 갭 봇은 2026-11-26부터 여러 종목(legs), 그 전 형식(pos·buy)도 읽음
function legsOf(state) {
  const one = (g, st) => ({ sym: g.s, st, qty: g.qty, px: g.px ?? null, target: g.target ?? null, stop: g.stop ?? null, level: g.level ?? null, t: g.t ?? null, orderT: g.orderT ?? null, date: g.date ?? null });
  return [...(state?.legs ?? []).map(g => one(g, g.st)), ...(state?.pos ? [one(state.pos, 'hold')] : []), ...(state?.buy ? [one(state.buy, 'buy')] : [])];
}

function readStats(root) {
  const orb = path.join(root, 'orb');
  const bots = {}, all = [], curve = [];
  for (const b of BOTS) {
    bots[b.key] = {};
    for (const mode of ['live', 'paper']) {
      const s = summary(root, b.key, mode);
      if (s) { all.push(...s.trades); if (mode === 'live' && b.key !== 'hold') curve.push(...s.trades.filter(t => t.pnl !== null)); delete s.trades; }
      bots[b.key][mode] = s;
    }
  }
  const key = t => `${t.date}|${t.time}`;
  all.sort((a, b) => key(b).localeCompare(key(a)));
  curve.sort((a, b) => key(a).localeCompare(key(b))); // 실전 갭·애프터장 봇 거래 전부, 오래된 것부터 (봇이 번 돈 곡선)
  const flags = {};
  for (const f of FLAGS) flags[f] = fs.existsSync(path.join(orb, f));
  const skip = (() => { try { return fs.readFileSync(path.join(orb, 'hold_skip.txt'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean); } catch { return []; } })();
  return { bots, trades: all.slice(0, 60), curve, flags, limits: readJson(path.join(orb, 'live.json'), null), holdSkip: skip };
}

// 기록 파일 끝부분만 (큰 파일도 빠르게)
function tail(file, maxLines = 300, maxBytes = 96 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString('utf8').split(/\r?\n/);
    if (size > len) lines = lines.slice(1);
    return lines.filter(Boolean).slice(-maxLines);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function setFlag(root, name, on, note) {
  if (!FLAGS.includes(name)) throw Error('없는 정지 파일이에요: ' + name);
  const f = path.join(root, 'orb', name);
  if (on) fs.writeFileSync(f, note || `토스 봇 화면에서 켬 ${new Date().toLocaleString('ko-KR')}\r\n`);
  else if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = { readStats, tail, setFlag, parseCsv };
