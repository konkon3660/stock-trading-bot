// gap_dip.mjs — 갭상승 급등주 눌림 지정가 매수. 페이퍼(가상 체결) 또는 실전(토스 실제 주문)
// 실행 (프로젝트 폴더에서):
//   node orb/gap_dip.mjs                 페이퍼: 주문 없이 현재가로 가상 체결 → orb/data-gap/
//   node orb/gap_dip.mjs --live          실전: 토스에 실제 주문 → orb/data-gap-live/  (한도는 orb/live.json)
//   node orb/gap_dip.mjs --check         후보 찾기만 해 보고 끝 (주문 없음)
//   node orb/gap_dip.mjs --mock [--live] 키 없이 가상 시장으로 하루 흐름 시험
//   PC가 잠들지 않게:  powershell -ExecutionPolicy Bypass -File .\orb\run_gap.ps1 [--live]
// 규칙 (백테스트 history/mine/build_gap.py·search_gap.py, 2년 1,148건 거래당 +0.94% t=3.4, 비용 1.5배 +0.70%, 25개월 중 18개월 플러스):
//   후보: 시가가 전일 종가보다 15% 이상 높고 시가 $1~3, ETN·레버리지/인버스 ETF 제외 (실전은 종류를 모르면 제외)
//   매수: 시가 × 0.95에 지정가 (14:30까지 안 걸리면 취소). 돈이 한 종목치라 갭 큰 종목부터 하나씩
//         이미 그 가격을 찍고 다시 올라간 종목은 안 쫓아감 (백테스트는 처음 닿을 때 삼)
//   청산: 체결가 +10%에 지정가 매도를 바로 걸어 둠 / 현재가가 체결가 -20% 이하면 매도 (2026-11-21 -5%→-20%: history/mine/variants2_gap.py 실전식 2년 +1.87%/거래, -5%는 +0.61%) / 15:58 남은 것 매도
// 실전 안전장치 (orb/live.json): 거래당 금액, 하루 진입 횟수, 하루·누적 손실 한도. orb/STOP_GAP 파일 → 새로 안 삼, orb/FLATTEN_GAP → 지금 다 팜
//   이 스크립트가 산 수량만 팜(다른 보유 종목은 안 건드림). 손절 매도는 매수호가-0.5% → -1.5% → 시장가.
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = f => process.argv.includes(f);
const MOCK = has('--mock'), LIVE = has('--live'), CHECK = has('--check');
const HOLD = has('--hold'), ONCE = has('--once'), AH = has('--ah'); // --ah: 애프터장 전용 (2026-11-24) // --hold: 봇이 사지 않은 보유 주식 관리 모드 (2026-11-24)
const DATA = join(HERE, (HOLD ? (MOCK ? 'data-hold-mock' : 'data-hold') : AH ? (MOCK ? 'data-ah-mock' : 'data-ah') : (MOCK ? 'data-gap-mock' : 'data-gap')) + (LIVE ? '-live' : '')); mkdirSync(DATA, { recursive: true });
if (MOCK) for (const f of ['events.log', 'trades.csv', 'state.json']) if (existsSync(join(DATA, f))) writeFileSync(join(DATA, f), f === 'state.json' ? '{}' : '');
const BASE = process.env.TOSS_API_BASE || 'https://openapi.tossinvest.com'; // TOSS_API_BASE는 시험용(가짜 서버)
const G = { gapMin: 0.15, pxMin: 1, pxMax: 3, dip: 0.05, tp: 0.10, sl: Number(process.env.GAP_SL ?? 0.20), lastEntryMin: 300, notional: 20, pollMs: 2000, callGapMs: 120,
            commission: 0.001, minFee: 0.01, sellTax: 0.01 };
const LIM_FILE = process.env.ORB_LIVE_JSON || join(HERE, 'live.json');
const L = LIVE ? JSON.parse(readFileSync(LIM_FILE, 'utf8').replace(/^﻿/, '')) : null;
const ALL_CASH = L?.perTradeUsd === 'all'; // 2026-11-23 사용자: "내 모든 돈을 봇이 관리" → 살 때마다 주문 가능 달러 현금 전부(×0.98)
if (L) G.notional = ALL_CASH ? 0 : L.perTradeUsd;
const STOP_F = join(HERE, 'STOP_GAP'), FLAT_F = join(HERE, 'FLATTEN_GAP');

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
const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : '?');
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : v);
const TAG = HOLD ? '[보유] ' : AH ? '[애프터] ' : '[갭] '; // 한 창에서 같이 돌릴 때(run_all.ps1) 어느 봇 줄인지
function log(msg) { const line = `[${kst(now())}] ${msg}`; console.log(TAG + line); appendFileSync(join(DATA, 'events.log'), line + '\n'); }
const HEADER = ['날짜(ET)', '종목', '전일종가', '시가', '갭', '지정가', '주문(KST)', '체결(KST)', '체결가', '수량', '목표가', '손절가', '청산(KST)', '청산사유', '청산가', '손절미끄러짐(청산/손절가)',
  '비용전수익률', '수수료후수익률', '백테스트식수익률', '손익USD', '주문ID'];
function csvRow(row) { const p = join(DATA, 'trades.csv'); if (!existsSync(p)) appendFileSync(p, '﻿' + HEADER.join(',') + '\n'); appendFileSync(p, row.map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v}"` : v)).join(',') + '\n'); }
const STATE_F = join(DATA, 'state.json');
const loadState = () => { try { return JSON.parse(readFileSync(STATE_F, 'utf8') || '{}'); } catch { return {}; } };
const saveState = s => { writeFileSync(STATE_F + '.tmp', JSON.stringify(s, null, 1)); renameSync(STATE_F + '.tmp', STATE_F); };

// ---------- 토스 (orb_paper.mjs와 같은 연결 코드) ----------
function loadEnv() {
  const p = resolve(HERE, '../../toss-mcp/.env'), env = {};
  if (!existsSync(p)) throw new Error(`키 파일이 없어요: ${p}`);
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) { const line = raw.trim(), i = line.indexOf('='); if (line && !line.startsWith('#') && i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return env;
}
const normBook = r => { const side = a => (a ?? []).map(e => ({ p: num(e.price), q: num(e.volume) })).filter(e => e.p > 0 && e.q > 0); return { asks: side(r?.asks).sort((a, b) => a.p - b.p), bids: side(r?.bids).sort((a, b) => b.p - a.p) }; };
const normBars = arr => (arr ?? []).map(c => ({ t: Date.parse(c.timestamp), o: num(c.openPrice), h: num(c.highPrice), l: num(c.lowPrice), c: num(c.closePrice), v: num(c.volume) })).filter(c => Number.isFinite(c.t) && c.h > 0).sort((a, b) => a.t - b.t);
const normOrder = o => ({ status: o?.status, filled: num(o?.execution?.filledQuantity) || 0, avgPx: num(o?.execution?.averageFilledPrice), raw: o });
const feeOf = o => { const e = o?.raw?.execution, c = num(e?.commission), t = num(e?.tax ?? 0); return Number.isFinite(c) && Number.isFinite(t) ? c + t : NaN; }; // 토스가 알려준 실제 수수료+세금 (모르면 NaN → 추정치)
function liveProvider() {
  const env = loadEnv(); let token = null, bad = null, last = 0, acct = env.TOSS_ACCOUNT_SEQ || null;
  // 토스는 토큰을 새로 발급하면 예전 토큰을 끊어요(401 token-revoked, 2026-11-25 보유 관리 봇이 이걸로 멈춤). 봇 셋·토스 봇 앱이 따로 발급하면
  // 서로 끊으니, orb/.toss-token.json에 둔 토큰을 같이 쓰고 그 토큰이 끊겼을 때만 새로 발급해서 파일을 바꿔요.
  const TOKEN_F = join(HERE, '.toss-token.json');
  const sharedToken = () => { try { const j = JSON.parse(readFileSync(TOKEN_F, 'utf8')); return j.token && !(j.exp < Date.now()) ? j.token : null; } catch { return null; } };
  async function issue() {
    const sh = sharedToken(); if (sh && sh !== bad) { token = sh; return token; } // 다른 봇이 이미 새로 받아 둔 토큰
    const res = await fetch(`${BASE}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TOSS_CLIENT_ID, client_secret: env.TOSS_CLIENT_SECRET }) });
    const j = await res.json().catch(() => ({})); if (!j.access_token) throw new Error(`토큰 발급 실패 (${res.status})`); token = j.access_token;
    try { const tmp = `${TOKEN_F}.${process.pid}`; writeFileSync(tmp, JSON.stringify({ token, exp: Date.now() + (Number(j.expires_in) > 120 ? Number(j.expires_in) * 1000 - 60_000 : 12 * HOUR), at: new Date().toISOString(), by: `gap_dip ${HOLD ? 'hold' : AH ? 'ah' : 'gap'} pid ${process.pid}` })); renameSync(tmp, TOKEN_F); }
    catch (e) { log(`토큰 파일 저장 실패 — 이 봇 혼자 씀: ${e.message}`); }
    return token;
  }
  async function call(method, path, { query = {}, body, account = false } = {}, attempt = 0) {
    const wait = last + G.callGapMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
    const url = new URL(path, BASE); for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${token || await issue()}`, Accept: 'application/json' };
    if (account) headers['X-Tossinvest-Account'] = String(await accountSeq());
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(url, { method, signal: AbortSignal.timeout(20_000), headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch (e) { if (attempt < 3) { await sleep(1000); return call(method, path, { query, body, account }, attempt + 1); } throw e; } // 주문은 clientOrderId가 같아서 다시 보내도 한 번만 접수됨
    if (res.status === 401 && attempt < 3) { bad = token; token = null; return call(method, path, { query, body, account }, attempt + 1); } // 끊긴 토큰 → 같이 쓰는 토큰이나 새 토큰으로
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
    async orderbook(symbol) { return normBook(await get('/api/v1/orderbook', { symbol })); },
    async stockTypes(symbols) { const out = new Map(); for (let i = 0; i < symbols.length; i += 200) for (const x of (await get('/api/v1/stocks', { symbols: symbols.slice(i, i + 200).join(',') })) ?? []) out.set(x.symbol, { type: x.securityType ?? null, lev: x.leverageFactor == null ? null : num(x.leverageFactor) }); return out; },
    async placeOrder(body) { return call('POST', '/api/v1/orders', { body, account: true }); },
    async getOrder(id) { return normOrder(await call('GET', `/api/v1/orders/${encodeURIComponent(id)}`, { account: true })); },
    async cancelOrder(id) { return call('POST', `/api/v1/orders/${encodeURIComponent(id)}/cancel`, { body: {}, account: true }); },
    async buyingPower() { return num((await call('GET', '/api/v1/buying-power', { query: { currency: 'USD' }, account: true }))?.cashBuyingPower); },
    async holdings() { return call('GET', '/api/v1/holdings', { account: true }); },
  };
}

// ---------- 가상 시장 (--mock): 갭상승 종목 6개, 눌렸다 목표 / 눌렸다 손절 / 안 눌림 / 이미 눌렸다 반등 / 레버리지 ETF / 비쌈 ----------
function mockProvider() {
  const p = etParts(Date.now()); const open = etToMs(p.y, p.mo, p.d, 9, 30), close = open + 390 * MIN;
  simNow = open + Number(process.env.GAP_MOCK_START_MIN ?? -12) * MIN;
  // [종목, 전일종가, 시가, 경로(분: 시가 대비 비율)]
  // 갭 순서(큰 것부터 주문): WIN 25% → LOSE 24% → GONE 23% → PART 22% → NODIP 21%. LOW는 갭 12%라 제외
  const spec = [
    ['WIN', 2.00 / 1.25, 2.00, [[0, 1], [3, 1.02], [20, 0.94], [25, 0.95], [60, 1.06], [90, 0.97], [390, 0.97]]],     // 0.95에 체결 → +10% 목표 체결
    ['LOSE', 2.40 / 1.24, 2.40, [[0, 1], [40, 0.98], [50, 0.945], [70, 0.90], [390, 0.88]]],                          // WIN 끝난 뒤엔 이미 지정가 아래 → 바로 체결 → -5% 손절
    ['GONE', 2.50 / 1.23, 2.50, [[0, 1], [1, 0.93], [2, 1.05], [390, 1.1]]],                                          // 첫 2분에 눌렸다 반등 → 차례가 왔을 땐 안 쫓아감
    ['PART', 1.80 / 1.22, 1.80, [[0, 1], [240, 1.0], [255, 0.945], [265, 0.95], [290, 1.0], [388, 1.01], [390, 1.01]]], // 늦게 일부만 체결 → 목표 못 가고 15:58 정리
    ['NODIP', 1.50 / 1.21, 1.50, [[0, 1], [390, 1.2]]],                                                                // 안 눌림 (차례도 안 옴)
    ['LOW', 1.50 / 1.12, 1.50, [[0, 1], [10, 0.9], [390, 0.9]]],                                                       // 갭 12% → 제외
    ['LEV3', 1.00, 1.30, [[0, 1], [10, 0.9], [390, 0.9]]],                                                             // 레버리지 ETF → 제외
    ['PRICY', 5.00, 6.00, [[0, 1], [10, 0.9], [390, 0.9]]],
    ['AHW', 2.00, 2.10, [[0, 1], [300, 1.3], [390, 1.4], [392, 1.25], [397, 1.22], [430, 1.40], [700, 1.4]]],          // 애프터장: 종가 +47% → -10% 아래로 → 목표
    ['AHL', 2.00, 2.10, [[0, 1], [390, 1.3], [395, 1.15], [420, 0.9], [700, 0.9]]],                                       // 애프터장: -10% 체결 뒤 계속 빠짐 → 손절
    ['AHC', 1.30, 1.40, [[0, 1], [390, 1.4], [400, 1.22], [700, 1.235]]],                                                 // 애프터장: 체결 뒤 옆걸음 → 19:50 정리
    ['AHN', 1.30, 1.40, [[0, 1], [390, 1.45], [700, 1.5]]],                                                               // 애프터장: 안 빠짐 → 19:00 취소                                                            // $3 넘음 → 제외
  ];
  const M = new Map(spec.map(([s, pc, o, path]) => [s, { pc, o, path }]));
  const at = (s, t) => { const m = M.get(s); if (t < open) return m.o * 0.98; const x = (t - open) / MIN; const path = m.path;
    for (let i = 1; i < path.length; i++) if (x <= path[i][0]) { const [x0, y0] = path[i - 1], [x1, y1] = path[i]; return m.o * (y0 + (y1 - y0) * (x - x0) / (x1 - x0)); }
    return m.o * path[path.length - 1][1]; };
  const range = (s, t0, t1) => { let lo = Infinity, hi = -Infinity; for (let t = t0; t <= t1; t += 5000) { const v = at(s, t); lo = Math.min(lo, v); hi = Math.max(hi, v); } return { lo, hi }; };
  const book = s => { const q = at(s, now()); return { asks: [{ p: +(q + 0.01).toFixed(2), q: 5000 }], bids: [{ p: +(q - 0.01).toFixed(2), q: 5000 }] }; };
  const orders = new Map(); let oid = 0;
  const fillState = o => { // 지정가: 주문 뒤 가격이 그 아래(매수)/위(매도)로 거래되면 체결. PART 매수는 절반만
    if (TERMINAL.has(o.status) || o.b.orderType === 'MARKET') return;
    const r = range(o.b.symbol, o.at, now()), lim = Number(o.b.price), q = Number(o.b.quantity);
    if (o.b.side === 'BUY' && r.lo <= lim) { o.filled = o.b.symbol === 'PART' ? Math.floor(q / 2) : q; o.px = lim; o.status = o.filled === q ? 'FILLED' : 'PARTIAL_FILLED'; }
    if (o.b.side === 'SELL' && r.hi >= lim) { o.filled = q; o.px = lim; o.status = 'FILLED'; }
  };
  return {
    async accountSeq() { return 1; },
    async buyingPower() { return Number(process.env.GAP_MOCK_CASH ?? 26.35); },
    async holdings() { const q = (s, n, a, c = 'US') => ({ symbol: s, marketCountry: c, currency: c === 'US' ? 'USD' : 'KRW', quantity: String(n), lastPrice: String(c === 'US' ? at(s, now()) : 70000), averagePurchasePrice: String(a) });
      return { items: [q('NODIP', 3, 1.50), q('LOW', 5, 1.90), q('PRICY', 1, 6.00), q('WIN', 10, 1.00), q('005930', 1, 50000, 'KR')] }; }, // NODIP 오후에 +10% → 목표, LOW 바로 -20% 아래 → 손절, PRICY 그대로, WIN 갭 봇이 오늘 거래했으면 안 건드림, 한국 주식 안 건드림
    async session() { return { date: ymd(p), open, close }; },
    async ranking() { return [...M.keys()].map(s => ({ symbol: s, last: at(s, now()) })); },
    async prices(symbols) { return new Map(symbols.map(s => [s, at(s, now())])); },
    async candles(s, interval, count) {
      const m = M.get(s);
      if (interval === '1d') { const out = []; for (let i = 5; i >= 1; i--) out.push({ t: open - i * 24 * HOUR - 9.5 * HOUR, o: m.pc, h: m.pc, l: m.pc, c: m.pc, v: 1e6 }); out.push({ t: open - 9.5 * HOUR, o: m.o, h: m.o, l: m.o, c: at(s, now()), v: 1 }); return out; }
      // 토스처럼: t = 봉 끝 시각, 진행 중인 봉 포함, 프리장 봉도 섞여 옴 (프리장 가격은 시가×0.98 → 시가를 프리장 봉에서 읽으면 갭이 틀리게 찍힘)
      const out = []; for (let t = open - 30 * MIN; t < now(); t += MIN) { const e = Math.min(t + MIN - 1, now()), r = range(s, t, e); out.push({ t: t + MIN, o: at(s, t), h: r.hi, l: r.lo, c: at(s, e), v: 1000 }); } return out.slice(-count);
    },
    async orderbook(s) { return book(s); },
    async stockTypes(symbols) { return new Map(symbols.map(s => [s, s === 'LEV3' ? { type: 'ETF', lev: 3 } : { type: 'STOCK', lev: null }])); },
    async placeOrder(b) {
      if (orders.has(b.clientOrderId)) return { orderId: orders.get(b.clientOrderId).id };
      const id = `m${++oid}`, o = { id, b, filled: 0, px: NaN, at: now(), cancels: 0, status: 'PENDING' };
      if (b.orderType === 'MARKET' && b.side === 'SELL') { o.filled = Number(b.quantity); o.px = book(b.symbol).bids[0].p; o.status = 'FILLED'; }
      if (b.orderType === 'LIMIT' && b.side === 'SELL' && Number(b.price) <= book(b.symbol).bids[0].p) { o.filled = Number(b.quantity); o.px = book(b.symbol).bids[0].p; o.status = 'FILLED'; }
      if (b.orderType === 'LIMIT' && b.side === 'BUY' && Number(b.price) >= book(b.symbol).asks[0].p) { o.filled = Number(b.quantity); o.px = book(b.symbol).asks[0].p; o.status = 'FILLED'; }
      orders.set(b.clientOrderId, o); orders.set(id, o); return { orderId: id, clientOrderId: b.clientOrderId };
    },
    async getOrder(id) { const o = orders.get(id); fillState(o); return { status: o.status, filled: o.filled, avgPx: o.px }; },
    async cancelOrder(id) { const o = orders.get(id); fillState(o); o.cancels++;
      if (o.cancels === 1) { const e = new Error('409 already-processing'); e.status = 409; throw e; }   // 토스처럼 첫 취소는 한 번 거부
      if (!TERMINAL.has(o.status)) o.status = 'CANCELED'; return { orderId: id + 'c' }; },
  };
}

// ---------- 공통 (orb_paper.mjs와 같음) ----------
const fee = (notional, side) => Math.max(G.minFee, notional * G.commission) + (side === 'SELL' ? G.sellTax : 0);
const RANKS = [['TOP_GAINERS', '1d'], ['MARKET_TRADING_AMOUNT', 'realtime'], ['MARKET_TRADING_VOLUME', 'realtime'], ['TOSS_SECURITIES_TRADING_AMOUNT', 'realtime']];
const riskyType = t => t && (t.type === 'ETN' || (t.type === 'ETF' && t.lev !== 1));
const tick = p => (p >= 1 ? 0.01 : 0.0001);
const upTick = p => Math.ceil(p / tick(p) - 1e-9) * tick(p), downTick = p => Math.floor(p / tick(p) + 1e-9) * tick(p);
const fmtPx = p => (p >= 1 ? p.toFixed(2) : p.toFixed(4));
const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'REPLACED', 'CANCEL_REJECTED']);
const settled = o => !!o && TERMINAL.has(o.status);
async function finalFill(P, id, o) { // 체결 직후엔 평균 체결가가 덜 반영될 수 있어(11/20 SAGT: 처음 $1.09 → 최종 $1.095) 잠깐 뒤 한 번 더 확인
  if (MOCK) return o; await sleep(1500);
  try { const o2 = await P.getOrder(id); if (o2 && o2.status === 'FILLED' && o2.filled >= o.filled && o2.avgPx > 0) return o2; } catch { /* 처음 값 사용 */ }
  return o;
}
async function waitOrder(P, id, ms) {
  let o = null; const until = now() + ms;
  for (;;) { try { o = await P.getOrder(id); } catch (e) { log(`주문 ${id} 조회 실패: ${e.message}`); } if ((o && TERMINAL.has(o.status)) || now() >= until) return o?.status === 'FILLED' ? await finalFill(P, id, o) : o; await sleep(1000); }
}
async function cancelAndSettle(P, id) { // 취소하고 최종 체결 수량 확인. 주문 직후엔 토스가 409(처리 중)를 주므로 몇 번 다시 시도
  for (let i = 0; i < 12; i++) {
    try { await P.cancelOrder(id); break; }
    catch (e) {
      let o = null; try { o = await P.getOrder(id); } catch { /* 다음 시도에서 */ }
      if (o && TERMINAL.has(o.status)) return o.status === 'FILLED' ? await finalFill(P, id, o) : o;
      if (i === 0 || i === 11) log(`주문 ${String(id).slice(0, 10)}… 취소 ${i === 0 ? '대기(토스가 아직 처리 중)' : '계속 실패'}: ${e.message}`);
      await sleep(2000);
    }
  }
  return waitOrder(P, id, 20_000);
}
async function liveSell(P, sym, qty, cidBase, stepsIn) { // 지정가(매수호가-0.5%) → 지정가(-1.5%) → 시장가, 남은 수량만. stepsIn 주면 그 단계로(애프터장은 지정가만)
  let left = qty, got = 0, cost = 0, fees = 0; const ids = [];
  const steps = stepsIn ?? [['LIMIT', L.sellLimitPadPct], ['LIMIT', L.sellLimitPadPct + 0.01], ['MARKET', 0]];
  for (const [i, [type, pad]] of steps.entries()) {
    if (left <= 0) break;
    let bid = NaN; try { bid = (await P.orderbook(sym)).bids[0]?.p; } catch { /* 호가 실패 시 시장가로 */ }
    if (stepsIn && !(bid > 0)) { try { bid = (await P.prices([sym])).get(sym); } catch { /* 다음 단계 */ } if (!(bid > 0)) { log(`${sym} 매수호가·현재가를 못 받아 ${i + 1}차 매도 건너뜀`); continue; } }
    const body = { symbol: sym, side: 'SELL', orderType: type === 'LIMIT' && bid > 0 ? 'LIMIT' : 'MARKET', timeInForce: 'DAY', quantity: String(left), clientOrderId: `${cidBase}${i + 1}` };
    if (body.orderType === 'LIMIT') body.price = fmtPx(downTick(bid * (1 - pad)));
    let r; try { r = await P.placeOrder(body); } catch (e) { log(`${sym} 매도 주문 실패(${i + 1}차): ${e.message}`); continue; }
    ids.push(r.orderId);
    let o = await waitOrder(P, r.orderId, 10_000);
    if (!o || o.status !== 'FILLED') o = await cancelAndSettle(P, r.orderId);
    if (o && o.filled > 0) { got += o.filled; cost += o.filled * o.avgPx; left -= o.filled; fees += feeOf(o); }
    if (!settled(o)) return { sold: got, avgPx: got ? cost / got : NaN, left, ids, fees, pendingId: r.orderId };
  }
  return { sold: got, avgPx: got ? cost / got : NaN, left, ids, fees };
}
function prevClose(bars, sess, o) { // 오늘 일봉은 빼고 마지막 일봉의 종가. 토스 일봉 시각 표기를 몰라도 되게:
  // 시각이 개장 16시간 전 이후이거나(어제 봉은 아무리 늦게 찍혀도 개장 17.5시간 전) 시가가 오늘 9:30 시가와 같으면 오늘 봉으로 봄
  // 틀리면 '오늘 현재가'를 전일 종가로 잡아 갭이 작게 나옴 → 안 사는 쪽으로 틀림
  const isToday = b => b.t >= sess.open - 16 * HOUR || Math.abs(b.o / o - 1) < 0.005;
  const done = bars.filter(b => !isToday(b)); const last = done[done.length - 1];
  return last ? { c: last.c, t: last.t } : { c: NaN, t: NaN };
}

// ---------- 하루 ----------
async function findCandidates(P, sess, seen) {
  const lists = [];
  for (const [type, dur] of RANKS) { try { lists.push(await P.ranking(type, dur)); } catch (e) { log(`순위 ${type} 조회 실패: ${e.message}`); } }
  const fresh = [...new Map(lists.flat().filter(x => !seen.has(x.symbol) && x.last >= G.pxMin * 0.7 && x.last <= G.pxMax * 1.6).map(x => [x.symbol, x])).values()];
  let types = new Map(); try { types = await P.stockTypes(fresh.map(x => x.symbol)); } catch (e) { log(`종목 종류 조회 실패: ${e.message}`); if (LIVE) return []; }
  const out = []; let risky = 0;
  for (const x of fresh) {
    const t = types.get(x.symbol);
    if (riskyType(t) || (LIVE && !t)) { risky++; seen.add(x.symbol); continue; }
    let bars = [], daily = [];
    // 토스 분봉 t는 봉이 '끝나는' 시각 (2026-11-26 확인: 녹화 5초 현재가와 60초 어긋남, Massive 분봉 T = 토스 T+60).
    // 그래서 9:30~9:31 첫 정규장 봉은 t = 9:31. t = 9:30인 봉은 9:29 프리장 봉이라 시가로 쓰면 안 됨 (예전 버그)
    try { bars = (await P.candles(x.symbol, '1m', 200)).filter(b => b.t > sess.open); } catch { continue; }
    const b0 = bars.find(b => b.t === sess.open + MIN); if (!b0) continue; // 9:30 첫 분봉이 아직 없으면 다음에 다시
    const o = b0.o; if (!(o >= G.pxMin * 0.9 && o < G.pxMax * 1.1)) { seen.add(x.symbol); continue; }
    try { daily = await P.candles(x.symbol, '1d', 5); } catch { continue; }
    const pcx = prevClose(daily, sess, o), pc = pcx.c; if (!(pc > 0)) continue;
    seen.add(x.symbol);
    const gap = o / pc - 1;
    if (!(gap >= G.gapMin && o >= G.pxMin && o < G.pxMax)) continue;
    const level = downTick(o * (1 - G.dip)), ft = bars.find(b => b.l < level);
    out.push({ s: x.symbol, pc, pcT: pcx.t, o, gap, level, touchedAt: ft ? ft.t - MIN : null });   // 지정가에 처음 닿은 시각 (분봉 시작 시각)
  }
  log(`후보 찾기: 순위 종목 ${fresh.length}개 확인 (레버리지·인버스 ETF/ETN·종류 모름 ${risky}개 제외) → 갭 +${G.gapMin * 100}%↑·시가 $${G.pxMin}~${G.pxMax} ${out.length}개${out.length ? ': ' + out.map(c => `${c.s}(갭 ${pct(c.gap)}, 전일종가 $${c.pc}[일봉 ${kst(c.pcT)}], 시가 $${c.o}, 지정가 $${fmtPx(c.level)})`).join(', ') : ''}`);
  return out;
}

async function runDay(P, sess) {
  const S = LIVE ? loadState() : {}; S.cum ??= 0; S.days ??= {};
  const D = (S.days[sess.date] ??= { entries: 0, pnl: 0, done: [] });
  let pos = S.pos?.date === sess.date ? S.pos : null, buy = S.buy?.date === sess.date ? S.buy : null;
  const done = new Set(D.done), seen = new Set(), cands = [];
  const persist = () => { if (LIVE) { S.pos = pos; S.buy = buy; D.done = [...done]; saveState(S); } };
  if (now() < sess.open + 20_000) { log(`9:30 첫 분봉을 기다림 (${kst(sess.open + 20_000)}부터 후보 찾기)`); while (now() < sess.open + 20_000) await sleep(Math.min(10 * MIN, sess.open + 20_000 - now())); }
  const lastEntry = sess.open + G.lastEntryMin * MIN, flatAt = sess.close - 2 * MIN;
  let scans = 0, nextScan = now(), lastStatus = 0, lastBlock = '';
  const blocked = () => {
    if (existsSync(STOP_F)) return 'STOP_GAP 파일';
    if (!LIVE) return null;
    if (D.entries >= L.maxEntriesPerDay) return `하루 진입 ${L.maxEntriesPerDay}회`;
    if (D.pnl <= -L.dailyLossLimitUsd) return `하루 손실 한도 $${L.dailyLossLimitUsd}`;
    if (S.cum <= -L.totalLossLimitUsd) return `누적 손실 한도 $${L.totalLossLimitUsd}`;
    return null;
  };
  // --- 청산 기록 ---
  function record(p, reason, qty, px, ids, sellFee) { // 수수료는 토스가 알려준 실제 값(있으면), 없으면 추정
    const sf = Number.isFinite(sellFee) ? sellFee : fee(qty * px, 'SELL'), bf = Number.isFinite(p.buyFee) && p.qty0 > 0 ? p.buyFee * qty / p.qty0 : fee(qty * p.px, 'BUY');
    const pnl = qty * px - sf - (qty * p.px + bf), net = pnl / (qty * p.px);
    const theo = (reason === '목표' ? p.target : reason === '손절' ? p.stop : px) / p.level - 1;
    csvRow([sess.date, p.s, r4(p.pc), r4(p.o), pct(p.gap), r4(p.level), kst(p.orderT), kst(p.t), r4(p.px), qty, r4(p.target), r4(p.stop), kst(now()), reason, r4(px),
      reason === '손절' ? pct(px / p.stop - 1) : '', pct(px / p.px - 1), pct(net), pct(theo), pnl.toFixed(2), `${p.buyId || ''} ${ids || ''}`.trim()]);
    D.pnl += pnl; S.cum += pnl;
    log(`${p.s} 청산(${reason}) ${qty}주 $${r4(px)} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pct(net)})${LIVE ? ` | 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''}`);
  }
  // --- 보유 관리: 목표 지정가 체결 확인, 손절·마감·수동 정리 ---
  async function manage(lp) {
    const p = pos;
    if (LIVE && p.targetId) {
      let o = null; try { o = await P.getOrder(p.targetId); } catch (e) { log(`${p.s} 목표 주문 조회 실패: ${e.message}`); }
      if (o && o.filled > (p.tgtCounted || 0)) { const q = o.filled - (p.tgtCounted || 0); record(p, '목표', q, o.avgPx, p.targetId, feeOf(o) * q / o.filled); p.tgtCounted = o.filled; p.qty -= q; persist(); }
      if (o && o.status === 'FILLED' || p.qty <= 0) { pos = null; persist(); return; }
    }
    if (!LIVE && lp >= p.target) { record(p, '목표', p.qty, p.target, ''); pos = null; return; }
    const flatten = existsSync(FLAT_F), reason = flatten ? '수동정리' : now() >= flatAt ? '마감' : lp <= p.stop ? '손절' : null;
    if (!reason) return;
    if (!LIVE) { let bid = lp; try { bid = (await P.orderbook(p.s)).bids[0]?.p ?? lp; } catch { /* 현재가로 */ } record(p, reason, p.qty, bid, ''); pos = null; return; }
    if (p.targetId) { // 목표 주문부터 거둬들이고 (그 사이 체결된 건 목표로 기록) 남은 수량만 팜
      const o = await cancelAndSettle(P, p.targetId);
      if (!settled(o)) { log(`${p.s} 목표 주문 취소가 아직 확정 안 됨 — 다음 확인 때 다시`); return; }
      if (o.filled > (p.tgtCounted || 0)) { const q = o.filled - (p.tgtCounted || 0); record(p, '목표', q, o.avgPx, p.targetId, feeOf(o) * q / o.filled); p.qty -= q; }
      p.targetId = null; p.tgtCounted = 0; persist();
      if (p.qty <= 0) { pos = null; persist(); return; }
    }
    if (p.pendingSell) {
      let o = null; try { o = await P.getOrder(p.pendingSell); } catch { /* 다음에 */ }
      if (!settled(o)) o = await cancelAndSettle(P, p.pendingSell);
      if (!settled(o)) { log(`${p.s} 매도 주문이 아직 처리 중 — 다음 확인 때 다시`); return; }
      if (o.filled > 0) { record(p, reason, o.filled, o.avgPx, p.pendingSell, feeOf(o)); p.qty -= o.filled; }
      p.pendingSell = null; persist(); if (p.qty <= 0) { pos = null; persist(); return; }
    }
    const r = await liveSell(P, p.s, p.qty, `gap${sess.date.replace(/-/g, '')}${p.s}S${p.tries = (p.tries || 0) + 1}`);
    if (r.pendingId) p.pendingSell = r.pendingId;
    if (r.sold > 0) { record(p, reason, r.sold, r.avgPx, r.ids.join(' '), r.fees); p.qty -= r.sold; }
    else if (!r.pendingId) log(`${p.s} ${reason} 매도가 안 됨 — 다음 확인 때 다시 (토스 앱에서도 확인해 주세요)`);
    if (p.qty <= 0) pos = null; persist();
  }
  // --- 매수 체결 → 보유로 전환, 목표 지정가 매도 걸기 ---
  async function onFilled(b, qty, px, buyFee) {
    pos = { ...b, t: now(), px, qty, qty0: qty, buyFee, stop: px * (1 - G.sl), target: downTick(px * (1 + G.tp)), targetId: null, tgtCounted: 0 }; buy = null; D.entries++;
    log(`${b.s} ${LIVE ? '실제 ' : ''}매수 체결 ${qty}주 $${r4(px)} (시가 $${b.o}, 지정가 $${fmtPx(b.level)}) → 목표 $${fmtPx(pos.target)}, 손절 $${r4(pos.stop)}`);
    if (LIVE) {
      try { const r = await P.placeOrder({ symbol: b.s, side: 'SELL', orderType: 'LIMIT', timeInForce: 'DAY', quantity: String(qty), price: fmtPx(pos.target), clientOrderId: `gap${sess.date.replace(/-/g, '')}${b.s}T` }); pos.targetId = r.orderId; }
      catch (e) { log(`${b.s} 목표 지정가 매도 주문 실패: ${e.message} — 손절·마감만으로 관리`); }
    }
    persist();
  }
  async function checkBuy(lp) {
    if (!LIVE) { if (lp <= buy.level) await onFilled(buy, buy.qty, buy.level); else if (now() >= lastEntry) { log(`${buy.s} 14:30까지 지정가 안 닿음 — 주문 취소`); buy = null; } return; }
    let o = null; try { o = await P.getOrder(buy.id); } catch (e) { log(`${buy.s} 매수 주문 조회 실패: ${e.message}`); return; }
    const stopNew = existsSync(STOP_F) || existsSync(FLAT_F);
    if (o && o.status === 'FILLED') { o = await finalFill(P, buy.id, o); return onFilled(buy, o.filled, o.avgPx, feeOf(o)); }
    if (o && (o.filled > 0 || now() >= lastEntry || stopNew)) { // 일부 체결이면 나머지는 취소하고 체결된 만큼만 관리
      const f = await cancelAndSettle(P, buy.id);
      if (!settled(f)) { log(`${buy.s} 매수 주문 취소가 아직 확정 안 됨 — 다음 확인 때 다시`); return; }
      if (f.filled > 0) return onFilled(buy, f.filled, f.avgPx, feeOf(f));
      log(`${buy.s} 매수 주문 취소됨 (${stopNew ? '정지 파일' : '14:30까지 안 닿음'}) — 체결 없음`); buy = null; persist(); return;
    }
    if (o && TERMINAL.has(o.status)) { log(`${buy.s} 매수 주문이 ${o.status} 상태로 끝남 — 체결 없음`); buy = null; persist(); }
  }
  async function placeNext(px) {
    const why = blocked(); if (why) { if (why !== lastBlock) log(`새 주문 멈춤: ${why}`); lastBlock = why; return; }
    for (const c of cands.filter(c => !done.has(c.s)).sort((a, b) => b.gap - a.gap)) {
      const lp = px.get(c.s); if (!(lp > 0)) continue;
      try { const ft = (await P.candles(c.s, '1m', 200)).find(b => b.t > sess.open && b.l < c.level); if (ft) c.touchedAt = Math.min(c.touchedAt ?? Infinity, ft.t - MIN); } catch { /* 분봉 실패 시 지금까지 본 값으로 */ }
      // 백테스트는 지정가에 '처음' 닿을 때 삼. 다른 종목을 기다리는 사이 이미 닿았다면 그 거래는 벌써 시작(또는 끝)된 것 → 안 삼
      // 방금(2분 30초 안) 닿았고 지금도 지정가 이하면 그 '처음 닿음'에 늦게 올라타는 것이라 삼 (바로 체결됨)
      if (c.touchedAt != null && !(now() - c.touchedAt <= 2.5 * MIN && lp <= c.level)) { done.add(c.s); log(`${c.s}: ${kst(c.touchedAt).slice(6, 11)}에 이미 지정가 $${fmtPx(c.level)}에 닿았음 (지금 $${r4(lp)}) — 백테스트 거래는 그때 시작돼서 지금은 안 삼`); continue; }
      let notional = G.notional;
      if (ALL_CASH) { let bp = NaN; try { bp = await P.buyingPower(); } catch (e) { log(`주문 가능 금액 조회 실패: ${e.message}`); } if (!(bp > 0)) return; notional = bp * 0.98; } // 수수료·가격 반올림 여유 2%
      const qty = Math.floor(notional / c.level);
      if (qty < 1) { done.add(c.s); continue; }
      done.add(c.s); const b = { date: sess.date, s: c.s, pc: c.pc, o: c.o, gap: c.gap, level: c.level, qty, orderT: now(), id: null };
      if (LIVE) {
        try { const r = await P.placeOrder({ symbol: c.s, side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: String(qty), price: fmtPx(c.level), clientOrderId: `gap${sess.date.replace(/-/g, '')}${c.s}B` }); b.id = r.orderId; }
        catch (e) { log(`${c.s} 지정가 매수 주문 실패: ${e.message}`); persist(); continue; }
      }
      buy = b; persist();
      log(`${c.s} ${LIVE ? '실제 ' : ''}지정가 매수 주문 ${qty}주 $${fmtPx(c.level)} (시가 $${c.o} -5%, 갭 ${pct(c.gap)}, 현재가 $${r4(lp)})`);
      return;
    }
  }
  if (pos) log(`이어서 관리: 보유 ${pos.s} ${pos.qty}주`); if (buy) log(`이어서 관리: 매수 주문 ${buy.s} $${fmtPx(buy.level)}`);
  while (now() < sess.close + 5 * MIN) {
    if (now() < lastEntry && scans < 4 && now() >= nextScan) { // 9:30:20, 9:31, 9:33, 9:36 쯤 후보 찾기 (첫 분봉이 늦게 올라오는 종목 대비)
      for (const c of await findCandidates(P, sess, seen)) if (!cands.some(x => x.s === c.s)) cands.push(c);
      scans++; nextScan = now() + ([40_000, 2 * MIN, 3 * MIN][scans - 1] ?? 0);
      if (CHECK) return;
    }
    const syms = [...new Set([...(pos ? [pos.s] : []), ...(buy ? [buy.s] : []), ...cands.filter(c => !done.has(c.s)).map(c => c.s)])];
    let px = new Map();
    if (syms.length) { try { px = await P.prices(syms); } catch (e) { log(`현재가 조회 실패: ${e.message}`); await sleep(G.pollMs); continue; } }
    for (const c of cands) { const v = px.get(c.s); if (v > 0 && v < c.level && c.touchedAt == null) c.touchedAt = now(); }
    if (pos) await manage(px.get(pos.s));
    else if (buy) await checkBuy(px.get(buy.s));
    if (!pos && !buy && now() < lastEntry && now() < flatAt) await placeNext(px);
    if (!pos && !buy && (now() >= lastEntry || (scans >= 4 && cands.every(c => done.has(c.s))))) break;
    if (now() - lastStatus > 30 * MIN) { lastStatus = now(); log(`보유 ${pos ? `${pos.s} ${pos.qty}주` : '-'} / 매수 주문 ${buy ? `${buy.s} $${fmtPx(buy.level)}` : '-'} / 후보 ${cands.length}개${LIVE ? ` / 오늘 $${D.pnl.toFixed(2)} 누적 $${S.cum.toFixed(2)}` : ''}`); }
    await sleep(G.pollMs);
  }
  if (pos) log(`⚠ 장이 끝났는데 못 판 수량이 있어요: ${pos.s} ${pos.qty}주 — 토스 앱에서 직접 팔아 주세요`);
  persist();
  log(`=== ${sess.date} 끝: 후보 ${cands.length}개, 진입 ${D.entries}건${LIVE ? `, 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''} → ${DATA.split(/[\\/]/).slice(-2).join('/')}/trades.csv`);
}

// 같은 봇이 두 번 켜지지 않게 (2026-11-23 예전 봇·새 봇이 같이 돌았던 일). 기록 폴더마다 running.pid
const LOCK_F = join(DATA, 'running.pid');
function takeLock() {
  try { const old = Number(readFileSync(LOCK_F, 'utf8')); if (old && old !== process.pid) { try { process.kill(old, 0); log(`이미 다른 창에서 돌고 있어요(pid ${old}) — 여기선 안 켤게요. 하나만 켜야 주문이 겹치지 않아요`); return false; } catch { /* 이미 꺼진 pid */ } } } catch { /* 처음 */ }
  writeFileSync(LOCK_F, String(process.pid));
  const clear = () => { try { if (Number(readFileSync(LOCK_F, 'utf8')) === process.pid) unlinkSync(LOCK_F); } catch { /* 없음 */ } };
  process.on('exit', clear); for (const sg of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) { try { process.on(sg, () => { clear(); process.exit(0); }); } catch { /* 없는 신호 */ } }
  return true;
}
async function main() {
  if (!MOCK && !CHECK && !ONCE && !takeLock()) { process.exitCode = 3; return; }
  const P = MOCK ? mockProvider() : liveProvider();
  if (HOLD) return holdMain(P);
  if (AH) return ahMain(P);
  log(LIVE ? `시작 — ⚠ 실전: 토스에 실제 주문. 거래당 ${ALL_CASH ? '주문 가능 달러 현금 전부(×0.98)' : '$' + L.perTradeUsd}, 하루 최대 ${L.maxEntriesPerDay}회, 하루 손실 한도 $${L.dailyLossLimitUsd}, 누적 손실 한도 $${L.totalLossLimitUsd}`
           : `시작 ${MOCK ? '(가상 시장)' : ''}${CHECK ? '(후보 찾기만)' : ''} — 주문 없이 가상 매매만. 거래당 $${G.notional}`);
  log(`규칙: 갭 +${G.gapMin * 100}%↑·시가 $${G.pxMin}~${G.pxMax} → 시가 -${G.dip * 100}% 지정가 매수 → 목표 +${G.tp * 100}% / 손절 -${G.sl * 100}% / 15:58 정리. 멈추기: orb\\STOP_GAP, 다 팔기: orb\\FLATTEN_GAP`);
  if (LIVE) log(`계좌 accountSeq ${await P.accountSeq()}`);
  for (;;) {
    const sess = await P.session(now());
    if (sess.closed || now() > sess.close + 5 * MIN) { if (MOCK || CHECK) return log(`${sess.date} ${sess.closed ? '휴장' : '장 끝남'}`); log(`${sess.date} ${sess.closed ? '휴장' : '장 끝남'} — 1시간 뒤 다시 확인`); await sleep(HOUR); continue; }
    if (now() < sess.open - 10 * MIN && !CHECK) { log(`${sess.date} 정규장 ${kst(sess.open)} 시작 — 10분 전까지 대기`); while (now() < sess.open - 10 * MIN) await sleep(Math.min(10 * MIN, sess.open - 10 * MIN - now())); }
    if (CHECK && now() < sess.open + 20_000) return log(`정규장(${kst(sess.open)}) 시작 뒤에 --check 하면 오늘 후보를 보여 줘요`);
    try { await runDay(P, sess); } catch (e) { log(`오류로 오늘 중단: ${e.message}${LIVE ? ' — 보유 종목·주문이 남았을 수 있으니 다시 실행하거나 토스 앱에서 확인해 주세요' : ''}`); }
    if (MOCK || CHECK) return;
    await sleep(Math.max(5 * MIN, sess.close - now() + 10 * MIN));
  }
}
// ---------- 보유 주식 관리 (--hold): 봇이 사지 않은 미국 주식(원래 갖고 있던 것·앱에서 직접 산 것)도
// 평균 매입가 대비 +10% 이상이면 팔고 -20% 이하면 팖. 장 마감 정리는 안 함. 2026-11-24 사용자: "이미 매수한 것도 인식하도록" → "손절·목표 적용"
// 실행: node orb/gap_dip.mjs --hold [--once] (연습: 주문 없이 기록만) / --hold --live (실제 매도). 멈추기: orb\STOP_HOLD. 기록: orb/data-hold[-live]/
const STOP_HOLD_F = join(HERE, 'STOP_HOLD');
const HOLD_SKIP_F = join(HERE, 'hold_skip.txt'); // 건너뛸 종목 (한 줄에 하나, # 뒤는 메모). 매번 다시 읽어서 고치면 바로 반영
const holdSkip = () => { try { return new Set(readFileSync(HOLD_SKIP_F, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim().toUpperCase()).filter(Boolean)); } catch { return new Set(); } };
const GAP_STATE_F = join(HERE, (MOCK ? 'data-gap-mock' : 'data-gap') + (LIVE ? '-live' : ''), 'state.json');
const sv = v => (typeof v === 'string' ? v : String(v?.code ?? v?.value ?? v?.name ?? ''));
const HOLD_HEADER = ['날짜(ET)', '시각(KST)', '종목', '사유', '보유수량', '평균매입가', '판단가', '판단수익률', '매도수량', '매도평균가', '손익USD(평균매입가 대비)', '모드', '주문ID'];
function holdCsv(row) { const f = join(DATA, 'trades.csv'); if (!existsSync(f)) appendFileSync(f, '﻿' + HOLD_HEADER.join(',') + '\n'); appendFileSync(f, row.map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v}"` : v)).join(',') + '\n'); }
async function holdScan(P, sess, done, noted) {
  if (existsSync(STOP_HOLD_F)) { if (!noted.has('#stop')) log('STOP_HOLD 파일이 있어서 매도 안 함'); noted.add('#stop'); return; }
  noted.delete('#stop');
  let h; try { h = await P.holdings(); } catch (e) { log(`보유 주식 조회 실패: ${e.message}`); return; }
  const items = Array.isArray(h) ? h : h?.items;
  if (!Array.isArray(items)) { log(`보유 주식 응답 모양이 예상과 달라요 — 매도 안 함: ${JSON.stringify(h).slice(0, 200)}`); return; }
  let gs = {}; try { gs = JSON.parse(readFileSync(GAP_STATE_F, 'utf8') || '{}'); } catch { /* 갭 봇 기록 없음 */ }
  const gapSyms = new Set(gs.days?.[sess.date]?.done ?? []); if (gs.pos?.s) gapSyms.add(gs.pos.s); if (gs.buy?.s) gapSyms.add(gs.buy.s);
  const us = items.filter(x => sv(x.marketCountry) === 'US' && num(x.quantity) > 0 && num(x.averagePurchasePrice) > 0 && !done.has(x.symbol));
  const skip = holdSkip();
  const todo = us.filter(x => { const why = gapSyms.has(x.symbol) ? '갭 봇이 오늘 거래한 종목' : skip.has(String(x.symbol).toUpperCase()) ? 'hold_skip.txt에 적힌 종목' : null; if (!why) return true; if (!noted.has(x.symbol)) log(`${x.symbol}: ${why}이라 안 건드림`); noted.add(x.symbol); return false; });
  if (!noted.has('#first')) { noted.add('#first'); log(`보유 미국 주식 ${us.length}종목 확인 (관리 대상 ${todo.length}종목)`); }
  if (!todo.length) return;
  let px = new Map(); try { px = await P.prices(todo.map(x => x.symbol)); } catch (e) { log(`현재가 조회 실패 — 보유 주식 화면 가격으로 판단: ${e.message}`); }
  for (const x of todo) {
    const s = x.symbol, qty = Math.floor(num(x.quantity)), avg = num(x.averagePurchasePrice), lp = px.get(s) > 0 ? px.get(s) : num(x.lastPrice);
    if (!(qty >= 1) || !(lp > 0)) continue;
    const ch = lp / avg - 1, why = ch >= G.tp ? '목표' : ch <= -G.sl ? '손절' : null;
    if (!why) continue;
    done.add(s); // 하루 한 번만 시도
    if (ch > 3) { log(`${s}: 평균 매입가 대비 ${pct(ch)} — 분할·병합 뒤 표시 오류일 수 있어 안 팖 (진짜 수익이면 토스 앱에서 직접 파세요)`); continue; } // 2026-11-24 PARA(병합 중) +3547% 표시
    if (!LIVE) { log(`[연습] ${s} ${qty}주 ${why} 매도할 것 — 평균 매입가 $${r4(avg)}, 지금 $${r4(lp)} (${pct(ch)})`); holdCsv([sess.date, kst(now()), s, why, qty, r4(avg), r4(lp), pct(ch), '', '', '', '연습', '']); continue; }
    log(`${s} ${qty}주 ${why} 매도 시작 — 평균 매입가 $${r4(avg)}, 지금 $${r4(lp)} (${pct(ch)})`);
    let r; try { r = await liveSell(P, s, qty, `hold${sess.date.replace(/-/g, '')}${s}S`); } catch (e) { log(`${s} 매도 실패: ${e.message}`); continue; }
    const sf = Number.isFinite(r.fees) ? r.fees : (r.sold > 0 ? fee(r.sold * r.avgPx, 'SELL') : 0), pnl = r.sold > 0 ? r.sold * (r.avgPx - avg) - sf : 0;
    log(`${s} ${why} 매도 ${r.sold}/${qty}주${r.sold ? ` 평균 $${r4(r.avgPx)} → 평균 매입가 대비 ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : ''}${r.pendingId ? ' (주문 처리 중 — 토스 앱에서 확인해 주세요)' : r.left > 0 ? ` — ${r.left}주 못 팜 (토스 앱에서 확인해 주세요)` : ''}`);
    holdCsv([sess.date, kst(now()), s, why, qty, r4(avg), r4(lp), pct(ch), r.sold, r4(r.avgPx), pnl.toFixed(2), '실전', r.ids.join(' ')]);
  }
}
async function holdMain(P) {
  log(`시작 — 보유 주식 관리 ${LIVE ? '⚠ 실전: 토스에 실제 매도 주문' : '(연습: 주문 없이 기록만)'}. 봇이 사지 않은 미국 주식을 평균 매입가 대비 +${G.tp * 100}% 이상이면 팔고 -${G.sl * 100}% 이하면 팜(1분마다, 정규장만, 종목당 하루 한 번). 한국 주식·갭 봇이 오늘 거래한 종목은 안 건드림. 멈추기: orb\\STOP_HOLD`);
  if (LIVE) log(`계좌 accountSeq ${await P.accountSeq()}`);
  for (;;) {
    const sess = await P.session(now());
    if (sess.closed || now() > sess.close - 2 * MIN) { if (MOCK || ONCE) return log(`${sess.date} ${sess.closed ? '휴장' : '장 끝남'}`); log(`${sess.date} ${sess.closed ? '휴장' : '장 끝남'} — 1시간 뒤 다시 확인`); await sleep(HOUR); continue; }
    if (now() < sess.open + MIN) { if (ONCE) return log(`정규장(${kst(sess.open)}) 시작 1분 뒤부터 확인해요`); log(`${sess.date} 정규장 ${kst(sess.open)} 시작 1분 뒤부터 확인`); while (now() < sess.open + MIN) await sleep(Math.min(10 * MIN, sess.open + MIN - now())); }
    const done = new Set(), noted = new Set();
    while (now() < sess.close - 2 * MIN) {
      try { await holdScan(P, sess, done, noted); } catch (e) { log(`확인 중 오류: ${e.message}`); }
      if (ONCE) return log('한 번 확인 끝');
      await sleep(MIN);
    }
    log(`${sess.date} 보유 주식 관리 끝 (매도 시도 ${done.size}종목)`);
    if (MOCK) return;
  }
}
// ---------- 애프터장 (--ah): 정규장 종가 +15%↑·$1~20 종목을 종가 -10%에 지정가 매수(19:00까지) → +10% 지정가 매도 / -20% 손절 / 19:50 정리 ----------
// 2026-11-24 백테스트 history/mine/ah_search.py·ah_check.py: 2년 1,900건 거래당 +1.75%(t=6.3), 찾기 +1.37%·확인 +2.08%·최종 +2.11%, 스프레드 4.11%로도 +1.07%
// 실행: node orb/gap_dip.mjs --ah (연습: 주문 없이 현재가로 가상 체결) / --ah --live (실제 주문 — 토스 API 주문이 애프터장에 들어가는지 확인 뒤에). 멈추기: orb\STOP_AH
// 돈은 주문 가능 달러 현금×0.98을 후보 수(최대 AH_MAX, 기본 5)로 나눠 동시에 걸어 둠. 애프터장은 시장가가 안 될 수 있어 매도도 지정가만(매수호가 -1% → -3% → -6%).
const AHG = { gainMin: 0.15, pxMin: 1, pxMax: 20, dip: 0.10, tp: 0.10, sl: 0.20, maxCands: Number(process.env.AH_MAX ?? 5), lastEntryMin: 180, exitMin: 230 };
const STOP_AH_F = join(HERE, 'STOP_AH');
const AH_SELL_STEPS = [['LIMIT', 0.01], ['LIMIT', 0.03], ['LIMIT', 0.06]];
const AH_HEADER = ['날짜(ET)', '종목', '전일종가', '정규장종가', '상승률', '지정가', '체결(KST)', '체결가', '수량', '목표가', '손절가', '청산(KST)', '청산사유', '청산가', '손익USD', '수익률', '모드'];
function ahCsv(row) { const f = join(DATA, 'trades.csv'); if (!existsSync(f)) appendFileSync(f, '﻿' + AH_HEADER.join(',') + '\n'); appendFileSync(f, row.map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v}"` : v)).join(',') + '\n'); }
async function ahCandidates(P, sess) {
  const lists = []; for (const [type, dur] of RANKS) { try { lists.push(await P.ranking(type, dur)); } catch (e) { log(`순위 ${type} 조회 실패: ${e.message}`); } }
  const fresh = [...new Map(lists.flat().filter(x => x.last >= AHG.pxMin * 0.7 && x.last <= AHG.pxMax * 1.3).map(x => [x.symbol, x])).values()];
  let types = new Map(); try { types = await P.stockTypes(fresh.map(x => x.symbol)); } catch (e) { log(`종목 종류 조회 실패: ${e.message}`); if (LIVE) return []; }
  const out = []; let risky = 0, nodata = 0;
  for (const x of fresh) {
    const t = types.get(x.symbol);
    if (riskyType(t) || t?.type === 'ETF' || (LIVE && !t)) { risky++; continue; } // 백테스트는 ETF·ETN 전부 제외
    let bars = [], daily = [];
    try { bars = (await P.candles(x.symbol, '1m', 40)).filter(b => b.t > sess.close - 30 * MIN && b.t <= sess.close); daily = await P.candles(x.symbol, '1d', 5); } catch { nodata++; continue; } // 분봉 t = 끝 시각 → 마지막 봉(t = 16:00)의 종가가 정규장 종가
    const last = bars[bars.length - 1], pc = prevClose(daily, sess, NaN).c;
    if (!last || !(pc > 0)) { nodata++; continue; }
    const close = last.c, gain = close / pc - 1;
    if (gain >= AHG.gainMin && close >= AHG.pxMin && close < AHG.pxMax) out.push({ s: x.symbol, pc, close, gain, level: downTick(close * (1 - AHG.dip)) });
  }
  out.sort((a, b) => b.gain - a.gain);
  log(`애프터장 후보: 순위 종목 ${fresh.length}개 확인 (ETF·ETN·레버리지·종류 모름 ${risky}개, 분봉·일봉 없음 ${nodata}개 제외) → 종가 +${AHG.gainMin * 100}%↑·$${AHG.pxMin}~${AHG.pxMax} ${out.length}개${out.length ? ': ' + out.map(c => `${c.s}(${pct(c.gain)}, 종가 $${r4(c.close)} → 지정가 $${fmtPx(c.level)})`).join(', ') : ''}`);
  return out.slice(0, AHG.maxCands);
}
async function ahDay(P, sess) {
  const S = LIVE ? loadState() : {}; S.cum ??= 0; S.days ??= {}; const D = (S.days[sess.date] ??= { entries: 0, pnl: 0 });
  const persist = () => { if (LIVE) saveState(S); }, dateTag = sess.date.replace(/-/g, '');
  const blocked = () => existsSync(STOP_AH_F) ? 'STOP_AH 파일' : !LIVE ? null : D.pnl <= -L.dailyLossLimitUsd ? `하루 손실 한도 $${L.dailyLossLimitUsd}` : S.cum <= -L.totalLossLimitUsd ? `누적 손실 한도 $${L.totalLossLimitUsd}` : null;
  const lastEntry = sess.close + AHG.lastEntryMin * MIN, exitAt = sess.close + AHG.exitMin * MIN;
  if (D.entries > 0) return log(`${sess.date} 애프터장은 이미 주문함 — 다시 켠 경우 남은 주문·보유는 토스 앱에서 확인해 주세요`);
  const why = blocked(); if (why) return log(`새 주문 멈춤: ${why}`);
  const cands = await ahCandidates(P, sess); if (!cands.length) return log('애프터장 후보 없음');
  let cash = NaN; try { cash = await P.buyingPower(); } catch (e) { log(`주문 가능 금액 조회 실패: ${e.message}`); }
  if (!(cash > 0)) { if (LIVE) return log('주문 가능 금액을 몰라서 안 삼'); cash = 50; }
  let px0 = new Map(); try { px0 = await P.prices(cands.map(c => c.s)); } catch { /* 현재가 없이 */ }
  const legs = [], share = cash * 0.98 / cands.length;
  for (const c of cands) {
    const lp = px0.get(c.s);
    if (lp > 0 && lp <= c.level) { log(`${c.s}: 이미 지정가 $${fmtPx(c.level)} 아래(지금 $${r4(lp)}) — 백테스트는 처음 닿을 때 사서 안 삼`); continue; }
    const qty = Math.floor(share / c.level); if (qty < 1) { log(`${c.s}: 나눈 돈 $${share.toFixed(2)}로 1주도 못 사서 건너뜀`); continue; }
    const g = { ...c, qty, st: 'buy', id: null };
    if (LIVE) { try { g.id = (await P.placeOrder({ symbol: c.s, side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', quantity: String(qty), price: fmtPx(c.level), clientOrderId: `ah${dateTag}${c.s}B` })).orderId; } catch (e) { log(`${c.s} 지정가 매수 주문 실패: ${e.message}`); continue; } }
    log(`${c.s} ${LIVE ? '실제 ' : '[연습] '}지정가 매수 주문 ${qty}주 $${fmtPx(c.level)} (정규장 종가 $${r4(c.close)} -10%, 상승 ${pct(c.gain)})`);
    D.entries++; legs.push(g);
  }
  persist(); if (!legs.length) return;
  function rec(g, reason, qty, px, sellFee) {
    const sf = Number.isFinite(sellFee) ? sellFee : fee(qty * px, 'SELL'), bf = Number.isFinite(g.buyFee) && g.qty0 > 0 ? g.buyFee * qty / g.qty0 : fee(qty * g.px, 'BUY');
    const pnl = qty * px - sf - (qty * g.px + bf), net = pnl / (qty * g.px);
    ahCsv([sess.date, g.s, r4(g.pc), r4(g.close), pct(g.gain), fmtPx(g.level), kst(g.t), r4(g.px), qty, fmtPx(g.target), r4(g.stop), kst(now()), reason, r4(px), pnl.toFixed(2), pct(net), LIVE ? '실전' : '연습']);
    D.pnl += pnl; S.cum += pnl; g.qty -= qty; if (g.qty <= 0) g.st = 'done'; persist();
    log(`${g.s} ${LIVE ? '' : '[연습] '}청산(${reason}) ${qty}주 $${r4(px)} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pct(net)})${LIVE ? ` | 애프터장 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''}`);
  }
  async function filled(g, qty, px, buyFee) {
    Object.assign(g, { st: 'hold', qty, qty0: qty, px, buyFee, t: now(), stop: px * (1 - AHG.sl), target: downTick(px * (1 + AHG.tp)), targetId: null });
    log(`${g.s} ${LIVE ? '실제 ' : '[연습] '}매수 체결 ${qty}주 $${r4(px)} → 목표 $${fmtPx(g.target)}, 손절 $${r4(g.stop)}`);
    if (LIVE) { try { g.targetId = (await P.placeOrder({ symbol: g.s, side: 'SELL', orderType: 'LIMIT', timeInForce: 'DAY', quantity: String(qty), price: fmtPx(g.target), clientOrderId: `ah${dateTag}${g.s}T` })).orderId; } catch (e) { log(`${g.s} 목표 지정가 매도 주문 실패: ${e.message} — 손절·19:50 정리만`); } }
  }
  async function manage(g, lp, timeUp) {
    if (LIVE && g.targetId) {
      let o = null; try { o = await P.getOrder(g.targetId); } catch { /* 다음에 */ }
      if (o?.status === 'FILLED') { o = await finalFill(P, g.targetId, o); g.targetId = null; return rec(g, '목표', o.filled, o.avgPx, feeOf(o)); }
    }
    if (!LIVE && lp >= g.target) return rec(g, '목표', g.qty, g.target);
    const reason = timeUp ? '19:50 정리' : lp > 0 && lp <= g.stop ? '손절' : existsSync(FLAT_F) ? '수동정리' : null;
    if (!reason) return;
    if (!LIVE) { let bid = lp; try { bid = (await P.orderbook(g.s)).bids[0]?.p ?? lp; } catch { /* 현재가로 */ } return rec(g, reason, g.qty, bid); }
    if (g.targetId) {
      const o = await cancelAndSettle(P, g.targetId); if (!settled(o)) return log(`${g.s} 목표 주문 취소가 아직 확정 안 됨 — 다음 확인 때 다시`);
      if (o.filled > 0) rec(g, '목표', o.filled, o.avgPx, feeOf(o) * 1); g.targetId = null; if (g.qty <= 0) return;
    }
    if (g.pendingSell) {
      let o = null; try { o = await P.getOrder(g.pendingSell); } catch { /* 다음에 */ }
      if (!settled(o)) o = await cancelAndSettle(P, g.pendingSell); if (!settled(o)) return;
      if (o.filled > 0) rec(g, reason, o.filled, o.avgPx, feeOf(o)); g.pendingSell = null; if (g.qty <= 0) return;
    }
    const r = await liveSell(P, g.s, g.qty, `ah${dateTag}${g.s}S${g.tries = (g.tries || 0) + 1}`, AH_SELL_STEPS);
    if (r.pendingId) g.pendingSell = r.pendingId;
    if (r.sold > 0) rec(g, reason, r.sold, r.avgPx, r.fees);
    if (g.qty > 0 && !r.pendingId) log(`${g.s} ${reason} 매도 덜 됨 — 남은 ${g.qty}주는 다음 확인 때 다시`);
  }
  while (legs.some(g => g.st !== 'done')) {
    const t = now(); let px = new Map(); try { px = await P.prices(legs.filter(g => g.st !== 'done').map(g => g.s)); } catch (e) { log(`현재가 조회 실패: ${e.message}`); }
    for (const g of legs) {
      const lp = px.get(g.s);
      if (g.st === 'buy') {
        const stopNew = existsSync(STOP_AH_F) || existsSync(FLAT_F);
        if (!LIVE) { if (lp > 0 && lp <= g.level) await filled(g, g.qty, g.level); else if (t >= lastEntry || stopNew) { log(`${g.s} [연습] ${stopNew ? '정지 파일' : '19:00까지 안 닿음'} — 매수 취소`); g.st = 'done'; } continue; }
        let o = null; try { o = await P.getOrder(g.id); } catch (e) { log(`${g.s} 매수 주문 조회 실패: ${e.message}`); continue; }
        if (o?.status === 'FILLED') { o = await finalFill(P, g.id, o); await filled(g, o.filled, o.avgPx, feeOf(o)); continue; }
        if (o && TERMINAL.has(o.status)) { log(`${g.s} 매수 주문이 ${o.status} 상태로 끝남 — 체결 없음`); g.st = 'done'; continue; }
        if (t >= lastEntry || stopNew) { const f = await cancelAndSettle(P, g.id); if (!settled(f)) continue; if (f.filled > 0) await filled(g, f.filled, f.avgPx, feeOf(f)); else { log(`${g.s} ${stopNew ? '정지 파일' : '19:00까지 안 닿음'} — 매수 취소`); g.st = 'done'; } }
        continue;
      }
      if (g.st === 'hold') await manage(g, lp, t >= exitAt);
    }
    if (t >= exitAt + 8 * MIN) { for (const g of legs) if (g.st === 'hold') log(`⚠ ${g.s} ${g.qty}주를 19:58까지 못 팔았어요 — 토스 앱에서 확인해 주세요(다음 날엔 보유 주식 관리 규칙을 받음)`); break; }
    await sleep(MOCK ? 60_000 : 3000);
  }
  log(`=== ${sess.date} 애프터장 끝: 주문 ${legs.length}건${LIVE ? `, 오늘 $${D.pnl.toFixed(2)}, 누적 $${S.cum.toFixed(2)}` : ''}`);
}
async function ahMain(P) {
  log(`시작 — 애프터장 ${LIVE ? '⚠ 실전: 토스에 실제 주문' : '(연습: 주문 없이 현재가로 가상 체결)'}. 정규장 종가 +${AHG.gainMin * 100}%↑·$${AHG.pxMin}~${AHG.pxMax}(ETF·ETN 제외) 최대 ${AHG.maxCands}종목 → 종가 -${AHG.dip * 100}%에 지정가 매수(19:00까지) → 목표 +${AHG.tp * 100}% / 손절 -${AHG.sl * 100}% / 19:50 정리. 돈은 주문 가능 달러 현금을 나눠 씀. 멈추기: orb\\STOP_AH`);
  if (LIVE) log(`계좌 accountSeq ${await P.accountSeq()}${L ? ` — 한도: 하루 손실 $${L.dailyLossLimitUsd}, 누적 $${L.totalLossLimitUsd} (애프터장 따로 셈)` : ''}`);
  for (;;) {
    const sess = await P.session(now());
    if (sess.closed) { if (MOCK || ONCE) return log(`${sess.date} 휴장`); log(`${sess.date} 휴장 — 1시간 뒤 다시 확인`); await sleep(HOUR); continue; }
    if (now() > sess.close + AHG.lastEntryMin * MIN) { if (MOCK || ONCE) return log(`${sess.date} 애프터장 매수 시간(19:00 ET) 지남`); log(`${sess.date} 애프터장 매수 시간 지남 — 1시간 뒤 다시 확인`); await sleep(HOUR); continue; }
    if (now() < sess.close + 20_000) { log(`${sess.date} 정규장 마감(${kst(sess.close)}) 20초 뒤 후보 찾기`); while (now() < sess.close + 20_000) await sleep(Math.min(10 * MIN, sess.close + 20_000 - now())); }
    try { await ahDay(P, sess); } catch (e) { log(`오류로 오늘 애프터장 중단: ${e.message}${LIVE ? ' — 남은 주문·보유를 토스 앱에서 확인해 주세요' : ''}`); }
    if (MOCK || ONCE) return;
    await sleep(Math.max(5 * MIN, sess.close + 4 * HOUR + 10 * MIN - now()));
  }
}
main().catch(e => { log(`멈췄어요: ${e.message}`); process.exit(1); });
