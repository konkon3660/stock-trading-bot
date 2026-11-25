// 과거 데이터 수집 (Massive, 예전 이름 Polygon.io) — 무료 요금제(분당 5회, 2년치)에 맞춰 천천히 받아요.
// 실행: 프로젝트 폴더에서  node history/fetch.mjs
//   1단계: 최근 2년 미국 전 종목 일봉 (하루 1회 호출, 약 500회 → 1시간 40분쯤) + 액면분할·병합 목록
//   2단계: 그중 '급등한 날'(전일 종가 대비 장중 +15% 이상, 거래대금 $100만 이상)의 분봉을 최근 날짜부터 하나씩 (시간당 약 290건)
// - 언제 꺼도 돼요(Ctrl+C). 다시 켜면 받은 건 건너뛰고 이어서 받아요.
// - 키는 history/.env 에 MASSIVE_API_KEY=... 로 저장해요. 없으면 처음에 물어봐요.
// - 주문이나 계좌 접근은 전혀 없어요. 시세 조회만 해요.
// - 가격은 '그날 실제로 거래된 가격'(분할 보정 안 함)으로 받아요. 보정된 가격으로 받으면 나중에 주식 병합을 한
//   동전주가 과거에 비싼 주식이었던 것처럼 보여서 빠져 버려요. 대신 병합 당일의 가짜 급등은 분할 목록으로 걸러요.
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

// ---------- 1단계: 일봉 (전 종목) ----------
const dailyFile = d => join(DATA, 'daily', `${d}.json`);
function tradingDays() { // 주말만 뺀 날짜 목록 (최근 → 과거). 휴장일은 받아 보고 비어 있으면 빈 파일로 표시
  const out = [];
  for (let d = new Date(END); d >= START; d.setUTCDate(d.getUTCDate() - 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(ymd(d)); }
  return out;
}
async function fetchDaily(days) {
  const todo = days.filter(d => !existsSync(dailyFile(d)));
  log(`1단계 일봉: 전체 ${days.length}일 중 ${days.length - todo.length}일은 이미 있음, ${todo.length}일 받을 차례 (약 ${dur(todo.length * GAP_MS)})`);
  let n = 0, denied = 0;
  for (const d of todo) {
    const r = await api(`/v2/aggs/grouped/locale/us/market/stocks/${d}`, { adjusted: 'false' });
    n++;
    const recent = Date.now() - Date.parse(d) < 5 * 86400e3;
    if (r.forbidden) {
      if (recent) { log(`${d}: 아직 받을 수 없는 날짜예요 (다음 실행 때 다시 받음)`); continue; }
      if (++denied >= 3) { log(`${d}: 요금제 범위 밖이라 여기서 1단계를 멈춰요 (더 오래된 날은 못 받음)`); break; }
      continue;
    }
    if (r.error) { log(`${d}: 오류 ${r.error} ${JSON.stringify(r.body).slice(0, 120)} — 건너뜀 (다음 실행 때 다시 받음)`); continue; }
    denied = 0;
    const rows = (r.results || []).filter(x => x.v > 0 && x.l <= KEEP_MAX_LOW).map(x => [x.T, x.o, x.h, x.l, x.c, x.v, x.vw ?? null]);
    if (!rows.length && recent) { log(`${d}: 아직 데이터가 없어요 (다음 실행 때 다시 받음)`); continue; }
    saveJson(dailyFile(d), rows);
    if (n % 10 === 0 || n === todo.length) log(`일봉 ${n}/${todo.length} (${d}, ${rows.length}종목) — 남은 시간 약 ${dur((todo.length - n) * GAP_MS)}`);
  }
}

// ---------- 액면분할·병합 목록 (병합 당일의 가짜 급등을 거르고, 며칠 보유 수익률을 계산할 때 씀) ----------
async function fetchSplits() {
  const out = [], from = ymd(START); let url = '/stocks/v1/splits', params = { limit: '5000', sort: 'execution_date.desc' };
  for (let page = 1; page <= 20 && url; page++) {
    const r = await api(url, params);
    if (r.forbidden || r.error) { log(`분할 목록을 못 받았어요 (${r.error || 403}) — 시가가 전일 종가의 2배 가까이 뛴 날은 '분할의심'으로만 표시할게요`); return null; }
    const rows = r.results || [];
    for (const x of rows) if (x.ticker && x.execution_date >= from) out.push({ T: x.ticker, d: x.execution_date, from: x.split_from, to: x.split_to, type: x.adjustment_type ?? null });
    const oldest = rows.length ? rows[rows.length - 1].execution_date : null;
    url = r.next_url && oldest && oldest >= from ? r.next_url : null; params = {};
  }
  saveJson(join(DATA, 'splits.json'), out);
  log(`분할·병합 ${out.length}건 저장`);
  return out;
}

// ---------- 2단계: 급등일 분봉 ----------
function findEvents(splits) {
  const splitOn = new Map((splits || []).map(s => [`${s.T}|${s.d}`, s]));
  const files = readdirSync(join(DATA, 'daily')).filter(f => f.endsWith('.json')).sort(); // 과거 → 최근
  const events = []; let prev = null, dropped = 0;
  for (const f of files) {
    const rows = JSON.parse(readFileSync(join(DATA, 'daily', f), 'utf8')); const d = f.slice(0, 10);
    if (!rows.length) continue;                                  // 휴장일
    if (prev) for (const [T, o, h, l, c, v, vw] of rows) {
      const p = prev.get(T); if (!p || !(p[4] > 0)) continue;
      const gain = h / p[4] - 1, dv = (vw || c) * v;
      if (!(gain >= EV.minGain && h >= EV.minPx && p[4] <= EV.maxPx && dv >= EV.minDollarVol)) continue;
      if (splitOn.has(`${T}|${d}`)) { dropped++; continue; }     // 분할·병합이 적용된 날: 가격 단위가 바뀐 것이지 급등이 아님
      const note = !splits && o / p[4] >= 1.9 ? '분할의심' : '';
      events.push({ d, T, prevC: p[4], o, h, l, c, v, dv: Math.round(dv), gainHigh: +gain.toFixed(4), gainClose: +(c / p[4] - 1).toFixed(4), note });
    }
    prev = new Map(rows.map(r => [r[0], r]));
  }
  events.sort((a, b) => b.d.localeCompare(a.d) || b.dv - a.dv);   // 최근 날짜부터, 같은 날은 거래대금 큰 순
  const csv = ['날짜,종목,전일종가,시가,고가,저가,종가,거래량,거래대금,장중최고상승률,종가상승률,비고', ...events.map(e => [e.d, e.T, e.prevC, e.o, e.h, e.l, e.c, e.v, e.dv, e.gainHigh, e.gainClose, e.note].join(','))];
  mkdirSync(DATA, { recursive: true }); writeFileSync(join(DATA, 'events.csv'), '﻿' + csv.join('\n'));
  if (dropped) log(`분할·병합 당일이라 급등에서 뺀 날 ${dropped}건`);
  return events;
}
const safeName = T => { const s = T.replace(/[^A-Za-z0-9.\-]/g, '_'); return /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(s) ? s + '_' : s; }; // Windows 예약 이름 피하기
const minuteFile = e => join(DATA, 'minute', e.d, `${safeName(e.T)}.json`);
// 받는 순서 (급한 것부터, 나중에는 전부):
//  1순위: 봇이 살 수 있는 급등일 (전일 종가 +15% 가격이 $20 이하). 날마다 장중 상승률 큰 순으로 2년 전체를 한 바퀴씩
//         (1바퀴 = 모든 날짜의 1위 종목, 2바퀴 = 2위 …) — 최근 며칠에만 몰리면 그날 시장 분위기에 결과가 휘둘려서요.
//  2순위: 나머지 전부.
//  FETCH_ORDER=recent 이면 예전처럼 최근 날짜부터.
const BOT_MAX_PX = 20;
const botCan = e => e.prevC * (1 + EV.minGain) <= BOT_MAX_PX && e.h >= EV.minPx;
function fetchOrder(events) {
  if (process.env.FETCH_ORDER === 'recent') return events;
  const byDay = new Map();
  for (const e of events) { if (!byDay.has(e.d)) byDay.set(e.d, []); byDay.get(e.d).push(e); }
  const ranked = [];
  for (const L of byDay.values()) {
    L.sort((a, b) => b.gainHigh - a.gainHigh);
    let i = 0, j = 0;
    for (const e of L) ranked.push(botCan(e) ? { e, tier: 0, i: i++ } : { e, tier: 1, i: j++ });
  }
  return ranked.sort((a, b) => a.tier - b.tier || a.i - b.i || b.e.d.localeCompare(a.e.d)).map(x => x.e);
}
// 같은 종목은 묶어서: 한 번 호출로 그 종목의 급등일을 최대 WINDOW_DAYS(달력 기준)치 한꺼번에 받아요.
// 급등주는 며칠씩 연달아 튀는 경우가 많아서 호출 수가 크게 줄어요. 결과가 5만 개를 넘으면 다음 페이지를 이어 받아요.
const WINDOW_DAYS = Number(process.env.FETCH_WINDOW_DAYS || 70);
// e를 포함하는 WINDOW_DAYS 구간 중에서 아직 안 받은 급등일이 가장 많이 들어가는 구간 (L은 날짜순)
const DAY = 86400e3;
function pickWindow(L, e) {
  const t0 = Date.parse(e.d); let best = [e];
  for (const s of L) {
    const ts = Date.parse(s.d); if (ts > t0 || t0 - ts > WINDOW_DAYS * DAY) continue;
    const g = L.filter(x => { const t = Date.parse(x.d); return t >= ts && t <= ts + WINDOW_DAYS * DAY; });
    if (g.length > best.length) best = g;
  }
  return best;
}
const etDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
async function fetchMinutes(events) {
  const order = fetchOrder(events), key = e => `${e.d}|${e.T}`;
  const done = new Set(events.filter(e => existsSync(minuteFile(e))).map(key)), skip = new Set();
  const byT = new Map();
  for (const e of events) { if (!byT.has(e.T)) byT.set(e.T, []); byT.get(e.T).push(e); }
  for (const L of byT.values()) L.sort((a, b) => a.d.localeCompare(b.d));
  const p1 = events.filter(botCan).length, p1Left = () => events.filter(e => botCan(e) && !done.has(key(e))).length;
  log(`2단계 분봉: 급등일 ${events.length}건 (1순위 봇 대상 ${p1}건) 중 ${done.size}건은 이미 있음`);
  let n = 0, got = 0;
  for (const e of order) {
    if (done.has(key(e)) || skip.has(key(e))) continue;
    const group = pickWindow(byT.get(e.T).filter(x => !done.has(key(x)) && !skip.has(key(x))), e);
    const first = group[0].d, last = group[group.length - 1].d, bars = [];
    let url = `/v2/aggs/ticker/${encodeURIComponent(e.T)}/range/1/minute/${first}/${last}`, params = { adjusted: 'false', sort: 'asc', limit: '50000' }, bad = null;
    while (url) {
      const r = await api(url, params); n++;
      if (r.forbidden || r.error) { bad = r.forbidden ? '요금제 범위 밖' : `오류 ${r.error}`; break; }
      for (const x of r.results || []) bars.push([x.t, x.o, x.h, x.l, x.c, x.v, x.vw ?? null, x.n ?? null]);
      url = r.next_url || null; params = {};
    }
    if (bad) { log(`${e.T} ${first}~${last}: ${bad} — 건너뜀 (다음 실행 때 다시 시도)`); for (const x of group) skip.add(key(x)); continue; }
    const byD = new Map();
    for (const b of bars) { const d = etDate(b[0]); if (!byD.has(d)) byD.set(d, []); byD.get(d).push(b); }
    for (const x of group) {
      try { saveJson(minuteFile(x), byD.get(x.d) || []); done.add(key(x)); got++; }
      catch (err) { log(`${x.d} ${x.T}: 저장 실패(${err.message}) — 건너뜀`); skip.add(key(x)); }
    }
    if (n % 20 === 0) {
      const left = p1Left(), per = got / n;
      log(`분봉 ${done.size}/${events.length}건 (이번 실행 호출 ${n}회에 ${got}건, 호출당 ${per.toFixed(1)}건) — 1순위 남은 ${left}건, 약 ${dur(left / Math.max(per, 1) * GAP_MS)}`);
    }
  }
  log(`분봉 ${done.size}/${events.length}건 받음 (이번 실행 호출 ${n}회)`);
}

try {
  KEY = await getKey();
  log(`과거 데이터 수집 시작 — 저장 위치 ${DATA}`);
  await fetchDaily(tradingDays());
  const splits = await fetchSplits();
  const events = findEvents(splits);
  log(`급등일 ${events.length}건 (${new Set(events.map(e => e.d)).size}거래일) 찾음 → events.csv`);
  await fetchMinutes(events);
  log(`다 받았어요. 총 호출 ${calls}회`);
} catch (e) { log(`멈췄어요: ${e.message} — 다시 실행하면 이어서 받아요.`); process.exit(1); }
