// 'Stocks in Play' 분봉 수집 (2026-11-18) — 논문(Zarattini·Barbon·Aziz 2024)의 시가범위 돌파를 원래 종목군으로 시험하려고 받아요.
// 실행: 프로젝트 폴더에서  python3 history/sip_candidates.py  (후보 목록, 한 번만) 다음에  node history/fetch_sip.mjs
// - 후보: history/data/sip_events.csv (시가 $5~30, 평균 거래량 100만 주↑, ATR $0.5↑, 갭 ±2%↑ 또는 거래량 2배↑) 약 6만 6천 건
// - 최근부터 70일 기간 단위로, 그 기간 후보를 종목마다 한 번에 받아요. 한 기간을 다 받으면 그 기간 날짜들은 빠진 종목이 없어서 바로 시험에 쓸 수 있어요.
// - 용량을 줄이려고 정규장(9:30~16:00) 분봉만 history/data/minute_sip/날짜/종목.json 에 저장해요.
// - 언제 꺼도 돼요(Ctrl+C). 다시 켜면 이어서 받아요. 키는 fetch.mjs와 같은 history/.env 를 써요. 시세 조회만 하고 주문·계좌 접근은 없어요.
// - 무료 요금제는 분당 5회라 전부 약 24시간. 유료(호출 무제한)라면 MASSIVE_GAP_MS=100 으로 실행하면 1~2시간.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HIST_DATA || join(HERE, 'data');
const ENV_FILE = process.env.HIST_ENV || join(HERE, '.env');
const BASE = process.env.MASSIVE_BASE || 'https://api.massive.com';
const GAP_MS = Number(process.env.MASSIVE_GAP_MS || 12_500);   // 분당 5회 제한 → 12.5초 간격
const YEARS = Number(process.env.HIST_YEARS || 2);
const EV = { minGain: 0.15, minPx: 0.3, maxPx: 25, minDollarVol: 1_000_000 }; // 2단계 대상 '급등일' 조건
const KEEP_MAX_LOW = 30;                                         // 일봉은 저가 $30 이하 종목만 저장 (용량 절약)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const log = s => console.log(`[${kst()}] ${s}`);
const saveJson = (f, obj) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f + '.tmp', JSON.stringify(obj)); renameSync(f + '.tmp', f); };
const dur = ms => { const m = Math.round(ms / 60e3); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
const END = new Date(Date.now() - 5 * 3600e3 - 24 * 3600e3);     // 미국 동부 기준 '어제'까지 (무료는 장이 끝난 뒤 데이터)
const START = new Date(END.getTime() - YEARS * 365 * 86400e3 + 7 * 86400e3); // 무료 2년 한도보다 1주 안쪽부터

async function getKey() {
  const fromFile = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').match(/MASSIVE_API_KEY\s*=\s*(\S+)/)?.[1] : null;
  if (process.env.MASSIVE_API_KEY || fromFile) return process.env.MASSIVE_API_KEY || fromFile;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const k = (await rl.question('Massive API 키를 붙여넣고 Enter를 눌러 주세요: ')).trim(); rl.close();
  if (!k) { console.log('키가 비어 있어요. 다시 실행해 주세요.'); process.exit(1); }
  writeFileSync(ENV_FILE, `MASSIVE_API_KEY=${k}\n`); log(`키를 ${ENV_FILE} 에 저장했어요.`);
  return k;
}

let KEY, lastCall = 0, calls = 0;
async function api(pathOrUrl, params = {}) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    lastCall = Date.now(); calls++;
    const u = new URL(pathOrUrl, BASE); for (const [k, v] of Object.entries({ ...params, apiKey: KEY })) u.searchParams.set(k, v);
    let res, body;
    try { res = await fetch(u, { signal: AbortSignal.timeout(60_000) }); body = await res.json().catch(() => ({})); }
    catch (e) { if (attempt >= 6) throw e; log(`네트워크 오류(${e.message}) — 30초 뒤 다시 시도 (${attempt}회째)`); await sleep(30_000); continue; }
    if (res.status === 429) { log('호출 한도에 걸림 — 1분 쉬고 다시 시도'); await sleep(Number(process.env.MASSIVE_BACKOFF_MS || 60_000)); continue; }
    if (res.status === 401) { console.log(`API 키가 맞지 않아요. ${ENV_FILE} 내용을 지우고 다시 실행해서 키를 새로 넣어 주세요.`); process.exit(1); }
    if (res.status === 403) return { forbidden: true, body };     // 요금제 범위 밖 (예: 2년보다 오래된 날짜)
    if (res.status >= 500) { if (attempt >= 6) throw new Error(`서버 오류 ${res.status}`); log(`서버 오류 ${res.status} — 30초 뒤 다시 시도`); await sleep(30_000); continue; }
    if (!res.ok) return { error: res.status, body };
    return body;
  }
}


const SIP = process.env.SIP_DIR || join(DATA, 'minute_sip');
const WINDOW_DAYS = Number(process.env.FETCH_WINDOW_DAYS || 70);
const safeName = T => { const s = T.replace(/[^A-Za-z0-9.\-]/g, '_'); return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(s) ? s + '_' : s; };
const fileOf = (d, T) => join(SIP, d, `${safeName(T)}.json`);
const ETF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etOf = t => { const p = Object.fromEntries(ETF.formatToParts(new Date(t)).map(x => [x.type, x.value])); return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)]; };

function loadEvents() {
  const f = join(DATA, 'sip_events.csv');
  if (!existsSync(f)) { console.log('후보 목록이 없어요. 먼저  python3 history/sip_candidates.py  를 실행해 주세요.'); process.exit(1); }
  return readFileSync(f, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map(l => { const [d, T] = l.split(','); return { d, T }; });
}
function windows(events) { // 최근부터 WINDOW_DAYS씩 끊은 기간 목록 [{from, to, byT: Map(T → [날짜…])}]
  const ds = [...new Set(events.map(e => e.d))].sort(); const out = [];
  let to = ds[ds.length - 1];
  while (to >= ds[0]) {
    const from = new Date(Date.parse(to) - (WINDOW_DAYS - 1) * 86400e3).toISOString().slice(0, 10);
    const byT = new Map();
    for (const e of events) if (e.d >= from && e.d <= to) { if (!byT.has(e.T)) byT.set(e.T, []); byT.get(e.T).push(e.d); }
    out.push({ from, to, byT });
    to = new Date(Date.parse(from) - 86400e3).toISOString().slice(0, 10);
  }
  return out;
}
async function main() {
  KEY = await getKey();
  const events = loadEvents(), W = windows(events);
  let done = events.filter(e => existsSync(fileOf(e.d, e.T))).length;
  const groups = () => W.reduce((a, w) => a + [...w.byT].filter(([T, ds]) => ds.some(d => !existsSync(fileOf(d, T)))).length, 0);
  log(`후보 ${events.length}건 (${W.length}개 기간) 중 ${done}건은 이미 있음 — 남은 호출 약 ${groups()}회, 약 ${dur(groups() * GAP_MS)}`);
  let n = 0;
  for (const [wi, w] of W.entries()) {
    let skipped = 0;
    for (const [T, ds] of w.byT) {
      const need = ds.filter(d => !existsSync(fileOf(d, T))).sort(); if (!need.length) continue;
      const bars = []; let url = `/v2/aggs/ticker/${encodeURIComponent(T)}/range/1/minute/${need[0]}/${need[need.length - 1]}`, params = { adjusted: 'false', sort: 'asc', limit: '50000' }, bad = null;
      while (url) {
        const r = await api(url, params); n++;
        if (r.forbidden || r.error) { bad = r.forbidden ? '요금제 범위 밖' : `오류 ${r.error}`; break; }
        for (const x of r.results || []) bars.push(x);
        url = r.next_url || null; params = {};
      }
      if (bad) { log(`${T} ${need[0]}~${need[need.length - 1]}: ${bad} — 건너뜀 (다음 실행 때 다시 시도)`); skipped += need.length; continue; }
      const byD = new Map();
      for (const x of bars) { const [d, m] = etOf(x.t); if (m < 570 || m >= 960) continue; if (!byD.has(d)) byD.set(d, []); byD.get(d).push([x.t, x.o, x.h, x.l, x.c, x.v, x.vw ?? null, x.n ?? null]); }
      for (const d of need) { try { saveJson(fileOf(d, T), byD.get(d) || []); done++; } catch (err) { log(`${d} ${T}: 저장 실패(${err.message})`); } }
      if (n % 20 === 0) log(`${done}/${events.length}건 (기간 ${wi + 1}/${W.length}: ${w.from}~${w.to}, 호출 ${n}회)`);
    }
    log(`기간 ${wi + 1}/${W.length} (${w.from}~${w.to}) ${skipped ? `받음 (못 받은 ${skipped}건 있음)` : '다 받음 — 이 기간은 바로 시험에 쓸 수 있어요'}. 지금까지 ${done}/${events.length}건`);
  }
  log(`다 받았어요. 이번 실행 호출 ${n}회`);
}
main().catch(e => { log(`멈췄어요: ${e.message} — 다시 실행하면 이어서 받아요.`); process.exit(1); });
