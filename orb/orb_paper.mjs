// orb_paper.mjs — 5분 시가범위 돌파(Zarattini·Barbon·Aziz 2024). 페이퍼(가상 체결) 또는 실전(토스 실제 주문)
// 실행 (프로젝트 폴더에서):
//   node orb/orb_paper.mjs                 페이퍼: 주문 없이 그 순간 호가창으로 가상 체결 → orb/data/
//   node orb/orb_paper.mjs --live          실전: 토스에 실제 주문 → orb/data-live/  (한도는 orb/live.json)
//   node orb/orb_paper.mjs --check         토스 연결·순위·일봉·분봉·호가 조회만 확인
//   node orb/orb_paper.mjs --check-live    계좌·주문가능금액·미체결 주문 조회만 (주문 없음)
//   node orb/orb_paper.mjs --test-order    체결되지 않을 가격(현재가의 70%)으로 1주 지정가 매수 → 바로 취소 (주문 기능 점검용, 실제 주문)
//   node orb/orb_paper.mjs --cancel=주문ID  그 주문 하나만 취소 (시험 주문이 남았을 때)
//   node orb/orb_paper.mjs --types         백테스트 후보 종목의 종류·배율을 받아 history/data/stock_types.json에 저장
//   node orb/orb_paper.mjs --mock [--live] 키 없이 가상 시장으로 하루 흐름 시험
//   PC가 잠들지 않게:  powershell -ExecutionPolicy Bypass -File .\orb\run_orb.ps1 [--live]
// 규칙 (백테스트 history/orb_sip.py와 같음):
//   후보: 거래대금·거래량·상승률·하락률·토스 이용자 거래 순위(각 100위) 중 주가 $5~30, 14일 평균 거래량 100만 주↑, 14일 ATR $0.5↑
//         ETN 전부, 레버리지·인버스 ETF(배율이 1이 아닌 것)는 제외 — 사전교육·예탁금 없이는 못 사는 상품
//   9:35에 (첫 5분 거래량 ÷ 14일 평균 하루 거래량) 상위 20 → 첫 5분봉이 양봉이면 대기 → 현재가가 첫 5분 고가를 넘으면 매수
//   손절: 체결가 - ATR × 10% / 손절 안 걸리면 마감 직전 매도
// 실전 안전장치 (orb/live.json): 거래당 금액, 하루 진입 횟수, 동시 보유 수, 하루·누적 손실 한도. 지정가로만 사고(매도호가+0.3%),
//   팔 때는 매수호가-0.5% 지정가 → 안 팔리면 -1.5% → 그래도 안 되면 시장가. 이 스크립트가 산 수량만 팜(다른 보유 종목은 안 건드림).
//   orb/STOP 파일이 있으면 새로 안 삼, orb/FLATTEN 파일이 있으면 지금 다 팜.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = f => process.argv.includes(f);
const MOCK = has('--mock'), LIVE = has('--live'), CHECK = has('--check'), CHECK_LIVE = has('--check-live'), TEST_ORDER = has('--test-order'), TYPES = has('--types');
const DATA = join(HERE, (MOCK ? 'data-mock' : 'data') + (LIVE ? '-live' : '')); mkdirSync(DATA, { recursive: true });
if (MOCK) for (const f of ['events.log', 'trades.csv', 'state.json']) if (existsSync(join(DATA, f))) writeFileSync(join(DATA, f), f === 'state.json' ? '{}' : '');
const BASE = 'https://openapi.tossinvest.com';
const R = { notional: 50, top: 20, orMin: 5, stopAtr: 0.10, minPx: 5, maxPx: 30, minAdv: 1_000_000, minAtr: 0.5, minRv: 0.04,
            pollMs: 2000, depthShare: 0.5, maxEntrySlip: 0.02, commission: 0.001, minFee: 0.01, sellTax: 0.01, callGapMs: 120 };
const LIM_FILE = process.env.ORB_LIVE_JSON || join(HERE, 'live.json');
const L = LIVE || has('--check-live') ? JSON.parse(readFileSync(LIM_FILE, 'utf8').replace(/^﻿/, '')) : null;
if (L) R.notional = L.perTradeUsd;

// ---------- 시간 ----------
let simNow = 0;
const now = () => (MOCK ? simNow : Date.now());
const sleep = ms => (MOCK ? (simNow += ms, Promise.resolve()) : new Promise(r => setTimeout(r, ms)));
const MIN = 60_000, HOUR = 3_600_000;
function nthSunday(y, m, n) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (n - 1) * 7; }
function etOffset(ms) { const y = new Date(ms).getUTCFullYear(); const s = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), e = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); return ms >= s && ms < e ? -4 : -5; }
function etParts(ms) { const d = new Date(ms + etOffset(ms) * HOUR); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
function etToMs(y, mo, d, h, mi) { const naive = Date.UTC(y, mo, d, h, mi); return naive - etOffset(naive + 5 * HOUR) * HOUR; }
const ymd = p => `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const kst = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5, 19);
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '?');
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : v);
function log(msg) { const line = `[${kst(now())}] ${msg}`; console.log(line); appendFileSync(join(DATA, 'events.log'), line + '\n'); }
const HEADER = ['날짜(ET)', '종목', '순위', '상대거래량', 'ATR', '첫5분시가', '첫5분고가', '진입(KST)', '진입직전현재가', '매도호가', '매수호가', '진입스프레드', '체결가', '진입미끄러짐(체결/고가)',
  '손절가', '청산(KST)', '청산사유', '청산직전현재가', '청산매수호가', '청산체결가', '손절미끄러짐(체결/손절가)', '수량', '비용전수익률(체결가기준)', '수수료후수익률', '백테스트식수익률(고가→청산신호가)', '손익USD', '주문ID'];
function csvRow(f, row) { const p = join(DATA, f); if (!existsSync(p)) appendFileSync(p, '﻿' + HEADER.join(',') + '\n'); appendFileSync(p, row.map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v}"` : v)).join(',') + '\n'); }
const STATE_F = join(DATA, 'state.json');
const loadState = () => { try { return JSON.parse(readFileSync(STATE_F, 'utf8') || '{}'); } catch { return {}; } };
const saveState = s => { writeFileSync(STATE_F + '.tmp', JSON.stringify(s, null, 1)); renameSync(STATE_F + '.tmp', STATE_F); };

// ---------- 토스 ----------
function loadEnv() {
  const p = resolve(HERE, '../../toss-mcp/.env'), env = {};
  if (!existsSync(p)) throw new Error(`키 파일이 없어요: ${p}`);
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) { const line = raw.trim(), i = line.indexOf('='); if (line && !line.startsWith('#') && i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return env;
}
const normBook = r => { const side = a => (a ?? []).map(e => ({ p: num(e.price), q: num(e.volume) })).filter(e => e.p > 0 && e.q > 0); return { asks: side(r?.asks).sort((a, b) => a.p - b.p), bids: side(r?.bids).sort((a, b) => b.p - a.p) }; };
const normBars = arr => (arr ?? []).map(c => ({ t: Date.parse(c.timestamp), o: num(c.openPrice), h: num(c.highPrice), l: num(c.lowPrice), c: num(c.closePrice), v: num(c.volume) })).filter(c => Number.isFinite(c.t) && c.h > 0).sort((a, b) => a.t - b.t);
const normOrder = o => ({ status: o?.status, filled: num(o?.execution?.filledQuantity) || 0, avgPx: num(o?.execution?.averageFilledPrice), raw: o });
function liveProvider() {
  const env = loadEnv(); let token = null, last = 0, acct = env.TOSS_ACCOUNT_SEQ || null;
  async function issue() {
    const res = await fetch(`${BASE}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TOSS_CLIENT_ID, client_secret: env.TOSS_CLIENT_SECRET }) });
    const j = await res.json().catch(() => ({})); if (!j.access_token) throw new Error(`토큰 발급 실패 (${res.status})`); token = j.access_token; return token;
  }
  async function call(method, path, { query = {}, body, account = false } = {}, attempt = 0) {
    const wait = last + R.callGapMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
    const url = new URL(path, BASE); for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${token || await issue()}`, Accept: 'application/json' };
    if (account) headers['X-Tossinvest-Account'] = String(await accountSeq());
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(url, { method, signal: AbortSignal.timeout(20_000), headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch (e) { if (attempt < 3) { await sleep(1000); return call(method, path, { query, body, account }, attempt + 1); } throw e; } // 주문은 clientOrderId가 같아서 다시 보내도 한 번만 접수됨
    if (res.status === 401 && attempt < 2) { token = null; return call(method, path, { query, body, account }, attempt + 1); }
    if (res.status === 429 && attempt < 5) { await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000); return call(method, path, { query, body, account }, attempt + 1); }
    const j = await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(`${method} ${path} ${res.status} ${j?.error?.code ?? ''} ${j?.error?.message ?? ''}`.trim()); err.code = j?.error?.code; err.status = res.status; throw err; }
    return j && typeof j === 'object' && 'result' in j ? j.result : j;
  }
  const get = (path, query) => call('GET', path, { query });
  async function accountSeq() {
    if (acct != null) return acct;
    const r = await call('GET', '/api/v1/accounts'); const list = Array.isArray(r) ? r : (r?.accounts ?? r?.items ?? []);
    if (!list.length) throw new Error('조회되는 계좌가 없어요');
    if (list.length > 1) log(`계좌가 ${list.length}개라 첫 번째 계좌를 써요. 다른 계좌를 쓰려면 toss-mcp/.env에 TOSS_ACCOUNT_SEQ를 넣어 주세요.`);
    acct = list[0].accountSeq; return acct;
  }
  const sessTime = (s, p) => { const m = typeof s === 'string' && s.match(/^(\d{2}):(\d{2})/); return m ? etToMs(p.y, p.mo, p.d, +m[1], +m[2]) : Date.parse(s); };
  return {
    accountSeq,
    async session(ms) {
      const p = etParts(ms + 4 * HOUR);
      try {
        const T = (await get('/api/v1/market-calendar/US', { date: ymd(p) }))?.today;
        if (T && !T.regularMarket) return { date: ymd(p), closed: true };
        const open = sessTime(T?.regularMarket?.startTime, p), close = sessTime(T?.regularMarket?.endTime, p);
        if (Number.isFinite(open) && Number.isFinite(close)) return { date: ymd(p), open, close };
      } catch (e) { log(`장 운영시간 조회 실패, 09:30~16:00 ET로 가정: ${e.message}`); }
      if (p.dow === 0 || p.dow === 6) return { date: ymd(p), closed: true };
      return { date: ymd(p), open: etToMs(p.y, p.mo, p.d, 9, 30), close: etToMs(p.y, p.mo, p.d, 16, 0) };
    },
    async ranking(type, duration) { const r = await get('/api/v1/rankings', { type, marketCountry: 'US', duration, count: 100 }); return (r?.rankings ?? []).filter(x => x.currency === 'USD').map(x => ({ symbol: x.symbol, last: num(x.price?.lastPrice) })); },
    async prices(symbols) { const out = new Map(); for (let i = 0; i < symbols.length; i += 200) for (const x of (await get('/api/v1/prices', { symbols: symbols.slice(i, i + 200).join(',') })) ?? []) out.set(x.symbol, num(x.lastPrice)); return out; },
    async candles(symbol, interval, count) { return normBars((await get('/api/v1/candles', { symbol, interval, count }))?.candles); },
    async candlesPage(symbol, interval, count, before) { const r = await get('/api/v1/candles', { symbol, interval, count, before }); return { bars: normBars(r?.candles), nextBefore: r?.nextBefore ?? null }; },
    async orderbook(symbol) { return normBook(await get('/api/v1/orderbook', { symbol })); },
    async stockTypes(symbols) { const out = new Map(); for (let i = 0; i < symbols.length; i += 200) for (const x of (await get('/api/v1/stocks', { symbols: symbols.slice(i, i + 200).join(',') })) ?? []) out.set(x.symbol, { type: x.securityType ?? null, lev: x.leverageFactor == null ? null : num(x.leverageFactor) }); return out; },
    // 주문 (실전 모드에서만 부름)
    async placeOrder(body) { return call('POST', '/api/v1/orders', { body, account: true }); },
    async getOrder(id) { return normOrder(await call('GET', `/api/v1/orders/${encodeURIComponent(id)}`, { account: true })); },
    async cancelOrder(id) { return call('POST', `/api/v1/orders/${encodeURIComponent(id)}/cancel`, { body: {}, account: true }); },
    async buyingPower() { return call('GET', '/api/v1/buying-power', { query: { currency: 'USD' }, account: true }); },
    async openOrders() { return call('GET', '/api/v1/orders', { query: { status: 'OPEN', limit: 100 }, account: true }); },
  };
}

// ---------- 가상 시장 (--mock) ----------
function mockProvider() {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const p = etParts(Date.now()); const open = etToMs(p.y, p.mo, p.d, 9, 30), close = open + 390 * MIN;
  simNow = open + Number(process.env.ORB_MOCK_START_MIN ?? -15) * MIN;
  const syms = Array.from({ length: 40 }, (_, i) => `S${i}`), M = new Map();
  for (const s of syms) {
    const p0 = 5 + rnd() * 20, adv = 5e5 + rnd() * 5e6, atr = p0 * (0.03 + rnd() * 0.05), bars = []; let px = p0;
    for (let t = open; t < close; t += MIN) { const o = px, drift = (rnd() - 0.48) * atr * 0.08; px = Math.max(1, px + drift); const h = Math.max(o, px) + rnd() * atr * 0.03, l = Math.min(o, px) - rnd() * atr * 0.03;
      bars.push({ t, o, h, l, c: px, v: Math.round(adv * (t < open + 5 * MIN ? 0.02 + rnd() * 0.3 : 0.002)) }); }
    M.set(s, { adv, atr, bars, p0 });
  }
  const at = (s, t) => { const b = M.get(s).bars; if (t < open) return M.get(s).p0; const x = b[Math.min(b.length - 1, Math.floor((t - open) / MIN))]; const f = ((t - open) % MIN) / MIN; return f < 0.5 ? x.o + (x.h - x.o) * f * 2 : x.h + (x.c - x.h) * (f - 0.5) * 2; };
  const book = s => { const p = at(s, now()), half = p * 0.0008; return { asks: [{ p: p + half, q: 2000 }, { p: p + 3 * half, q: 5000 }], bids: [{ p: p - half, q: 2000 }, { p: p - 3 * half, q: 5000 }] }; };
  const orders = new Map(); let oid = 0, sellTries = 0;
  return {
    async accountSeq() { return 1; },
    async session() { return { date: ymd(p), open, close }; },
    async ranking() { return syms.slice(0, 30).map(s => ({ symbol: s, last: at(s, now()) })); },
    async prices(symbols) { return new Map(symbols.map(s => [s, at(s, now())])); },
    async candles(s, interval, count) {
      const m = M.get(s);
      if (interval === '1d') { const out = []; for (let i = 20; i >= 1; i--) out.push({ t: open - i * 24 * HOUR, o: m.p0, h: m.p0 + m.atr / 2, l: m.p0 - m.atr / 2, c: m.p0, v: m.adv }); out.push({ t: open - 9 * HOUR, o: m.p0, h: m.p0, l: m.p0, c: m.p0, v: 1 }); return out; }
      return m.bars.filter(b => b.t + MIN <= now()).slice(-count);
    },
    async orderbook(s) { return book(s); },
    async candlesPage(s, interval, count) { return { bars: await this.candles(s, interval, count), nextBefore: null }; },
    async stockTypes(symbols) { return new Map(symbols.map(s => [s, s === 'S3' ? { type: 'ETF', lev: 3 } : s === 'S6' ? { type: 'ETF', lev: 1 } : { type: 'STOCK', lev: null }])); },
    async placeOrder(b) { // 가상 주문: S13 매수는 절반만 체결, 매도 첫 번째 시도는 한 번 안 팔리게
      if (orders.has(b.clientOrderId)) return { orderId: orders.get(b.clientOrderId).id };
      const bk = book(b.symbol), q = Number(b.quantity), id = `m${++oid}`;
      let filled = 0, px = NaN;
      if (b.side === 'BUY') { const a = bk.asks[0].p; if (b.orderType === 'MARKET' || Number(b.price) >= a) { filled = b.symbol === 'S13' ? Math.floor(q / 2) : q; px = a; } }
      else { const bd = bk.bids[0].p; if (b.orderType === 'MARKET' || (Number(b.price) <= bd && sellTries++ % 3 !== 0)) { filled = q; px = bd; } }
      if (b.side === 'BUY' && b.symbol === 'S20') { filled = 0; px = NaN; } // 시험: 취소가 계속 안 되다가 나중에 체결되는 주문
      const o = { id, b, filled, px, at: now(), cancels: 0, status: filled === q ? 'FILLED' : filled ? 'PARTIAL_FILLED' : 'PENDING' };
      orders.set(b.clientOrderId, o); orders.set(id, o); return { orderId: id, clientOrderId: b.clientOrderId };
    },
    async getOrder(id) { const o = orders.get(id);
      if (o.b.symbol === 'S20' && o.b.side === 'BUY' && o.status === 'PENDING' && now() - o.at > 2 * MIN) { o.status = 'FILLED'; o.filled = Number(o.b.quantity); o.px = Number(o.b.price); }
      return { status: o.status, filled: o.filled, avgPx: o.px }; },
    async cancelOrder(id) { const o = orders.get(id); o.cancels++;
      if (o.cancels === 1 || (o.b.symbol === 'S20' && o.b.side === 'BUY')) { const e = new Error('409 already-processing'); e.status = 409; throw e; } // 주문 직후엔 한 번 거부, S20 매수는 계속 거부
      if (o.status !== 'FILLED') o.status = 'CANCELED'; return { orderId: id + 'c' }; },
    async buyingPower() { return { mock: true }; },
    async openOrders() { return []; },
  };
}

// ---------- 공통 ----------
function simFill(book, side, qty, limitPx) {
  const levels = side === 'BUY' ? book.asks : book.bids; let left = qty, filled = 0, cost = 0;
  for (const lv of levels) { if (limitPx && (side === 'BUY' ? lv.p > limitPx : lv.p < limitPx)) break; const take = Math.min(left, Math.floor(lv.q * R.depthShare)); if (take <= 0) continue; filled += take; cost += take * lv.p; left -= take; if (left <= 0) break; }
  return { filled, avgPx: filled ? cost / filled : NaN };
}
const fee = (notional, side) => Math.max(R.minFee, notional * R.commission) + (side === 'SELL' ? R.sellTax : 0);
const RANKS = [['MARKET_TRADING_AMOUNT', 'realtime'], ['MARKET_TRADING_VOLUME', 'realtime'], ['TOP_GAINERS', '1d'], ['TOP_LOSERS', '1d'], ['TOSS_SECURITIES_TRADING_AMOUNT', 'realtime'], ['TOSS_SECURITIES_TRADING_VOLUME', 'realtime']];
const riskyType = t => t && (t.type === 'ETN' || (t.type === 'ETF' && t.lev !== 1)); // ETN 전부, 배율 1이 아닌 ETF(레버리지·인버스, 배율 모름 포함)
const tick = p => (p >= 1 ? 0.01 : 0.0001);
const upTick = p => Math.ceil(p / tick(p) - 1e-9) * tick(p), downTick = p => Math.floor(p / tick(p) + 1e-9) * tick(p);
const fmtPx = p => (p >= 1 ? p.toFixed(2) : p.toFixed(4));
const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'REPLACED', 'CANCEL_REJECTED']);
async function waitOrder(P, id, ms) { // 끝날 때까지(또는 ms까지) 기다리며 체결 상태 확인
  let o = null; const until = now() + ms;
  for (;;) { try { o = await P.getOrder(id); } catch (e) { log(`주문 ${id} 조회 실패: ${e.message}`); } if ((o && TERMINAL.has(o.status)) || now() >= until) return o; await sleep(1000); }
}
async function cancelAndSettle(P, id) { // 취소하고 최종 체결 수량 확인. 주문 직후엔 토스가 409(처리 중)를 주므로 몇 번 다시 시도
  for (let i = 0; i < 12; i++) {
    try { await P.cancelOrder(id); break; }
    catch (e) {
      let o = null; try { o = await P.getOrder(id); } catch { /* 조회 실패는 다음 시도에서 */ }
      if (o && TERMINAL.has(o.status)) return o;           // 이미 체결·취소됨
      if (i === 0 || i === 11) log(`주문 ${id.slice(0, 10)}… 취소 ${i === 0 ? '대기(토스가 아직 처리 중)' : '계속 실패'}: ${e.message}`);
      await sleep(2000);
    }
  }
  return waitOrder(P, id, 20_000);
}
const settled = o => !!o && TERMINAL.has(o.status);

// ---------- 실전 주문 ----------
async function liveBuy(P, x, ask, qty, cid) {
  const limit = upTick(ask * (1 + L.buyLimitPadPct));
  let r; try { r = await P.placeOrder({ symbol: x.s, side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: String(qty), price: fmtPx(limit), clientOrderId: cid }); }
  catch (e) { log(`${x.s} 매수 주문 실패: ${e.message}`); return null; }
  let o = await waitOrder(P, r.orderId, 10_000);
  if (!o || o.status !== 'FILLED') o = await cancelAndSettle(P, r.orderId);
  return { qty: o?.filled || 0, px: o?.avgPx, id: r.orderId, limit, pending: !settled(o) };
}
async function liveSell(P, sym, qty, cidBase) { // 지정가(매수호가-0.5%) → 지정가(-1.5%) → 시장가, 남은 수량만
  let left = qty, got = 0, cost = 0; const ids = [];
  const steps = [['LIMIT', L.sellLimitPadPct], ['LIMIT', L.sellLimitPadPct + 0.01], ['MARKET', 0]];
  for (const [i, [type, pad]] of steps.entries()) {
    if (left <= 0) break;
    let bid = NaN; try { bid = (await P.orderbook(sym)).bids[0]?.p; } catch { /* 호가 실패 시 시장가로 */ }
    const body = { symbol: sym, side: 'SELL', orderType: type === 'LIMIT' && bid > 0 ? 'LIMIT' : 'MARKET', timeInForce: 'DAY', quantity: String(left), clientOrderId: `${cidBase}${i + 1}` };
    if (body.orderType === 'LIMIT') body.price = fmtPx(downTick(bid * (1 - pad)));
    let r; try { r = await P.placeOrder(body); } catch (e) { log(`${sym} 매도 주문 실패(${i + 1}차): ${e.message}`); continue; }
    ids.push(r.orderId);
    let o = await waitOrder(P, r.orderId, 10_000);
    if (!o || o.status !== 'FILLED') o = await cancelAndSettle(P, r.orderId);
    if (o && o.filled > 0) { got += o.filled; cost += o.filled * o.avgPx; left -= o.filled; }
    if (!settled(o)) return { sold: got, avgPx: got ? cost / got : NaN, left, ids, pendingId: r.orderId }; // 아직 살아 있는 매도 주문: 겹쳐 내지 않음
  }
  return { sold: got, avgPx: got ? cost / got : NaN, left, ids };
}

// ---------- 하루 ----------
async function barsSince(P, s, since) {
  const need = Math.min(200, Math.ceil((now() - since) / MIN) + 10);
  let { bars, nextBefore } = await P.candlesPage(s, '1m', need);
  for (let k = 0; k < 3 && bars.length && bars[0].t > since && nextBefore; k++) {
    const pg = await P.candlesPage(s, '1m', 200, nextBefore); if (!pg.bars.length) break;
    bars = [...pg.bars, ...bars]; nextBefore = pg.nextBefore;
  }
  return bars;
}
function dailyStats(bars, sess) {
  const p = etParts(sess.open), mid = etToMs(p.y, p.mo, p.d, 0, 0);
  const done = bars.filter(b => b.t < mid - 18 * HOUR).slice(-15);
  if (done.length < 15) return null;
  const last14 = done.slice(1), tr = last14.map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - done[i].c), Math.abs(b.l - done[i].c)));
  return { adv: avg(last14.map(b => b.v)), atr: avg(tr) };
}
async function runDay(P, sess) {
  const S = LIVE ? loadState() : {}; S.cum ??= 0; S.days ??= {}; S.pos ??= {};
  const D = (S.days[sess.date] ??= { entries: 0, pnl: 0, done: [] }); D.done ??= [];
  const stats = new Map(), seen = new Set();
  async function addCandidates(tag) {
    const lists = [];
    for (const [type, dur] of RANKS) { try { lists.push(await P.ranking(type, dur)); } catch (e) { log(`순위 ${type} 조회 실패: ${e.message}`); } }
    let added = 0, risky = 0;
    const fresh = [...new Map(lists.flat().filter(x => !seen.has(x.symbol) && x.last >= R.minPx * 0.8 && x.last <= R.maxPx * 1.2).map(x => [x.symbol, x])).values()];
    let types = new Map(); try { types = await P.stockTypes(fresh.map(x => x.symbol)); } catch (e) { log(`종목 종류 조회 실패: ${e.message}${LIVE ? ' — 실전이라 이번 후보는 건너뜀' : ''}`); if (LIVE) return; }
    for (const x of fresh) {
      seen.add(x.symbol);
      if (riskyType(types.get(x.symbol)) || (LIVE && !types.has(x.symbol))) { risky++; continue; }
      try { const st = dailyStats(await P.candles(x.symbol, '1d', 25), sess); if (st && st.adv >= R.minAdv && st.atr >= R.minAtr) { stats.set(x.symbol, st); added++; } } catch { /* 일봉 실패는 건너뜀 */ }
    }
    log(`${tag}: 새 종목 ${added}개 통과 (레버리지·인버스 ETF/ETN ${risky}개 제외, 평균 거래량 100만 주↑, ATR $0.5↑) — 후보 누적 ${stats.size}개`);
  }
  if (now() < sess.open + R.orMin * MIN) { await addCandidates('장 시작 전 준비'); while (now() < sess.open + R.orMin * MIN + 3000) await sleep(Math.min(R.pollMs * 5, sess.open + R.orMin * MIN + 3000 - now())); }
  await addCandidates('9:35 순위 다시 확인');
  const setups = [], orEnd = sess.open + R.orMin * MIN;
  for (const [s, st] of stats) {
    let all = [], orb = [];
    for (let k = 0; k < 4; k++) { // 막 끝난 9:34 봉이 아직 안 올라왔을 수 있어서, 장 시작 직후에만 몇 번 다시 받음
      try { all = await barsSince(P, s, sess.open); orb = all.filter(b => b.t >= sess.open && b.t < orEnd); } catch { orb = []; }
      if (orb.some(b => b.t === orEnd - MIN) || MOCK || now() > orEnd + 2 * MIN) break; await sleep(3000);
    }
    if (!orb.length) continue;
    const o = orb[0].o, c = orb[orb.length - 1].c, h = Math.max(...orb.map(b => b.h)), v5 = orb.reduce((a, b) => a + b.v, 0);
    if (!(c >= R.minPx && c <= R.maxPx)) continue;
    const brokeAt = all.find(b => b.t >= orEnd && b.t + MIN <= now() && b.h > h)?.t; // 늦게 켰을 때: 이미 지나간 분봉에서 첫 돌파가 있었는지
    setups.push({ s, o, c, h, rv: v5 / st.adv, atr: st.atr, brokeAt });
  }
  const top = setups.filter(x => x.rv >= R.minRv).sort((a, b) => b.rv - a.rv).slice(0, R.top); top.forEach((x, i) => (x.rank = i + 1));
  const wait = top.filter(x => x.c > x.o);
  writeFileSync(join(DATA, `setups_${sess.date}.json`), JSON.stringify({ at: now(), candidates: stats.size, top, wait: wait.map(x => x.s) }));
  log(`상대거래량 상위 ${top.length}개 중 첫 5분 양봉 ${wait.length}개 대기: ${wait.map(x => `${x.s}(고가 $${r4(x.h)})`).join(', ') || '없음'}`);
  const pos = new Map(Object.entries(S.pos).filter(([, p]) => p.date === sess.date)), done = new Set([...pos.keys(), ...D.done]); let lastStatus = 0;
  for (const [s, p] of pos) if (!wait.some(x => x.s === s)) wait.push({ s, rank: p.rank, rv: p.rv, atr: p.atr, o: p.o, h: p.h }); // 다시 켰을 때 이어서 관리
  if (!wait.length) return;
  const startPx = await P.prices(wait.map(x => x.s));
  for (const x of wait) {
    if (pos.has(x.s) || done.has(x.s)) continue;
    if (x.brokeAt) { x.skip = true; log(`${x.s}: ${kst(x.brokeAt).slice(6, 11)}에 이미 첫 5분 고가를 넘었음 — 첫 돌파만 사는 규칙이라 오늘은 안 삼`); }
    else if (startPx.get(x.s) > x.h) { x.skip = true; log(`${x.s}: 준비가 끝났을 때 이미 고가 위($${startPx.get(x.s)}) — 오늘은 안 삼`); }
  }
  const flatAt = sess.close - (LIVE ? 2 : 1) * MIN;
  const persist = () => { if (LIVE) { S.pos = Object.fromEntries(pos); D.done = [...done]; saveState(S); } };
  async function exit(x, p, reason, lastPx) {
    let px, qty = p.qty, ids = '', bid = '', left = 0;
    if (LIVE) {
      let r;
      if (p.pendingSell) { // 지난번에 끝나지 않은 매도 주문: 새로 내지 말고 그 주문부터 정리
        let o = null; try { o = await P.getOrder(p.pendingSell); } catch { /* 다음에 */ }
        if (!settled(o)) o = await cancelAndSettle(P, p.pendingSell);
        if (!settled(o)) { log(`${x.s} 매도 주문이 아직 처리 중 — 다음 확인 때 다시 (토스 앱에서도 확인해 주세요)`); return false; }
        r = { sold: o.filled, avgPx: o.avgPx, left: p.qty - o.filled, ids: [p.pendingSell] }; p.pendingSell = null;
      } else r = await liveSell(P, x.s, p.qty, `orb${sess.date.replace(/-/g, '')}${x.s}S${p.tries = (p.tries || 0) + 1}`);
      if (r.pendingId) p.pendingSell = r.pendingId;
      ids = r.ids.join(' '); persist();
      if (!r.sold) { if (!r.pendingId) log(`${x.s} ${reason} 매도가 안 됨 — 다음 확인 때 다시 (토스 앱에서도 확인해 주세요)`); return false; }
      px = r.avgPx; qty = r.sold; left = p.qty - r.sold;
    } else {
      let book; try { book = await P.orderbook(x.s); } catch (e) { log(`${x.s} 호가 조회 실패: ${e.message}`); return false; }
      const f = simFill(book, 'SELL', p.qty); if (f.filled < p.qty) { log(`${x.s} 매수호가 물량 부족 (${f.filled}/${p.qty}주) — 다음 확인 때 다시`); return false; }
      px = f.avgPx; bid = book.bids[0]?.p ?? '';
    }
    const pnl = qty * px - fee(qty * px, 'SELL') - (qty * p.px + fee(qty * p.px, 'BUY')), net = pnl / (qty * p.px);
    const theo = (reason === '손절' ? p.stop : lastPx) / x.h - 1;
    csvRow('trades.csv', [sess.date, x.s, x.rank, r4(x.rv), r4(x.atr), r4(x.o), r4(x.h), kst(p.t), r4(p.lastPx), r4(p.ask), r4(p.bid), pct(p.spread), r4(p.px), pct(p.px / x.h - 1),
      r4(p.stop), kst(now()), reason, r4(lastPx), bid, r4(px), reason === '손절' ? pct(px / p.stop - 1) : '', qty, pct(px / p.px - 1), pct(net), pct(theo), pnl.toFixed(2), `${p.id || ''} ${ids}`.trim()]);
    D.pnl += pnl; S.cum += pnl;
    log(`${x.s} 청산(${reason}) ${qty}주 $${r4(px)} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pct(net)}, 백테스트식 ${pct(theo)})${LIVE ? ` | 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''}`);
    if (LIVE && left > 0) { p.qty = left; persist(); log(`${x.s} ${left}주 남음 — 다음 확인 때 다시 팜`); return false; }
    pos.delete(x.s); persist(); return true;
  }
  const pendBuy = new Map(); // 결과가 확정 안 된 매수 주문 (취소가 안 먹은 경우)
  async function checkPendingBuys() {
    for (const [s, b] of pendBuy) {
      let o = null; try { o = await P.getOrder(b.id); } catch { continue; }
      if (!settled(o)) { o = await cancelAndSettle(P, b.id); if (!settled(o)) continue; }
      pendBuy.delete(s);
      const extra = o.filled - (b.counted || 0);
      if (extra > 0) { // 늦게 체결된 수량: 포지션에 더하거나 새로 만듦
        const p = pos.get(s);
        if (p) { p.px = (p.px * p.qty + o.avgPx * extra) / (p.qty + extra); p.qty += extra; }
        else pos.set(s, { date: sess.date, t: now(), px: o.avgPx, qty: extra, stop: o.avgPx - R.stopAtr * b.x.atr, lastPx: b.lp, ask: b.ask, bid: b.bid, spread: (b.ask - b.bid) / ((b.ask + b.bid) / 2), id: b.id, rank: b.x.rank, rv: b.x.rv, atr: b.x.atr, o: b.x.o, h: b.x.h });
        log(`${s} 늦게 체결된 매수 ${extra}주 확인 — 관리 시작`); persist();
      } else log(`${s} 매수 주문 확정: 추가 체결 없음`);
    }
  }
  const blocked = () => {
    if (!LIVE) return null;
    if (pendBuy.size) return '확정 안 된 매수 주문 확인 중';
    if (existsSync(join(HERE, 'STOP'))) return 'STOP 파일';
    if (D.entries >= L.maxEntriesPerDay) return `하루 진입 ${L.maxEntriesPerDay}회`;
    if (pos.size >= L.maxOpenPositions) return `동시 보유 ${L.maxOpenPositions}개`;
    if (D.pnl <= -L.dailyLossLimitUsd) return `하루 손실 한도 $${L.dailyLossLimitUsd}`;
    if (S.cum <= -L.totalLossLimitUsd) return `누적 손실 한도 $${L.totalLossLimitUsd}`;
    return null;
  };
  let lastBlock = '';
  while (now() < sess.close + (LIVE ? 5 * MIN : 0)) {
    const live = wait.filter(x => !x.skip && (!done.has(x.s) || pos.has(x.s)));
    if (!live.length) break;
    let px; try { px = await P.prices(live.map(x => x.s)); } catch (e) { log(`현재가 조회 실패: ${e.message}`); await sleep(R.pollMs); continue; }
    const flatten = LIVE && existsSync(join(HERE, 'FLATTEN'));
    if (LIVE && pendBuy.size) await checkPendingBuys();
    for (const x of live) {
      const lp = px.get(x.s); if (!(lp > 0)) continue; const p = pos.get(x.s);
      if (!p && !done.has(x.s) && now() < flatAt && lp > x.h) {
        const why = blocked(); if (why) { if (why !== lastBlock) log(`새 진입 멈춤: ${why}`); lastBlock = why; continue; }
        let book; try { book = await P.orderbook(x.s); } catch (e) { log(`${x.s} 호가 조회 실패: ${e.message}`); continue; }
        const ask = book.asks[0]?.p, bid = book.bids[0]?.p; if (!ask || !bid) continue;
        const qty = Math.floor(R.notional / ask);
        if (qty < 1) { log(`${x.s} 돌파했지만 1주($${ask})가 거래당 금액 $${R.notional}보다 비싸서 안 삼`); done.add(x.s); continue; }
        let fill, id;
        if (LIVE) {
          done.add(x.s); D.entries++; persist();
          const r = await liveBuy(P, x, ask, qty, `orb${sess.date.replace(/-/g, '')}${x.s}B`);
          if (r?.pending) { pendBuy.set(x.s, { id: r.id, x, lp, ask, bid, counted: r.qty || 0 }); log(`${x.s} 매수 주문 결과가 아직 확정 안 됨 — 확정될 때까지 새로 안 사고 계속 확인`); }
          if (!r || !(r.qty > 0)) { if (!r?.pending) log(`${x.s} 돌파 매수 안 됨`); continue; }
          fill = { filled: r.qty, avgPx: r.px }; id = r.id;
          if (r.qty < qty) log(`${x.s} 일부만 체결 ${r.qty}/${qty}주 (나머지는 취소)`);
        } else {
          fill = simFill(book, 'BUY', qty, ask * (1 + R.maxEntrySlip));
          if (fill.filled < qty) { log(`${x.s} 돌파했지만 매도호가 물량 부족 (${fill.filled}/${qty}주) — 다음 확인 때 다시`); continue; }
          done.add(x.s);
        }
        const np = { date: sess.date, t: now(), px: fill.avgPx, qty: fill.filled, stop: fill.avgPx - R.stopAtr * x.atr, lastPx: lp, ask, bid, spread: (ask - bid) / ((ask + bid) / 2), id, rank: x.rank, rv: x.rv, atr: x.atr, o: x.o, h: x.h };
        pos.set(x.s, np); persist();
        log(`${x.s} 돌파 ${LIVE ? '실제 ' : ''}매수 ${np.qty}주 $${r4(np.px)} (첫5분 고가 $${r4(x.h)}, 미끄러짐 ${pct(np.px / x.h - 1)}, 스프레드 ${pct(np.spread)}) 손절 $${r4(np.stop)}`);
      } else if (p && (flatten || now() >= flatAt)) await exit(x, p, flatten ? '수동정리' : '마감', lp);
      else if (p && lp <= p.stop) await exit(x, p, '손절', lp);
    }
    if (now() >= flatAt && !pos.size) break;
    if (now() - lastStatus > 30 * MIN) { lastStatus = now(); log(`보유 ${[...pos.keys()].join(',') || '-'} / 매매 ${done.size} / 대기 ${live.length - pos.size}${LIVE ? ` / 오늘 $${D.pnl.toFixed(2)} 누적 $${S.cum.toFixed(2)}` : ''}`); }
    await sleep(R.pollMs);
  }
  if (pos.size) log(`⚠ 장이 끝났는데 못 판 종목이 있어요: ${[...pos].map(([s, p]) => `${s} ${p.qty}주`).join(', ')} — 토스 앱에서 직접 팔아 주세요`);
  persist();
  log(`=== ${sess.date} 끝: 대기 ${wait.length}개 중 매매 ${done.size}건${LIVE ? `, 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''} → ${DATA.split(/[\\/]/).slice(-2).join('/')}/trades.csv`);
}

// ---------- 점검 모드 ----------
async function check(P) {
  const s = await P.session(Date.now()); log(`장 운영시간: ${s.date} ${s.closed ? '휴장' : `${kst(s.open)} ~ ${kst(s.close)} (KST)`}`);
  for (const [type, dur] of RANKS) { try { const r = await P.ranking(type, dur); log(`순위 ${type}: ${r.length}개, $5~30 ${r.filter(x => x.last >= 5 && x.last <= 30).length}개 (예: ${r.slice(0, 5).map(x => x.symbol).join(',')})`); } catch (e) { log(`순위 ${type} 실패: ${e.message}`); } }
  try { const t = await P.stockTypes(['AAPL', 'QQQ', 'SOXL', 'SOXS']); log(`종목 종류: ${[...t].map(([k, v]) => `${k} ${v.type}×${v.lev ?? '-'}${riskyType(v) ? '(제외)' : ''}`).join(', ')}`); } catch (e) { log(`종목 종류 실패: ${e.message}`); }
  try { const d = await P.candles('AAPL', '1d', 25); log(`일봉 AAPL: ${d.length}개 → ${JSON.stringify(s.closed ? null : dailyStats(d, s))}`); } catch (e) { log(`일봉 실패: ${e.message}`); }
  try { const b = await P.orderbook('AAPL'); log(`호가 AAPL: 매도 ${b.asks[0]?.p} / 매수 ${b.bids[0]?.p}`); } catch (e) { log(`호가 실패: ${e.message}`); }
}
async function checkLive(P) {
  log(`계좌 accountSeq: ${await P.accountSeq()}`);
  try { const b = await P.buyingPower(); log(`주문가능금액 응답: ${JSON.stringify(b).slice(0, 400)}`); } catch (e) { log(`주문가능금액 조회 실패: ${e.message}`); }
  try { const o = await P.openOrders(); const L2 = Array.isArray(o) ? o : (o?.orders ?? o?.items ?? []); log(`미체결 주문 ${L2.length}건`); } catch (e) { log(`미체결 주문 조회 실패: ${e.message}`); }
  log(`실전 한도(orb/live.json): ${JSON.stringify(L)}`);
}
async function testOrder(P) {
  const r = (await P.ranking('MARKET_TRADING_VOLUME', 'realtime')).filter(x => x.last >= 5 && x.last <= 15);
  const t = await P.stockTypes(r.map(x => x.symbol)); const x = r.find(y => t.get(y.symbol)?.type === 'STOCK');
  if (!x) { log('시험할 종목을 못 찾았어요'); return; }
  const price = fmtPx(downTick(x.last * 0.7));
  log(`시험 주문: ${x.symbol} 1주 지정가 $${price} 매수 (현재가 $${x.last}의 70% — 체결되지 않을 가격) → 바로 취소`);
  const cid = `orbtest${Date.now()}`.slice(0, 36);
  const o = await P.placeOrder({ symbol: x.symbol, side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: '1', price, clientOrderId: cid });
  log(`접수됨: orderId ${o.orderId}`);
  log(`상태: ${(await P.getOrder(o.orderId)).status}`);
  await sleep(2000);
  const f = await cancelAndSettle(P, o.orderId);
  log(`취소 후 상태: ${f?.status}, 체결 수량 ${f?.filled} — ${f?.status === 'CANCELED' && !f.filled ? '정상 (주문·조회·취소 모두 됨)' : '토스 앱에서 주문 내역을 확인해 주세요'}`);
}
async function saveTypes(P) {
  const f = resolve(HERE, '../history/data/sip_events.csv');
  const syms = [...new Set(readFileSync(f, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map(l => l.split(',')[1]))];
  const m = await P.stockTypes(syms), out = Object.fromEntries(syms.map(s => [s, m.get(s) ?? null]));
  writeFileSync(resolve(HERE, '../history/data/stock_types.json'), JSON.stringify(out));
  const c = {}; for (const v of Object.values(out)) { const k = v ? (riskyType(v) ? `${v.type}(레버리지·인버스 등, 제외)` : v.type) : '토스에 없음(상장폐지 등)'; c[k] = (c[k] || 0) + 1; }
  log(`종목 ${syms.length}개 종류 저장 → history/data/stock_types.json: ${JSON.stringify(c)}`);
}

async function main() {
  const P = MOCK ? mockProvider() : liveProvider();
  if (CHECK) return check(P);
  if (CHECK_LIVE) return checkLive(P);
  if (TEST_ORDER) return testOrder(P);
  const cancelId = process.argv.find(a => a.startsWith('--cancel='))?.slice(9);
  if (cancelId) { const o = await cancelAndSettle(P, cancelId); log(`주문 ${cancelId.slice(0, 10)}… 취소 결과: ${o?.status}, 체결 수량 ${o?.filled}`); return; }
  if (TYPES) return saveTypes(P);
  log(LIVE ? `시작 — ⚠ 실전: 토스에 실제 주문. 거래당 $${L.perTradeUsd}, 하루 최대 ${L.maxEntriesPerDay}회, 동시 ${L.maxOpenPositions}개, 하루 손실 한도 $${L.dailyLossLimitUsd}, 누적 손실 한도 $${L.totalLossLimitUsd}`
           : `시작 ${MOCK ? '(가상 시장)' : ''} — 주문 없이 가상 매매만. 거래당 $${R.notional}, 상위 ${R.top}, 손절 ATR×${R.stopAtr}`);
  if (LIVE) log(`계좌 accountSeq ${await P.accountSeq()} / 멈추기: orb\\STOP 파일 만들기(새로 안 삼), 다 팔기: orb\\FLATTEN 파일 만들기`);
  for (;;) {
    const sess = await P.session(now());
    if (sess.closed || now() > sess.close + 5 * MIN) { if (MOCK) return; log(`${sess.date} ${sess.closed ? '휴장' : '장 끝남'} — 1시간 뒤 다시 확인`); await sleep(HOUR); continue; }
    if (now() < sess.open - 10 * MIN) { log(`${sess.date} 정규장 ${kst(sess.open)} 시작 — 10분 전까지 대기`); while (now() < sess.open - 10 * MIN) await sleep(Math.min(10 * MIN, sess.open - 10 * MIN - now())); }
    if (now() > sess.close - 30 * MIN && !(LIVE && Object.keys(loadState().pos || {}).length)) { log('장 마감 30분 전이 지나서 오늘은 건너뜀'); await sleep(sess.close - now() + 10 * MIN); continue; }
    try { await runDay(P, sess); } catch (e) { log(`오류로 오늘 중단: ${e.message}${LIVE ? ' — 보유 종목이 남았을 수 있으니 다시 실행하거나 토스 앱에서 확인해 주세요' : ''}`); }
    if (MOCK) return;
    await sleep(Math.max(5 * MIN, sess.close - now() + 10 * MIN));
  }
}
main().catch(e => { log(`멈췄어요: ${e.message}`); process.exit(1); });
