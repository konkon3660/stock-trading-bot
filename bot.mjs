// toss-paper-bot v7 — 급등주 단타 페이퍼 트레이딩 (전략 여러 개 동시 비교, 데이마켓·프리·정규·애프터 4세션 녹화)
// - 실제 주문 코드는 없습니다. 토큰 발급과 조회(GET: 순위·현재가·분봉·일봉·호가·종목정보·장 운영시간·환율)만 합니다.
// - 세 전략이 같은 시세를 보면서 각자 가상 계좌로 매매합니다. 어떤 신호가 실제로 도움이 되는지 비교하려는 구조예요.
//   A 돌파 기본 / B 돌파 + 필터(VWAP·과열·윗꼬리·저점상승·호가잔량·주식수·상대거래량) / C 눌림목 재돌파
// - 체결은 '그 순간 호가창'으로 시뮬레이션합니다(보이는 물량의 일부만 내 몫, 물량이 없으면 체결도 없음).
// 실행:  node bot.mjs                    실시간 시세로 페이퍼 트레이딩
//        node bot.mjs --mock             키 없이 가상 시장으로 하루 시뮬레이션 (--seed=N 으로 다른 하루)
//        node bot.mjs --mock --scenario=edge   호가 실종·시간손절·장마감 물량 부족 점검
//        node bot.mjs --mock --fullday         가상 시장을 데이마켓부터 애프터장까지 24시간 돌림 (--record 를 붙이면 녹화도)
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = process.argv.includes('--mock');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const REPLAY = arg('replay');                 // --replay=2026-11-13 : 녹화된 장을 다시 돌림
const SIM = MOCK || !!REPLAY;                 // 가상 시계를 쓰는 모드
const CFG_FILE = arg('config') || 'config.json';
const CFG = JSON.parse(readFileSync(resolve(HERE, CFG_FILE), 'utf8'));
const DATA = REPLAY ? join(HERE, 'data-replay', `${REPLAY}_${arg('label') || CFG_FILE.replace(/\.json$/, '')}`) : join(HERE, MOCK ? 'data-mock' : 'data');
mkdirSync(DATA, { recursive: true });
if (SIM) for (const f of ['events.log', 'paper_trades.csv', 'daily_summary.csv']) if (existsSync(join(DATA, f))) writeFileSync(join(DATA, f), ''); // 가상 실행은 매번 새로
const BASE = 'https://openapi.tossinvest.com';
const STRATS = CFG.strategies.filter(s => s.enabled !== false);

// ---------- 시간 ----------
let simNow = 0;
const now = () => (SIM ? simNow : Date.now());
const sleep = ms => (SIM ? Promise.resolve() : new Promise(r => setTimeout(r, ms)));
const MIN = 60_000, HOUR = 3_600_000;
function nthSunday(y, m, n) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (n - 1) * 7; }
function etOffset(ms) { // 미국 동부: 3월 둘째 일요일 ~ 11월 첫째 일요일은 UTC-4, 그 외 UTC-5
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return ms >= start && ms < end ? -4 : -5;
}
function etParts(ms) { const d = new Date(ms + etOffset(ms) * HOUR); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
function etToMs(y, mo, d, h, mi) { const naive = Date.UTC(y, mo, d, h, mi); return naive - etOffset(naive + 5 * HOUR) * HOUR; }
const ymd = p => `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const kst = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5, 16);
function defaultSession(ms) {
  const p = etParts(ms); if (p.dow === 0 || p.dow === 6) return null;
  return withPhases({ date: ymd(p), open: etToMs(p.y, p.mo, p.d, 9, 30), close: etToMs(p.y, p.mo, p.d, 16, 0) });
}
// 토스 미국주식 4세션 (한국시간, 서머타임 해제 기준): 데이마켓 10:00~18:00, 프리 18:00~23:30, 정규 23:30~06:00, 애프터 06:00~09:50
// 장 운영시간 API(dayMarket·preMarket·regularMarket·afterMarket)가 주는 시간을 쓰고, 없으면 정규장 기준으로 추정
// 데이마켓은 '그날 밤 정규장'과 같은 거래일(미국 날짜)로 묶음
function withPhases(s, given = {}) {
  if (!s) return s;
  const ok = w => w && Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s;
  s.day = ok(given.day) ? given.day : { s: s.open - 13.5 * HOUR, e: s.open - 5.5 * HOUR - 10 * MIN };
  s.pre = ok(given.pre) ? given.pre : { s: s.open - 5.5 * HOUR, e: s.open };
  s.after = ok(given.after) ? given.after : { s: s.close, e: s.close + 4 * HOUR - 10 * MIN };
  return s;
}
const PHASE_KO = { day: '데이마켓', pre: '프리장', regular: '정규장', after: '애프터장' };
function phaseOf(s, t) {
  if (!s) return null;
  if (t >= s.open && t < s.close) return 'regular';
  if (s.pre && t >= s.pre.s && t < s.pre.e) return 'pre';
  if (s.after && t >= s.after.s && t < s.after.e) return 'after';
  if (s.day && t >= s.day.s && t < s.day.e) return 'day';
  return null;
}
const winOf = (s, ph) => (ph === 'regular' ? { s: s.open, e: s.close } : s[ph]);
const stSess = st => st.sessions || ['regular']; // 전략이 매매하는 세션 (기본: 정규장만)

// ---------- 공통 ----------
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const fmt$ = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '?');
function log(msg) { const line = `[${kst(now())}] ${msg}`; console.log(line); appendFileSync(join(DATA, 'events.log'), line + '\n'); }
const quiet = new Map(); // 같은 내용의 '건너뜀' 로그는 5분에 한 번만
function logSkip(key, msg) { const t = now(); if (t - (quiet.get(key) || 0) < 5 * MIN) return; quiet.set(key, t); log(msg); }

// ---------- 실시간 데이터 (토스증권 Open API, 조회 전용) ----------
function loadEnv() {
  const p = resolve(HERE, CFG.envFile || '../toss-mcp/.env'); const env = {};
  if (!existsSync(p)) throw new Error(`키 파일이 없어요: ${p}`);
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); const i = line.indexOf('=');
    if (line && !line.startsWith('#') && i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
function findRate(o, depth = 0) { // 환율 응답 모양을 몰라도 500~3000 사이 숫자를 찾음
  if (o == null || depth > 3) return NaN;
  if (typeof o !== 'object') { const n = num(o); return n > 500 && n < 3000 ? n : NaN; }
  for (const v of Object.values(o)) { const r = findRate(v, depth + 1); if (Number.isFinite(r)) return r; }
  return NaN;
}
function normBook(r) {
  const side = arr => (arr ?? []).map(e => ({ p: num(e.price), q: num(e.volume) })).filter(e => e.p > 0 && e.q > 0);
  return { asks: side(r?.asks).sort((a, b) => a.p - b.p), bids: side(r?.bids).sort((a, b) => b.p - a.p) };
}
const normBars = arr => (arr ?? []).map(c => ({ t: Date.parse(c.timestamp), o: num(c.openPrice), h: num(c.highPrice), l: num(c.lowPrice), c: num(c.closePrice), v: num(c.volume) }))
  .filter(c => Number.isFinite(c.t) && c.h > 0).sort((a, b) => a.t - b.t);

function liveProvider() {
  const env = loadEnv(); let token = null, acct = env.TOSS_ACCOUNT_SEQ || null;
  async function issue() {
    const res = await fetch(`${BASE}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TOSS_CLIENT_ID, client_secret: env.TOSS_CLIENT_SECRET }) });
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) throw new Error(`토큰 발급 실패 (${res.status}) ${JSON.stringify(j).slice(0, 200)}`);
    token = j.access_token; return token;
  }
  async function get(path, query = {}, attempt = 0, extra = {}) { // GET만 존재: 이 봇은 주문 API를 부를 방법이 없음
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const auth = `Bearer ${token || await issue()}`; // 응답이 20초 넘게 없으면 끊고 다음 바퀴에 다시 (봇이 멈춰 버리지 않게)
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20_000), headers: { Authorization: auth, Accept: 'application/json', ...extra } });
    if (res.status === 401 && attempt < 2) { token = null; return get(path, query, attempt + 1, extra); } // MCP 등이 토큰을 새로 받으면 여기로 옴
    if (res.status === 429 && attempt < 3) { await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000); return get(path, query, attempt + 1, extra); }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${path} ${res.status} ${j?.error?.code ?? ''} ${j?.error?.message ?? ''}`);
    return j && typeof j === 'object' && 'result' in j ? j.result : j;
  }
  function sessTime(s, p) {
    if (typeof s !== 'string') return NaN;
    const m = s.match(/^(\d{2}):(\d{2})/); if (m) return etToMs(p.y, p.mo, p.d, +m[1], +m[2]);
    return Date.parse(s);
  }
  return {
    async session(ms) {
      const p = etParts(ms + 4 * HOUR); // 미국 날짜: 데이마켓(전날 밤 ET)은 다음 거래일, 애프터장(그날 16~20시 ET)은 그날
      try {
        const r = await get('/api/v1/market-calendar/US', { date: ymd(p) });
        const T = r?.today;
        if (T && !T.regularMarket) return null; // 휴장 (4세션 모두 null)
        const open = sessTime(T?.regularMarket?.startTime, p), close = sessTime(T?.regularMarket?.endTime, p);
        const w = x => (x ? { s: sessTime(x.startTime, p), e: sessTime(x.endTime, p) } : null);
        if (Number.isFinite(open) && Number.isFinite(close)) return withPhases({ date: ymd(p), open, close }, { day: w(T.dayMarket), pre: w(T.preMarket), after: w(T.afterMarket) });
      } catch (e) { log(`장 운영시간 조회 실패, 기본 시간(09:30~16:00 ET) 사용: ${e.message}`); }
      return defaultSession(ms + 4 * HOUR);
    },
    async gainers() {
      const r = await get('/api/v1/rankings', { type: 'TOP_GAINERS', marketCountry: 'US', duration: '1d', count: 100,
        excludeInvestmentCaution: CFG.universe.excludeInvestmentCaution });
      return (r?.rankings ?? []).map(x => {
        const last = num(x.price?.lastPrice), base = num(x.price?.basePrice);
        return { symbol: x.symbol, currency: x.currency, last, amount: num(x.tradingAmount),
          change: last > 0 && base > 0 ? last / base - 1 : num(x.price?.changeRate) };
      });
    },
    async prices(symbols) {
      const out = new Map();
      for (let i = 0; i < symbols.length; i += 200) {
        const r = await get('/api/v1/prices', { symbols: symbols.slice(i, i + 200).join(',') });
        for (const x of r ?? []) out.set(x.symbol, num(x.lastPrice));
      }
      return out;
    },
    async candles(symbol, interval, count, before) {
      const r = await get('/api/v1/candles', { symbol, interval, count, before });
      return { bars: normBars(r?.candles), nextBefore: r?.nextBefore ?? null };
    },
    async orderbook(symbol) { return normBook(await get('/api/v1/orderbook', { symbol })); },
    async stockInfo(symbols) {
      const out = new Map();
      for (let i = 0; i < symbols.length; i += 200) {
        const r = await get('/api/v1/stocks', { symbols: symbols.slice(i, i + 200).join(',') });
        for (const x of r ?? []) out.set(x.symbol, { shares: num(x.sharesOutstanding), name: x.name });
      }
      return out;
    },
    async fx() { try { const r = findRate(await get('/api/v1/exchange-rate', { baseCurrency: 'USD', quoteCurrency: 'KRW' })); return Number.isFinite(r) ? r : CFG.fxFallback; } catch { return CFG.fxFallback; } },
    async myStocks(fromDate) { // 내 실제 계좌의 미국 보유 종목 + 오늘 매수한 종목 (조회만)
      if (acct == null) {
        const r = await get('/api/v1/accounts'); const list = Array.isArray(r) ? r : (r?.accounts ?? r?.items ?? []);
        acct = list[0]?.accountSeq; if (acct == null) throw new Error('조회되는 계좌가 없어요');
      }
      const H = { 'X-Tossinvest-Account': String(acct) };
      const h = await get('/api/v1/holdings', {}, 0, H);
      const held = (h?.items ?? []).filter(x => x.currency === 'USD' && num(x.quantity) > 0).map(x => x.symbol);
      const o = await get('/api/v1/orders', { status: 'CLOSED', from: fromDate, limit: 100 }, 0, H);
      const bought = (Array.isArray(o) ? o : (o?.orders ?? o?.items ?? []))
        .filter(x => x.side === 'BUY' && x.currency === 'USD' && num(x.execution?.filledQuantity) > 0).map(x => x.symbol);
      return [...new Set([...held, ...bought])];
    },
  };
}

// ---------- 가상 시장 (--mock) ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function mockProvider() {
  const seedArg = process.argv.find(a => a.startsWith('--seed='));
  const rnd = mulberry32(seedArg ? Number(seedArg.slice(7)) : (CFG.mock?.seed ?? 7));
  const day = CFG.mock?.date ?? '2026-11-16';
  const [Y, M, D] = day.split('-').map(Number);
  const open = etToMs(Y, M - 1, D, 9, 30), close = etToMs(Y, M - 1, D, 16, 0);
  const at = (h, m) => etToMs(Y, M - 1, D, h, m);
  const FULL = process.argv.includes('--fullday'), SESS = withPhases({ date: day, open, close });
  // 정규장 밖: 거래량 배수, 스프레드 배수, 호가 물량 배수
  const outside = ms => { const ph = phaseOf(SESS, ms); return ph === 'regular' ? [1, 1, 1] : ph === 'pre' ? [0.25, 3, 0.4] : ph === 'after' ? [0.15, 3, 0.3] : [0.02, 6, 0.1]; };
  let syms = [];
  for (let i = 0; i < 14; i++) {
    const prev = +(0.15 + rnd() * 6).toFixed(3);
    // 하루에 2~4번 거래량이 터지는 구간: 35%는 진짜 급등, 65%는 잠깐 뚫고 무너지는 가짜 돌파
    // 30%는 진짜 급등, 20%는 오르고 쉬었다 한 번 더 가는 계단식, 50%는 잠깐 뚫고 무너지는 가짜 돌파
    const events = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => { const k = rnd(), start = open + (5 + rnd() * 300) * MIN;
      if (k < 0.3) return { start, up: 5 + rnd() * 15, gain: 0.12 + rnd() * 0.45, down: 10 + rnd() * 15, fade: 0.15 + rnd() * 0.35 };
      if (k < 0.5) return { start, up: 5 + rnd() * 5, gain: 0.15 + rnd() * 0.15, pull: 5 + rnd() * 5, pullDepth: 0.05 + rnd() * 0.07, up2: 5 + rnd() * 5, gain2: 0.1 + rnd() * 0.15, down: 10 + rnd() * 10, fade: 0.15 + rnd() * 0.2 };
      return { start, up: 1.5 + rnd() * 2.5, gain: 0.05 + rnd() * 0.1, down: 3 + rnd() * 5, fade: 0.15 + rnd() * 0.3 }; });
    if (FULL && rnd() < 0.5) { const start = SESS.pre.s + (30 + rnd() * 270) * MIN; events.push({ start, up: 5 + rnd() * 10, gain: 0.1 + rnd() * 0.3, down: 10 + rnd() * 15, fade: 0.1 + rnd() * 0.3 }); } // 프리장 급등
    const baseVol = 2000 + rnd() * 20000;
    syms.push({ symbol: `MOCK${i + 1}`, prev, px: prev * (1.1 + rnd() * 0.5), baseVol, liq: 0.2 + rnd() * 1.5, events, candles: new Map(), amount: 0,
      shares: Math.round(1e6 * Math.pow(100, rnd())), avgDayVol: baseVol * 40 * (0.3 + rnd() * 0.8) });
  }
  if (process.argv.includes('--scenario=edge')) { // 경계 상황 점검용: 시간손절, 매수호가 실종, 장 마감 호가 부족
    syms.length = 3;
    syms[0] = { ...syms[0], prev: 1, px: 1.3, baseVol: 30000, liq: 2, events: [{ start: at(10, 0), up: 3, gain: 0.04, down: 0.1, fade: 0.001 }], flat: [at(9, 0), at(10, 0)], flat2: [at(10, 3), at(11, 30)] };
    syms[1] = { ...syms[1], prev: 1, px: 1.3, baseVol: 30000, liq: 2, events: [{ start: at(11, 0), up: 3, gain: 0.1, down: 2, fade: 0.2 }], flat: [at(9, 0), at(11, 0)], noBid: [at(11, 3), at(11, 7)] };
    syms[2] = { ...syms[2], prev: 1, px: 1.3, baseVol: 30000, liq: 2, events: [{ start: at(15, 20), up: 3, gain: 0.1, down: 0.1, fade: 0.001 }], flat: [at(15, 23), at(16, 1)], thin: [at(15, 44), at(16, 1)] };
    for (const x of syms) { x.candles = new Map(); x.amount = 0; x.shares = 5e6; x.avgDayVol = 1e5; }
  }
  const inWin = (w, ms) => w && ms >= w[0] && ms < w[1];
  function step(ms, dtSec) {
    for (const s of syms) {
      let drift = 0, volMul = 1, sigma = 0.004;
      for (const p of s.events) {
        const t = (ms - p.start) / MIN, per = mins => mins * 60 / dtSec;
        const pull = p.pull || 0, up2 = p.up2 || 0, t2 = p.up + pull, t3 = t2 + up2;
        if (t >= 0 && t < p.up) { drift += Math.log(1 + p.gain) / per(p.up); volMul = 6 + rnd() * 10; sigma = 0.01; }
        else if (pull && t >= p.up && t < t2) { drift += Math.log(1 - p.pullDepth) / per(pull); volMul = 1.2 + rnd() * 1.2; sigma = 0.004; }
        else if (up2 && t >= t2 && t < t3) { drift += Math.log(1 + p.gain2) / per(up2); volMul = 5 + rnd() * 8; sigma = 0.008; }
        else if (t >= t3 && t < t3 + p.down) { drift += Math.log(1 - p.fade) / per(p.down); volMul = 3 + rnd() * 4; sigma = 0.012; }
      }
      if (inWin(s.flat, ms) || inWin(s.flat2, ms)) { drift = 0; sigma = 0.0002; }
      const shock = !s.flat && rnd() < 0.002 ? (rnd() < 0.5 ? -0.08 : 0.06) : 0; // 가끔 꼬리
      s.px = Math.max(0.01, s.px * Math.exp(drift + sigma * (rnd() * 2 - 1) * Math.sqrt(dtSec / 5) + shock));
      const v = Math.round(s.baseVol * volMul * outside(ms)[0] * (dtSec / 60) * (0.5 + rnd()));
      s.amount += v * s.px;
      const m = Math.floor(ms / MIN) * MIN; const c = s.candles.get(m);
      if (!c) s.candles.set(m, { t: m, o: s.px, h: s.px, l: s.px, c: s.px, v });
      else { c.h = Math.max(c.h, s.px); c.l = Math.min(c.l, s.px); c.c = s.px; c.v += v; }
      s.vol = volMul;
    }
  }
  const find = sym => syms.find(s => s.symbol === sym);
  return {
    start: FULL ? SESS.day.s - 2 * MIN : open - 6 * MIN, end: FULL ? SESS.after.e + 2 * MIN : close + 2 * MIN, step,
    async session() { return withPhases({ date: day, open, close }); },
    async gainers() { return syms.map(s => ({ symbol: s.symbol, currency: 'USD', last: s.px, amount: s.amount, change: s.px / s.prev - 1 })); },
    async prices(list) { return new Map(list.map(x => [x, find(x)?.px])); },
    async candles(sym, interval, count, before) {
      const s = find(sym); if (!s) return { bars: [], nextBefore: null };
      if (interval === '1d') {
        const r = mulberry32(sym.length * 97 + s.shares % 1000);
        const bars = Array.from({ length: count - 1 }, (_, i) => ({ t: open - (count - 1 - i) * 24 * HOUR, o: s.prev, h: s.prev, l: s.prev, c: s.prev, v: s.avgDayVol * (0.6 + r() * 0.8) }));
        bars.push({ t: open - 9.5 * HOUR, o: s.prev, h: s.px, l: s.px, c: s.px, v: [...s.candles.values()].reduce((a, b) => a + b.v, 0) });
        return { bars, nextBefore: null };
      }
      let all = [...s.candles.values()];
      if (before != null) all = all.filter(b => b.t <= before);
      const bars = all.slice(-count).map(b => ({ ...b }));
      return { bars, nextBefore: all.length > count ? bars[0].t - MIN : null };
    },
    async orderbook(sym) {
      const s = find(sym); if (!s) return { asks: [], bids: [] };
      const t = now();
      const [, spMul, qMul] = outside(t);
      const spread = (0.002 + rnd() * 0.01) * (s.vol > 3 ? 2 : 1) * spMul;
      const thin = rnd() < (s.vol > 3 ? 0.2 : 0.06) ? 0.02 : 1; // 급변 구간일수록 호가가 자주 텅 빔
      const thinNow = inWin(s.thin, t) ? 0.0015 : 1;
      const tilt = s.vol > 3 ? 0.6 + rnd() * 1.4 : 0.7 + rnd() * 0.6; // 매수/매도 잔량 쏠림
      const lv = (dir, i) => ({ p: +(s.px * (1 + dir * (spread / 2 + i * 0.003))).toFixed(4),
        q: Math.max(1, Math.round((300 + rnd() * 3000) * s.liq * thin * thinNow * qMul * (dir < 0 ? tilt : 1) / Math.max(s.px, 0.2))) });
      return { asks: Array.from({ length: 10 }, (_, i) => lv(1, i)), bids: inWin(s.noBid, t) ? [] : Array.from({ length: 10 }, (_, i) => lv(-1, i)) };
    },
    async stockInfo(list) { return new Map(list.map(x => [x, { shares: find(x)?.shares }])); },
    async fx() { return CFG.fxFallback; },
    async myStocks() { return syms.slice(0, 2).map(s => s.symbol); },
  };
}

// ---------- 리플레이 (--replay=날짜): 녹화된 순위·현재가·분봉·호가로 지난 장을 다시 돌림 ----------
// - 순위·현재가·호가는 녹화된 시점 것만 씀. 분봉은 '이미 끝난 봉'만 보여 줘서 미래 정보가 새지 않게 함
// - 호가 녹화가 없는 순간(녹화는 종목당 30초 간격, 보유·진입 종목 위주)은 그 종목 녹화 호가의 스프레드와 최근 거래량으로 추정
function replayProvider(date) {
  const dir = join(HERE, 'data', 'recordings', date);
  if (!existsSync(join(dir, '_meta.json'))) throw new Error(`녹화가 없어요: ${dir}`);
  const meta = JSON.parse(readFileSync(join(dir, '_meta.json'), 'utf8'));
  const jsonl = f => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.t - b.t) : [];
  const ranks = jsonl('_rankings.jsonl'), prices = jsonl('_prices.jsonl'), books = new Map(), bars = new Map();
  for (const b of jsonl('_books.jsonl')) { if (!books.has(b.s)) books.set(b.s, []); books.get(b.s).push(b); }
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !f.startsWith('_')) bars.set(f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), 'utf8')).sort((a, b) => a.t - b.t));
  const median = a => { const x = [...a].sort((p, q) => p - q); return x.length ? x[x.length >> 1] : NaN; };
  // 녹화 호가로 세션·종목별 '스프레드'와 '최우선 잔량 ÷ 최근 1분 거래량' 중앙값을 구해 둠 (녹화 없는 순간의 호가 추정용)
  // 프리·애프터 호가는 정규장보다 훨씬 얇으니 세션별로 따로 셈
  const PS = withPhases({ date: meta.date, open: meta.open, close: meta.close }, meta.phases || {});
  const bookStat = new Map(), all = {};
  for (const [sym, arr] of books) {
    const by = {}, b = bars.get(sym) ?? [];
    for (const r of arr) {
      const ph = phaseOf(PS, r.t) || 'regular', x = (by[ph] ||= { sp: [], ra: [], rb: [] }), g = (all[ph] ||= { sp: [], ra: [], rb: [] });
      if (r.a[0] && r.b[0]) { const v = (r.a[0].p - r.b[0].p) / ((r.a[0].p + r.b[0].p) / 2); x.sp.push(v); g.sp.push(v); }
      const v = avg(b.filter(y => y.t < Math.floor(r.t / MIN) * MIN).slice(-5).map(y => y.v));
      if (v > 0) { if (r.a[0]) { x.ra.push(r.a[0].q / v); g.ra.push(r.a[0].q / v); } if (r.b[0]) { x.rb.push(r.b[0].q / v); g.rb.push(r.b[0].q / v); } }
    }
    for (const [ph, x] of Object.entries(by)) if (x.sp.length >= 5 && x.ra.length >= 5) bookStat.set(`${sym}|${ph}`, { spread: median(x.sp), ask: median(x.ra), bid: median(x.rb) });
  }
  for (const [ph, g] of Object.entries(all)) if (g.sp.length >= 5) bookStat.set(`*|${ph}`, { spread: median(g.sp), ask: median(g.ra) || 0.04, bid: median(g.rb) || 0.026 });
  if (!bookStat.has('*|regular')) bookStat.set('*|regular', { spread: 0.009, ask: 0.04, bid: 0.026 });
  const at = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  const stats = { recorded: 0, estimated: 0 };
  function priceAt(sym, t) {
    const i = at(prices, t);
    for (let j = i; j >= 0 && j > i - 24; j--) { const v = prices[j].p[sym]; if (v > 0) return v; } // 2분 안의 녹화 가격
    const b = bars.get(sym) ?? [], k = at(b, Math.floor(t / MIN) * MIN - MIN);
    return k >= 0 ? b[k].c : NaN;
  }
  if (!ranks.length) throw new Error('순위 녹화가 없어요');
  // --from-open: 녹화 시작 전 구간은 분봉으로 급상승 순위를 다시 만들어 정규장 처음부터 돌림
  // (전일 종가는 녹화된 순위에서 역산. 나중에 순위에 오른 종목만 데이터가 있어서 녹화 전 구간은 결과가 좋게 나올 수 있음)
  const prevClose = new Map();
  for (const r of ranks) for (const [s, last, ch] of r.gainers) if (!prevClose.has(s) && last > 0 && ch > -1) prevClose.set(s, last / (1 + ch));
  const dayStart = meta.open - 5.5 * HOUR;
  function synthGainers(t) {
    const cut = Math.floor(t / MIN) * MIN, out = [];
    for (const [s, pc] of prevClose) {
      const b = bars.get(s); if (!b) continue;
      let amt = 0, last = NaN; for (const x of b) { if (x.t >= cut) break; if (x.t >= dayStart) { amt += x.c * x.v; last = x.c; } }
      if (last > 0) out.push({ symbol: s, currency: 'USD', last, change: last / pc - 1, amount: amt });
    }
    return out.sort((a, b) => b.change - a.change).slice(0, 100);
  }
  const FROM_OPEN = process.argv.includes('--from-open'), ALL = process.argv.includes('--all-sessions');
  const SESS = withPhases({ date: meta.date, open: meta.open, close: meta.close }, meta.phases || {});
  stats.synth = 0;
  return { // --all-sessions: 녹화된 프리·애프터·데이마켓까지 (정규장 밖을 매매하는 전략을 다시 돌릴 때)
    start: ALL ? Math.max(SESS.day.s, ranks[0].t) : FROM_OPEN ? meta.open - 5 * MIN : Math.max(meta.open - 5 * MIN, ranks[0].t),
    end: ALL ? Math.min(SESS.after.e, ranks[ranks.length - 1].t + 2 * MIN) : meta.close + 2 * MIN, stats, recStart: ranks[0].t,
    async session() { return withPhases({ date: meta.date, open: meta.open, close: meta.close }, meta.phases || {}); },
    async gainers() {
      const t = now();
      if (t < ranks[0].t) { stats.synth++; return synthGainers(t); }
      const r = ranks[at(ranks, t)]; return r ? r.gainers.map(([symbol, last, change, amount]) => ({ symbol, currency: 'USD', last, change, amount })) : [];
    },
    async myStocks() { return ranks[Math.max(0, at(ranks, now()))]?.mine ?? []; },
    async prices(list) { const t = now(), out = new Map(); for (const s of list) { const v = priceAt(s, t); if (v > 0) out.set(s, v); } return out; },
    async candles(sym, interval, count, before) {
      if (interval === '1d') { const a = num(meta.avgDailyVolume?.[sym]); return { bars: Array.from({ length: count }, (_, i) => ({ t: meta.open - (count - i) * 24 * HOUR, o: 1, h: 1, l: 1, c: 1, v: a })), nextBefore: null }; }
      let all = (bars.get(sym) ?? []).filter(b => b.t < Math.floor(now() / MIN) * MIN);
      if (before != null) all = all.filter(b => b.t <= before);
      const out = all.slice(-count); return { bars: out, nextBefore: all.length > count ? out[0].t - MIN : null };
    },
    async orderbook(sym) {
      const t = now(), px = priceAt(sym, t), arr = books.get(sym) ?? [], i = at(arr, t);
      if (!(px > 0)) return { asks: [], bids: [] };
      if (i >= 0 && t - arr[i].t <= 120_000) { // 2분 안의 녹화 호가를 지금 가격에 맞춰 옮겨 씀
        stats.recorded++; const r = arr[i], mid = ((r.a[0]?.p ?? px) + (r.b[0]?.p ?? px)) / 2, k = px / mid;
        return { asks: r.a.map(e => ({ p: e.p * k, q: e.q })), bids: r.b.map(e => ({ p: e.p * k, q: e.q })) };
      }
      stats.estimated++; // 토스 해외 호가는 최우선 1단계만 오므로 추정도 1단계로 만듦
      const ph = phaseOf(PS, t) || 'regular', k = bookStat.get(`${sym}|${ph}`) ?? bookStat.get(`*|${ph}`) ?? bookStat.get(`${sym}|regular`) ?? bookStat.get('*|regular');
      const recent = (bars.get(sym) ?? []).filter(b => b.t < Math.floor(t / MIN) * MIN).slice(-5);
      const v1 = avg(recent.map(b => b.v)) || 0;
      return { asks: [{ p: px * (1 + k.spread / 2), q: Math.max(1, Math.round(v1 * k.ask)) }], bids: [{ p: px * (1 - k.spread / 2), q: Math.max(1, Math.round(v1 * k.bid)) }] };
    },
    async stockInfo(list) { return new Map(list.map(s => [s, { shares: num(meta.sharesOutstanding?.[s]) }])); },
    async fx() { return meta.fx || CFG.fxFallback; },
  };
}

// ---------- 체결 시뮬레이션 ----------
function fee(notional, side) {
  const f = CFG.fills;
  return Math.max(f.minFeeUsd, notional * f.commissionPct) + (side === 'SELL' ? f.sellTaxMinUsd : 0);
}
function simFill(book, side, qty, limitPx) {
  const levels = side === 'BUY' ? book.asks : book.bids;
  let left = qty, filled = 0, cost = 0;
  for (const lv of levels) {
    if (side === 'BUY' && limitPx && lv.p > limitPx) break;
    if (side === 'SELL' && limitPx && lv.p < limitPx) break;
    const take = Math.min(left, Math.floor(lv.q * CFG.fills.depthShare));
    if (take <= 0) continue;
    filled += take; cost += take * lv.p; left -= take;
    if (left <= 0) break;
  }
  return { filled, avgPx: filled ? cost / filled : NaN };
}
function imbalance(book, n = 5) {
  const b = book.bids.slice(0, n).reduce((s, e) => s + e.q, 0), a = book.asks.slice(0, n).reduce((s, e) => s + e.q, 0);
  return a > 0 ? b / a : (b > 0 ? 99 : 0);
}

// ---------- 신호 ----------
// A·B: 직전 N분 고가 돌파 + 직전 1분 거래량 급증 + 양봉
function breakout(done, last, E) {
  const n = E.breakoutLookbackMin, a = E.volumeAvgMin;
  if (done.length < n + a + 1) return null;
  const lastBar = done[done.length - 1], prevN = done.slice(-1 - n, -1);
  const avgVol = avg(done.slice(-1 - a, -1).map(c => c.v));
  const hi = Math.max(...prevN.map(c => c.h));
  const volRatio = avgVol > 0 ? lastBar.v / avgVol : 0;
  if (last > hi * (1 + E.breakoutBufferPct) && volRatio >= E.volumeSurgeMultiple && lastBar.c > lastBar.o)
    return { kind: '돌파', ref: hi, volRatio, stopPx: null };
  return null;
}
// C: 거래량 터지며 고점 → 거래량 줄며 4~20% 눌림(VWAP 위 유지) → 직전 2봉 고가를 거래량 붙으며 재돌파, 아직 고점 아래
// diag(이유): 어느 단계에서 막혔는지 세는 함수 (진단용)
function pullback(done, last, vw, regOpen, C, diag = () => {}) {
  const bars = done.filter(b => b.t >= regOpen);
  const win = bars.slice(-C.lookbackMin);
  if (win.length < 12) return diag('정규장 분봉 부족'), null;
  let iH = 0; for (let i = 1; i < win.length; i++) if (win[i].h >= win[iH].h) iH = i;
  const H = win[iH].h, after = win.slice(iH + 1);
  const runStart = Math.max(0, iH - 4), run = win.slice(runStart, iH + 1);
  const baseEnd = bars.indexOf(win[runStart]), base = bars.slice(Math.max(0, baseEnd - 20), baseEnd);
  if (base.length < 8) return diag('급등 전 기준 구간 부족'), null;
  const baseVol = avg(base.map(b => b.v)), runVol = avg(run.map(b => b.v)), pbVol = avg(after.map(b => b.v));
  if (!(runVol >= baseVol * C.surgeMultiple)) return diag('1단계: 거래량 터진 급등 없음'), null;
  if (after.length < C.minPullbackBars) return diag('2단계: 고점 직후(눌림 전)'), null;
  const pbLow = Math.min(...after.map(b => b.l)), depth = 1 - pbLow / H;
  if (depth < C.minDepthPct) return diag('3단계: 눌림이 얕음'), null;
  if (depth > C.maxDepthPct) return diag('3단계: 눌림이 너무 깊음'), null;
  if (pbVol > runVol * C.dryUpRatio) return diag('4단계: 눌림 중 거래량이 안 줄음'), null;
  if (Number.isFinite(vw) && pbLow < vw * (1 - C.vwapTolerancePct)) return diag('5단계: 눌림이 VWAP 아래로 깨짐'), null;
  const trig = Math.max(...after.slice(-2).map(b => b.h)), lb = done[done.length - 1];
  if (!(last > trig * 1.002 && last < H && lb.c >= lb.o && lb.v >= pbVol * C.reentryVolMultiple)) return diag('6단계: 재돌파 대기'), null;
  return { kind: '눌림목', ref: trig, H, pbLow, depth, volRatio: runVol / baseVol, stopPx: pbLow * 0.995 };
}
// D: A와 같은 돌파인데, 진행 중인 봉이 아니라 '1분봉이 고점 위에서 마감'한 걸 확인하고 진입. 마감가보다 3% 넘게 올라가 있으면 추격 안 함
function breakoutClose(done, last, E, diag = () => {}) {
  const n = E.breakoutLookbackMin, a = E.volumeAvgMin;
  if (done.length < n + a + 2) return diag('분봉 부족'), null;
  const lb = done[done.length - 1], prev = done.slice(-1 - n, -1);
  const hi = Math.max(...prev.map(c => c.h)), avgVol = avg(done.slice(-1 - a, -1).map(c => c.v));
  const volRatio = avgVol > 0 ? lb.v / avgVol : 0;
  if (!(lb.c > hi * (1 + E.breakoutBufferPct))) return diag('고점 위 마감 없음'), null;
  if (!(lb.c > lb.o && volRatio >= E.volumeSurgeMultiple)) return diag('마감봉 거래량·양봉 부족'), null;
  if (last < lb.c * 0.995) return diag('마감 뒤 밀림'), null;
  if (last > lb.c * 1.03) return diag('이미 3% 넘게 감(추격 안 함)'), null;
  return { kind: '마감돌파', ref: hi, volRatio, stopPx: Math.min(lb.l, hi) * 0.995 };
}
// E: 급락 후 반등 — 고점에서 12~50% 급락(투매 거래량) → 저점 찍은 지 10분 안에 양봉이 투매봉 고가를 넘어서며 반등, 저점에서 3~12%만 올라온 자리
function dipRebound(done, last, regOpen, R, diag = () => {}) {
  const bars = done.filter(b => b.t >= regOpen), win = bars.slice(-R.lookbackMin);
  if (win.length < 15) return diag('정규장 분봉 부족'), null;
  let iL = 0; for (let i = 1; i < win.length; i++) if (win[i].l <= win[iL].l) iL = i;
  const L = win[iL].l, beforeL = win.slice(0, iL + 1);
  let iH = 0; for (let i = 1; i < beforeL.length; i++) if (beforeL[i].h >= beforeL[iH].h) iH = i;
  const H = beforeL[iH].h, drop = 1 - L / H;
  if (drop < R.minDropPct) return diag('1단계: 큰 급락 없음'), null;
  if (drop > R.maxDropPct) return diag('1단계: 너무 깊은 폭락'), null;
  const sinceLow = win.length - 1 - iL;
  if (sinceLow < 1) return diag('2단계: 아직 저점 갱신 중'), null;
  if (sinceLow > R.maxBarsSinceLow) return diag('2단계: 저점 지난 지 오래됨'), null;
  const decline = win.slice(iH, iL + 1), baseIdx = bars.indexOf(win[iH]), base = bars.slice(Math.max(0, baseIdx - 20), baseIdx);
  const capVol = Math.max(...decline.slice(-4).map(b => b.v)), baseVol = avg((base.length >= 5 ? base : decline).map(b => b.v));
  if (!(capVol >= baseVol * R.capitulationMultiple)) return diag('3단계: 투매 거래량 없음'), null;
  const flush = win[iL], lb = done[done.length - 1], bounce = last / L - 1;
  if (!(lb.c > lb.o && lb.c > flush.h)) return diag('4단계: 반등 양봉 대기'), null;
  if (bounce < R.minBouncePct) return diag('4단계: 반등이 아직 약함'), null;
  if (bounce > R.maxBouncePct) return diag('4단계: 이미 많이 반등함(추격 안 함)'), null;
  return { kind: '급락반등', ref: flush.h, H, L, depth: drop, volRatio: baseVol > 0 ? capVol / baseVol : 0, stopPx: L * 0.995 };
}
// F: VWAP 아래 눌림 — 녹화 데이터에서 거꾸로 찾은 규칙 (research/ 참고)
// 당일 +15% 넘게 오른 종목이 VWAP보다 2% 넘게 아래로 밀려 있고, 최근 5분도 내려오는 중이면 산다.
// 2026-11-13 데이터: 이 자리에서 사서 +12% 익절 / -5% 손절 / 최대 60분이면 평균 +0.9%(비용 뺀 뒤),
// 같은 조건에서 '거래량 터진 상승을 추격'하면 평균 -1.7%. 하룻밤 데이터라 아직 '후보'일 뿐임
function vwapDip(done, last, vw, ctx, V, diag = () => {}) {
  const lb = done[done.length - 1];
  if (!lb || !(vw > 0)) return diag('VWAP 계산 불가'), null;
  if (!(ctx.gain >= V.minGainPct)) return diag('당일 상승률 부족'), null;
  const below = 1 - lb.c / vw;
  if (below < V.minBelowVwapPct) return diag('VWAP 아래로 충분히 안 내려옴'), null;
  if (V.maxBelowVwapPct != null && below > V.maxBelowVwapPct) return diag('VWAP 아래로 너무 깊음'), null;
  if (!(last < vw)) return diag('이미 VWAP 위로 회복'), null; // 봉 마감 뒤 벌써 튀어 올랐으면 안 삼
  let ref = null; for (let i = done.length - 1; i >= 0; i--) if (done[i].t <= lb.t - 5 * MIN) { ref = done[i]; break; } // 5분 전 종가 (거래 없던 분은 직전 봉)
  if (!ref) return diag('분봉 부족'), null;
  const r5 = lb.c / ref.c - 1;
  if (r5 > -V.minDrop5mPct) return diag('최근 5분 하락 아님'), null;
  if (V.maxDrop5mPct != null && r5 < -V.maxDrop5mPct) return diag('5분 낙폭이 너무 큼(떨어지는 칼)'), null;
  if (V.requireUpBar && !(lb.c > lb.o)) return diag('반등 확인 전(마지막 1분봉 음봉)'), null; // 2026-11-17 실험: 떨어지는 중엔 안 사고 양봉 나온 뒤 삼
  if (V.requireUptick && !(last > lb.c)) return diag('반등 확인 전(현재가가 직전 봉 종가 이하)'), null; // 2026-11-16: 지정가(G·H)로 이런 자리를 사면 계속 밀림
  const dv5 = done.filter(b => b.t > lb.t - 5 * MIN).reduce((a, b) => a + b.c * b.v, 0);
  if (dv5 < V.minDollarVol5m) return diag('최근 5분 거래대금 부족'), null;
  const prev = done.filter(b => b.t < lb.t).slice(-20), va = avg(prev.map(b => b.v));
  return { kind: 'VWAP눌림', ref: vw, depth: below, r5, volRatio: va > 0 ? lb.v / va : 0 };
}
// B·C 필터. 호가가 필요 없는 것 먼저, 호가 필터는 호가를 받은 뒤 검사
function preFilters(F, ctx) {
  const fails = [], lb = ctx.done[ctx.done.length - 1];
  if (F.aboveVwap && !(ctx.last > ctx.vw)) fails.push('VWAP 아래');
  if (F.maxVwapExtPct != null && ctx.vw > 0 && ctx.last > ctx.vw * (1 + F.maxVwapExtPct)) fails.push('VWAP 대비 과열');
  if (F.maxUpperWick != null && lb) { const rng = lb.h - lb.l; if (rng > 0 && (lb.h - Math.max(lb.o, lb.c)) / rng > F.maxUpperWick) fails.push('윗꼬리'); }
  if (F.higherLows) { const l = ctx.done.slice(-3).map(b => b.l); if (!(l.length === 3 && l[0] <= l[1] && l[1] <= l[2])) fails.push('저점 상승 아님'); }
  if (F.maxSharesOutstanding != null && Number.isFinite(ctx.shares) && ctx.shares > F.maxSharesOutstanding) fails.push('주식 수 많음');
  if (F.minRvol != null && Number.isFinite(ctx.rvol) && ctx.rvol < F.minRvol) fails.push('상대거래량 부족');
  return fails;
}
function bookFilters(F, book) {
  if (F.minBidAskRatio != null && imbalance(book) < F.minBidAskRatio) return ['매수잔량 부족'];
  return [];
}

// ---------- 상태·기록 ----------
const STATE = join(DATA, 'state.json');
const TRADES = join(DATA, 'paper_trades.csv');
const DAILY = join(DATA, 'daily_summary.csv');
const newAcct = () => ({ cash: CFG.seedUsd, positions: {}, orders: {}, lim: { placed: 0, filled: 0, expired: 0 }, tradesToday: 0, pnlToday: 0, startEquity: CFG.seedUsd, cooldown: {}, closed: [], lossLogged: false, blocked: {}, diag: {} });
const seenBlock = new Set(); // 같은 종목·같은 분·같은 이유는 한 번만 셈
function countBlock(A, id, sym, why) { const k = `${id}|${sym}|${Math.floor(now() / MIN)}|${why}`; if (seenBlock.has(k)) return; seenBlock.add(k); A.blocked[why] = (A.blocked[why] || 0) + 1; }
function countDiag(A, id, sym, why) { const k = `d${id}|${sym}|${Math.floor(now() / MIN)}`; if (seenBlock.has(k)) return; seenBlock.add(k); A.diag = A.diag || {}; A.diag[why] = (A.diag[why] || 0) + 1; } // 종목·분마다 한 번
const topDiag = d => Object.entries(d || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
function loadState() {
  let s = null;
  if (!SIM && existsSync(STATE)) { try { s = JSON.parse(readFileSync(STATE, 'utf8')); } catch { s = null; } }
  if (!s || !s.accts) s = { day: null, accts: {}, summaryDone: false };
  for (const st of STRATS) if (!s.accts[st.id]) s.accts[st.id] = newAcct();
  return s;
}
const saveState = s => { if (!SIM) writeFileSync(STATE, JSON.stringify(s, null, 1)); };
const TRADE_HEADER = ['전략', '날짜(ET)', '종목', '진입(KST)', '진입가', '청산(KST)', '청산가', '수량', '손익USD', '손익원', '수익률', '청산사유', '보유분', '최고수익률', '신호', '진입근거', '진입스프레드', '매도미체결횟수'];
if (!SIM && existsSync(TRADES)) { // 예전(v1) 기록은 다른 이름으로 보관
  const head = readFileSync(TRADES, 'utf8').split('\n')[0];
  if (head && !head.includes('전략')) renameSync(TRADES, join(DATA, 'paper_trades_v1.csv'));
}
function csvRow(file, header, row) {
  if (!existsSync(file) || readFileSync(file, 'utf8').length === 0) writeFileSync(file, '﻿' + header.join(',') + '\n');
  appendFileSync(file, row.map(v => (typeof v === 'string' && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',') + '\n');
}

// ---------- 메인 ----------
// 봇은 한 번에 하나만: 돌고 있는 봇이 1분마다 data/bot.lock 에 '살아 있음'을 적음. 2분 넘게 소식이 없으면 꺼진 걸로 봄
const LOCK = join(DATA, 'bot.lock');
const beat = () => { if (!SIM) try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, beat: Date.now() })); } catch { /* 무시 */ } };
function takeLock() {
  if (SIM) return;
  try {
    const L = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (L.pid !== process.pid && Date.now() - L.beat < 120_000) { console.log(`이미 다른 창에서 봇이 돌고 있어요 (PID ${L.pid}). 이 창은 그냥 닫을게요.`); process.exit(0); }
  } catch { /* 잠금 파일 없음 */ }
  beat();
}
async function main() {
  takeLock();
  const P = REPLAY ? replayProvider(REPLAY) : MOCK ? mockProvider() : liveProvider();
  if (SIM) simNow = P.start;
  const S = loadState();
  const U = CFG.universe;
  let watch = [], lastRank = 0, lastStatus = 0, fx = CFG.fxFallback, sess = null, sessFor = null, loopId = 0, mine = [], lastMine = 0, mineErr = false, lastDiag = 0, lastDump = 0, lastPh = null;
  const lastPx = new Map();
  const md = { bars: new Map(), barsAt: new Map(), daily: new Map(), info: new Map(), book: new Map() };
  log(`시작 (${REPLAY ? `리플레이 ${REPLAY}, 설정 ${CFG_FILE}` : MOCK ? '가상 시장' : '실시간 시세'}) — 전략 ${STRATS.map(s => `${s.id}:${s.name}`).join(', ')} / 전략마다 시드 ${fmt$(CFG.seedUsd)}, 실제 주문 없음`);

  // --- 시장 데이터 ---
  const dayStart = () => (REC_PH.has('day') || STRATS.some(st => stSess(st).includes('day')) ? sess.day.s : sess.pre.s); // 오늘치 분봉 시작점
  async function refreshBars(sym) {
    let m = md.bars.get(sym);
    if (!m) { // 처음 보는 종목: 프리마켓부터 오늘치 분봉을 채움
      m = new Map(); md.bars.set(sym, m);
      let before;
      for (let i = 0; i < 4; i++) {
        const { bars, nextBefore } = await P.candles(sym, '1m', 200, before);
        for (const b of bars) m.set(b.t, b);
        if (!nextBefore || !bars.length || bars[0].t <= dayStart()) break;
        before = nextBefore;
      }
    } else {
      const { bars } = await P.candles(sym, '1m', 5);
      for (const b of bars) m.set(b.t, b);
    }
    md.barsAt.set(sym, now());
  }
  async function refreshDaily(sym) { // 최근 20일 평균 거래량 (오늘 봉은 제외)
    if (md.daily.get(sym)?.day === sess.date) return;
    try {
      const { bars } = await P.candles(sym, '1d', 21);
      md.daily.set(sym, { day: sess.date, avgVol: avg(bars.slice(-21, -1).map(b => b.v)) });
    } catch (e) { md.daily.set(sym, { day: sess.date, avgVol: NaN }); }
  }
  const doneCache = new Map();
  function doneBars(sym) {
    const m = md.bars.get(sym); if (!m) return [];
    const minute = Math.floor(now() / MIN) * MIN, key = `${minute}|${md.barsAt.get(sym)}|${m.size}`;
    const c = doneCache.get(sym); if (c && c.key === key) return c.arr;
    const arr = [...m.values()].filter(b => b.t < minute).sort((a, b) => a.t - b.t);
    doneCache.set(sym, { key, arr }); return arr;
  }
  // VWAP 기준점: 프리장·데이마켓에서는 그 세션 시작부터, 정규장·애프터장에서는 정규장 시작부터
  const vwAnchor = () => { const ph = phaseOf(sess, now()); return ph === 'pre' ? sess.pre.s : ph === 'day' ? sess.day.s : sess.open; };
  const vwapOf = done => { const a = vwAnchor(); let pv = 0, v = 0; for (const b of done) if (b.t >= a) { pv += (b.h + b.l + b.c) / 3 * b.v; v += b.v; } return v > 0 ? pv / v : NaN; };
  // 상대거래량: 오늘 지금까지 거래량 ÷ (20일 평균 거래량 × 이 시각까지 보통 쌓이는 비율)
  // 장중 거래량은 개장 직후에 몰리므로 대략 개장 30분 15%, 1시간 25%, 마감 30분 전 80%로 잡음
  const volCurve = m => (m <= 0 ? 0.05 : m <= 30 ? 0.05 + 0.10 * m / 30 : m <= 60 ? 0.15 + 0.10 * (m - 30) / 30 : m <= 360 ? 0.25 + 0.55 * (m - 60) / 300 : Math.min(1, 0.80 + 0.20 * (m - 360) / 30));
  const rvolOf = (sym, done) => {
    const a = md.daily.get(sym)?.avgVol; const today = done.filter(b => b.t >= dayStart()).reduce((s, b) => s + b.v, 0);
    const expected = a * volCurve((now() - sess.open) / MIN);
    return expected > 0 ? today / expected : NaN;
  };
  async function bookOf(sym, fresh = false) {
    const c = md.book.get(sym); if (!fresh && c && c.loop === loopId) return c.book;
    const b = await P.orderbook(sym); md.book.set(sym, { loop: loopId, book: b });
    if (REC && (fresh || !recBook.get(sym) || now() - recBook.get(sym) >= 30_000)) { recBook.set(sym, now()); recAppend('_books.jsonl', { t: now(), s: sym, a: b.asks.slice(0, 10), b: b.bids.slice(0, 10) }); }
    return b;
  }
  const equity = A => A.cash + Object.values(A.orders || {}).reduce((s, o) => s + o.reserve, 0) + Object.entries(A.positions).reduce((s, [sym, p]) => s + p.qty * (lastPx.get(sym) || p.avgPx), 0);

  // --- 시세 녹화: 나중에 새 규칙을 지난 장에 다시 돌려 보려고 저장 (data/recordings/날짜/) ---
  const REC = (CFG.record !== false && !SIM) || process.argv.includes('--record');
  const REC_PH = new Set(REC ? (CFG.sessions?.record ?? []) : []); // 정규장은 항상 녹화, 그 밖은 여기 적힌 세션만
  const recBook = new Map();
  const recDir = () => { const d = join(DATA, 'recordings', sess.date); mkdirSync(d, { recursive: true }); return d; };
  function recAppend(file, obj) { if (REC && sess) try { appendFileSync(join(recDir(), file), JSON.stringify(obj) + '\n'); } catch { /* 녹화 실패는 매매에 영향 없음 */ } }
  function dumpBars() {
    if (!REC || !sess) return;
    try {
      const d = recDir();
      for (const [sym, m] of md.bars) writeFileSync(join(d, `${sym}.json`), JSON.stringify([...m.values()].sort((a, b) => a.t - b.t)));
      writeFileSync(join(d, '_meta.json'), JSON.stringify({ date: sess.date, open: sess.open, close: sess.close, phases: { day: sess.day, pre: sess.pre, after: sess.after }, fx,
        avgDailyVolume: Object.fromEntries([...md.daily].map(([k, v]) => [k, v.avgVol])), sharesOutstanding: Object.fromEntries([...md.info].map(([k, v]) => [k, v.shares])) }));
    } catch (e) { log(`녹화 저장 실패: ${e.message}`); }
  }

  // --- 청산 ---
  // 지정가 가격 '아래로'(매도면 '위로') 거래가 찍혔는지: 5초마다 받는 현재가 + 주문 다음 분부터의 1분봉 저가·고가
  const tradedThrough = (sym, px, since, side) => {
    const lp = lastPx.get(sym), from = Math.floor(since / MIN) * MIN + MIN;
    if (side === 'BUY' ? lp < px : lp > px) return true;
    for (const b of md.bars.get(sym)?.values() ?? []) if (b.t >= from && (side === 'BUY' ? b.l < px : b.h > px)) return true;
    return false;
  };
  function checkOrders(st, A, t) {
    const X = { ...CFG.exit, ...(st.exit || {}) };
    for (const [sym, o] of Object.entries(A.orders || {})) {
      if (tradedThrough(sym, o.px, o.placedAt, 'BUY')) {
        const notional = o.qty * o.px, f = fee(notional, 'BUY');
        A.cash += o.reserve - (notional + f); delete A.orders[sym]; A.tradesToday += 1; A.lim.filled += 1;
        let stopPx = o.px * (1 - X.stopLossPct);
        if (X.useStructureStop && o.sigStop) stopPx = Math.min(Math.max(o.sigStop, stopPx), o.px * (1 - X.minStopPct));
        A.positions[sym] = { qty: o.qty, avgPx: o.px, cost: notional + f, entryT: t, peak: o.px, spread: o.spread, stopPx, kind: o.kind, why: o.why, limit: true };
        log(`[${st.id}] ${sym} 지정가 체결 ${o.qty}주 @ $${o.px.toFixed(4)} (주문 후 ${Math.round((t - o.placedAt) / 1000)}초) 손절 $${stopPx.toFixed(4)}`);
      } else if (t >= o.expires || t >= stEnd(st) - X.flattenBeforeCloseMin * MIN) {
        A.cash += o.reserve; delete A.orders[sym]; A.lim.expired += 1;
        log(`[${st.id}] ${sym} 지정가 미체결 — 취소 (@ $${o.px.toFixed(4)}, 지금 $${(lastPx.get(sym) || 0).toFixed(4)})`);
      }
    }
  }
  async function closeQty(st, A, sym, pos, book, reason, force = false, qty = pos.qty, fixedPx = null) {
    const X = { ...CFG.exit, ...(st.exit || {}) };
    let { filled, avgPx } = fixedPx ? { filled: qty, avgPx: fixedPx } : simFill(book, 'SELL', qty); // fixedPx: 미리 걸어 둔 지정가 매도가 체결된 경우
    if (force && filled < pos.qty) { // 장 마감인데 호가 부족: 남은 물량은 마지막 매수호가에서 할인해 정리
      const bid = book.bids[0]?.p || lastPx.get(sym) || pos.avgPx, rest = pos.qty - filled;
      avgPx = ((filled ? avgPx * filled : 0) + rest * bid * (1 - X.eodHaircutPct)) / pos.qty; filled = pos.qty;
    }
    if (filled <= 0) { pos.unfilled = (pos.unfilled || 0) + 1; logSkip(`${st.id}${sym}nf`, `[${st.id}] ${sym} ${reason} 매도 시도 — 받아줄 물량 없음 (${pos.unfilled}회째)`); return; }
    const notional = filled * avgPx, f = fee(notional, 'SELL');
    A.cash += notional - f; pos.proceeds = (pos.proceeds || 0) + notional - f; pos.gross = (pos.gross || 0) + notional; pos.soldQty = (pos.soldQty || 0) + filled; pos.qty -= filled;
    if (pos.qty > 0) { log(`[${st.id}] ${sym} ${reason} 일부 매도 ${filled}주 @ $${avgPx.toFixed(4)} — ${reason === '분할익절' ? '나머지' : '호가 부족으로'} ${pos.qty}주 남음`); return filled; }
    const pnl = pos.proceeds - pos.cost, r = pnl / pos.cost, exitPx = pos.gross / pos.soldQty;
    if (pos.partialDone && reason !== '분할익절') reason = `${reason}(분할익절 후)`;
    A.pnlToday += pnl; A.cooldown[sym] = now();
    if (reason === '손절') { A.stoppedOut = A.stoppedOut || {}; A.stoppedOut[sym] = true; } // 손절한 종목 표시 (당일 재진입 금지용)
    log(`[${st.id}] ${sym} 청산(${reason}) ${pos.soldQty}주 평균 $${exitPx.toFixed(4)} → ${fmt$(pnl)} (${pct(r)})`);
    csvRow(TRADES, TRADE_HEADER, [st.id, sess.date, sym, kst(pos.entryT), pos.avgPx.toFixed(4), kst(now()), exitPx.toFixed(4), pos.soldQty, pnl.toFixed(2), Math.round(pnl * fx),
      (r * 100).toFixed(1), reason, Math.round((now() - pos.entryT) / MIN), ((pos.peak / pos.avgPx - 1) * 100).toFixed(1), pos.kind, pos.why, ((pos.spread || 0) * 100).toFixed(2), pos.unfilled || 0]);
    A.closed.push({ sym, pnl, r, reason });
    delete A.positions[sym];
    return filled;
  }
  async function checkExits(st, A, t) {
    const X = { ...CFG.exit, ...(st.exit || {}) };
    for (const [sym, pos] of Object.entries(A.positions)) {
      const book = await bookOf(sym), bid = book.bids[0]?.p;
      const endAt = stEnd(st), eod = t >= endAt - X.flattenBeforeCloseMin * MIN;
      if (!bid) { // 매수호가가 아예 없음: 팔고 싶어도 못 파는 상황
        const lp = lastPx.get(sym);
        if (eod || t >= endAt) await closeQty(st, A, sym, pos, book, '장마감', t >= endAt);
        else if (lp && lp <= pos.stopPx) { pos.unfilled = (pos.unfilled || 0) + 1; logSkip(`${st.id}${sym}nb`, `[${st.id}] ${sym} 손절 가격인데 매수호가가 없어 못 팖 (${pos.unfilled}회째)`); }
        continue;
      }
      pos.peak = Math.max(pos.peak, bid);
      const held = (t - pos.entryT) / MIN; let reason = null;
      // 본전 스톱: 한 번이라도 +N% 가면 손절선을 매수가(수수료 조금 위)로 올림
      if (X.breakevenAtPct && pos.peak >= pos.avgPx * (1 + X.breakevenAtPct) && pos.stopPx < pos.avgPx * (1 + (X.breakevenOffsetPct || 0))) {
        pos.stopPx = pos.avgPx * (1 + (X.breakevenOffsetPct || 0)); pos.breakeven = true;
        log(`[${st.id}] ${sym} +${pct(X.breakevenAtPct)} 도달 — 손절선을 본전($${pos.stopPx.toFixed(4)})으로 올림`);
      }
      // 분할 익절: +N%에서 일부를 먼저 팔아 수익 확정
      if (X.partialTakePct && !pos.partialDone && bid >= pos.avgPx * (1 + X.partialTakePct)) {
        const q = Math.floor((pos.qty + (pos.soldQty || 0)) * (X.partialTakeFrac || 0.5));
        if (q >= 1 && q < pos.qty) { pos.partialDone = true; await closeQty(st, A, sym, pos, book, '분할익절', false, q); if (!A.positions[sym]) continue; }
      }
      if (bid <= pos.stopPx) reason = pos.breakeven ? '본전스톱' : '손절';
      else if (X.takeProfitPct && pos.limit && tradedThrough(sym, pos.avgPx * (1 + X.takeProfitPct), pos.entryT, 'SELL')) { await closeQty(st, A, sym, pos, book, '익절(지정가)', false, pos.qty, pos.avgPx * (1 + X.takeProfitPct)); continue; }
      else if (X.takeProfitPct && bid >= pos.avgPx * (1 + X.takeProfitPct)) reason = '익절';
      else if (X.maxHoldMinutes && held >= X.maxHoldMinutes) reason = '보유시간 만료';
      else if (pos.peak >= pos.avgPx * (1 + X.trailStartPct) && bid <= pos.peak * (1 - X.trailPct)) reason = '트레일링';
      else if (held >= X.timeStopMin && pos.peak < pos.avgPx * (1 + X.timeStopMinGainPct)) reason = '시간손절';
      else if (eod) reason = '장마감';
      else if (X.vwapExit && held >= 3) {
        const done = doneBars(sym), lb = done[done.length - 1], vw = vwapOf(done);
        if (lb && lb.t >= pos.entryT && vw > 0 && lb.c < vw * (1 - 0.005)) reason = 'VWAP 이탈';
      }
      if (reason) await closeQty(st, A, sym, pos, book, reason, t >= endAt);
    }
  }

  // --- 진입 ---
  // 전략이 마지막으로 매매하는 세션의 끝 (이 시각 15분 전에 다 정리)
  const stEnd = st => (stSess(st).includes('after') ? sess.after.e : sess.close);
  function canEnterAt(st, t) {
    const ph = phaseOf(sess, t); if (!ph || !stSess(st).includes(ph)) return false;
    const w = winOf(sess, ph), E = CFG.entry;
    if (ph === 'regular') return (E.allowPremarket || t >= w.s + E.noEntryFirstMin * MIN) && t < w.e - E.noEntryLastMin * MIN;
    const X = CFG.sessions?.extendedEntry || {}; // 정규장 밖: 세션 시작 직후·끝나기 직전은 피함
    return t >= w.s + (X.noEntryFirstMin ?? 15) * MIN && t < w.e - (X.noEntryLastMin ?? 15) * MIN;
  }
  async function tryEnter(st, A, t) {
    const E = CFG.entry, X = { ...CFG.exit, ...(st.exit || {}) }, F = st.filters || {};
    const lossHit = A.pnlToday <= -A.startEquity * CFG.dailyLossLimitPct;
    if (lossHit && !A.lossLogged) { log(`[${st.id}] 일일 손실 한도(${pct(CFG.dailyLossLimitPct)}) 도달 — 오늘은 신규 진입 중단`); A.lossLogged = true; }
    A.orders ||= {}; A.lim ||= { placed: 0, filled: 0, expired: 0 };
    const pend = Object.keys(A.orders).length;
    const ok = !lossHit && Object.keys(A.positions).length + pend < CFG.maxPositions && A.tradesToday + pend < CFG.maxTradesPerDay
      && canEnterAt(st, t);
    if (!ok) return;
    for (const w of watch) {
      const sym = w.symbol; if (A.positions[sym] || A.orders[sym]) continue;
      if (A.cooldown[sym] && t - A.cooldown[sym] < E.cooldownMin * MIN) continue;
      if (E.noReentryAfterStop && A.stoppedOut?.[sym]) continue; // 오늘 손절한 종목은 다시 안 들어감
      const last = lastPx.get(sym); if (!(last > 0)) continue;
      const done = doneBars(sym); if (done.length < 10) continue;
      const vw = vwapOf(done);
      const dg = why => countDiag(A, st.id, sym, why);
      const sig = st.signal === 'pullback' ? pullback(done, last, vw, sess.open, CFG.pullback, dg)
        : st.signal === 'breakoutClose' ? breakoutClose(done, last, E, dg)
        : st.signal === 'dipRebound' ? dipRebound(done, last, sess.open, CFG.dipRebound, dg)
        : st.signal === 'vwapDip' ? vwapDip(done, last, vw, { gain: w.change > -1 && w.last > 0 ? last / (w.last / (1 + w.change)) - 1 : NaN }, { ...CFG.vwapDip, ...(st.vwapDip || {}) }, dg) // 전략별로 신호 조건을 덮어쓸 수 있음
        : breakout(done, last, E);
      if (!sig) continue;
      const ctx = { done, last, vw, shares: md.info.get(sym)?.shares, rvol: rvolOf(sym, done) };
      const pre = preFilters(F, ctx);
      if (pre.length) { for (const why of pre) countBlock(A, st.id, sym, why); logSkip(`${st.id}${sym}f`, `[${st.id}] ${sym} ${sig.kind} 신호 — 필터에 걸림: ${pre.join(', ')}`); continue; }
      if (!SIM && CFG.fills.fillDelayMs) await sleep(CFG.fills.fillDelayMs); // 주문이 도착하는 사이 호가가 바뀌는 것 반영
      const book = await bookOf(sym, true), ask = book.asks[0]?.p, bid = book.bids[0]?.p;
      if (!ask || !bid) { logSkip(`${st.id}${sym}h`, `[${st.id}] ${sym} 신호 — 호가 없음, 건너뜀`); continue; }
      const spread = (ask - bid) / ((ask + bid) / 2);
      if (spread > (st.maxSpreadPct ?? E.maxSpreadPct)) { countBlock(A, st.id, sym, '스프레드'); logSkip(`${st.id}${sym}s`, `[${st.id}] ${sym} 신호 — 스프레드 ${pct(spread)}로 넓어서 건너뜀`); continue; }
      const bf = bookFilters(F, book);
      if (bf.length) { for (const why of bf) countBlock(A, st.id, sym, why); logSkip(`${st.id}${sym}b`, `[${st.id}] ${sym} ${sig.kind} 신호 — 필터에 걸림: ${bf.join(', ')} (${imbalance(book).toFixed(2)})`); continue; }
      if (st.order === 'limit') { // 지정가: 매수호가에 걸어 두고, 그 아래로 거래가 찍혀야 체결된 걸로 침
        const L = CFG.limitOrder || {}, px = bid, q = Math.floor(Math.min(equity(A) * CFG.positionPct, A.cash) / px);
        if (q * px < CFG.fills.minOrderUsd) continue;
        const why = [`VWAP${vw > 0 ? (last / vw - 1 >= 0 ? '+' : '') + pct(last / vw - 1) : '?'}`, `호가${imbalance(book).toFixed(2)}`, sig.depth ? `VWAP아래${pct(sig.depth)}` : null, sig.r5 != null ? `5분${pct(sig.r5)}` : null, '지정가'].filter(Boolean).join(' ');
        const reserve = q * px + fee(q * px, 'BUY');
        A.cash -= reserve; A.lim.placed += 1;
        A.orders[sym] = { px, qty: q, reserve, placedAt: t, expires: t + (L.waitSec || 180) * 1000, spread, kind: sig.kind, why, sigStop: sig.stopPx };
        log(`[${st.id}] ${sym} 지정가 매수 주문 ${q}주 @ $${px.toFixed(4)} (매도호가 $${ask.toFixed(4)}, ${L.waitSec || 180}초 대기) | ${why}`);
        return;
      }
      const want = Math.floor(Math.min(equity(A) * CFG.positionPct, A.cash) / ask);
      const { filled, avgPx } = simFill(book, 'BUY', want, ask * (1 + E.maxEntrySlipPct));
      if (filled * (avgPx || 0) < CFG.fills.minOrderUsd) { countBlock(A, st.id, sym, '매도호가 물량 부족'); logSkip(`${st.id}${sym}q`, `[${st.id}] ${sym} 신호 — 매도호가 물량 부족(원한 ${want}주, 가능 ${filled}주), 건너뜀`); continue; }
      const notional = filled * avgPx, f = fee(notional, 'BUY');
      let stopPx = avgPx * (1 - X.stopLossPct);
      if (X.useStructureStop && sig.stopPx) stopPx = Math.min(Math.max(sig.stopPx, stopPx), avgPx * (1 - X.minStopPct)); // 눌림 저점 아래, 최대 손실폭과 최소 폭 사이
      const why = [`VWAP${vw > 0 ? (last / vw - 1 >= 0 ? '+' : '') + pct(last / vw - 1) : '?'}`, `거래량${sig.volRatio.toFixed(1)}배`, `호가${imbalance(book).toFixed(2)}`,
        `RVOL${Number.isFinite(ctx.rvol) ? ctx.rvol.toFixed(1) : '?'}`, `주식${Number.isFinite(ctx.shares) ? (ctx.shares / 1e6).toFixed(1) + 'M' : '?'}`, sig.depth ? `${sig.kind === 'VWAP눌림' ? 'VWAP아래' : '눌림'}${pct(sig.depth)}` : null, sig.r5 != null ? `5분${pct(sig.r5)}` : null].filter(Boolean).join(' ');
      A.cash -= notional + f; A.tradesToday += 1;
      A.positions[sym] = { qty: filled, avgPx, cost: notional + f, entryT: t, peak: avgPx, spread, stopPx, kind: sig.kind, why };
      log(`[${st.id}] ${sym}${w.mine ? '(내 종목)' : ''} 진입(${sig.kind}) ${filled}/${want}주 @ $${avgPx.toFixed(4)} 손절 $${stopPx.toFixed(4)} | ${why} | 스프레드 ${pct(spread)}, 당일 ${pct(w.change)}`);
      return; // 전략마다 한 번에 한 종목만
    }
  }

  function daySummary() {
    log(`=== ${sess.date} 마감 ===`);
    for (const st of STRATS) {
      const A = S.accts[st.id], T = A.closed, wins = T.filter(x => x.pnl > 0), pnl = T.reduce((s, x) => s + x.pnl, 0);
      const reasons = {}; for (const x of T) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
      log(`[${st.id} ${st.name}] 거래 ${T.length}건, 승률 ${T.length ? pct(wins.length / T.length) : '-'}, 손익 ${fmt$(pnl)} (약 ${Math.round(pnl * fx).toLocaleString()}원), 자산 ${fmt$(equity(A))} | 청산 ${JSON.stringify(reasons)}${Object.keys(A.blocked).length ? ` | 필터로 거른 신호 ${JSON.stringify(A.blocked)}` : ''}`);
      if (Object.keys(A.diag || {}).length) log(`[${st.id} 진단] 신호가 막힌 단계(종목·분 단위): ${topDiag(A.diag)}`);
      if (st.order === 'limit' && A.lim) log(`[${st.id} 지정가] 주문 ${A.lim.placed}건 중 체결 ${A.lim.filled}건, 미체결 취소 ${A.lim.expired}건`);
      csvRow(DAILY, ['날짜(ET)', '전략', '거래수', '익절수', '손익USD', '손익원', '마감자산USD'], [sess.date, st.id, T.length, wins.length, pnl.toFixed(2), Math.round(pnl * fx), equity(A).toFixed(2)]);
    }
  }

  process.on('SIGINT', () => { try { if (!SIM) unlinkSync(LOCK); } catch { /* 무시 */ } saveState(S); dumpBars(); log(`중단 — ${STRATS.map(st => `${st.id} 자산 ${fmt$(equity(S.accts[st.id]))}`).join(', ')}`); process.exit(0); });

  while (true) {
    const t = now(); loopId += 1; beat();
    if (SIM && t > P.end) break;
    try {
      // 거래일 정보: 지난 거래일의 마지막 세션이 끝났으면 5분마다 다음 거래일을 다시 물어봄
      const sessDone = !sess || t > Math.max(sess.after?.e ?? 0, sess.close + 30 * MIN);
      if (sessFor === null || (sessDone && t - sessFor > 5 * MIN)) { sess = await P.session(t); sessFor = t; }
      const ph = phaseOf(sess, t);
      const busy = STRATS.some(st => Object.keys(S.accts[st.id].positions).length || Object.keys(S.accts[st.id].orders || {}).length);
      const wanted = ph && (ph === 'regular' || REC_PH.has(ph) || STRATS.some(st => stSess(st).includes(ph)));
      const nearRegular = sess && t >= sess.open - 5 * MIN && t <= sess.close + 30 * MIN;
      if (!sess || !(wanted || nearRegular || busy)) {
        if (!MOCK && t - lastStatus > 30 * MIN) { log(`장 시간이 아니라 대기 중${ph ? ` (${PHASE_KO[ph]}: 녹화·매매 안 함)` : ''}`); lastStatus = t; }
        lastPh = null;
        await sleep(60_000); if (SIM) { simNow += 60_000; P.step?.(simNow, 60); } continue;
      }
      if (S.day !== sess.date) { // 새 거래일
        S.day = sess.date; S.summaryDone = false;
        for (const st of STRATS) { const A = S.accts[st.id]; for (const o of Object.values(A.orders || {})) A.cash += o.reserve; A.orders = {}; Object.assign(A, { lim: { placed: 0, filled: 0, expired: 0 }, tradesToday: 0, pnlToday: 0, startEquity: equity(A), closed: [], cooldown: {}, lossLogged: false, blocked: {}, diag: {}, stoppedOut: {} }); }
        fx = await P.fx();
        const w = x => `${kst(x.s).slice(6)}~${kst(x.e).slice(6)}`;
        log(`거래일 ${sess.date} — 정규장 ${kst(sess.open)} ~ ${kst(sess.close)} (KST) | 데이마켓 ${w(sess.day)}, 프리 ${w(sess.pre)}, 애프터 ${w(sess.after)} | 환율 ${fx}`);
      }
      if (ph !== lastPh) { // 세션이 바뀌면 무엇을 하는지 한 줄로
        const traders = STRATS.filter(st => stSess(st).includes(ph)).map(st => st.id);
        if (ph) log(`${PHASE_KO[ph]} — 녹화 ${ph === 'regular' ? (REC ? '함' : '안 함') : REC_PH.has(ph) ? '함' : '안 함'}, 매매 전략 ${traders.join(',') || '없음'}`);
        lastPh = ph;
      }
      const inSession = ph === 'regular';
      const UU = inSession ? U : { ...U, ...(CFG.sessions?.extendedUniverse || {}) }; // 정규장 밖은 거래대금 기준을 낮춰 감시

      if (CFG.watchMyStocks !== false && t - lastMine >= 120_000) { // 내가 산 종목은 조건과 상관없이 항상 감시
        lastMine = t;
        try { mine = await P.myStocks(new Date(sess.open).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })); mineErr = false; }
        catch (e) { if (!mineErr) log(`내 종목 조회 실패(급상승 종목만 감시): ${e.message}`); mineErr = true; }
      }
      if (t - lastRank >= CFG.rankRefreshSec * 1000) {
        const g = await P.gainers(); lastRank = t;
        const gw = g.filter(x => x.currency === 'USD' && x.last >= UU.minPrice && x.last <= UU.maxPrice && x.change >= UU.minChangeRate && x.change <= UU.maxChangeRate && x.amount >= UU.minTradingAmountUsd)
          .sort((a, b) => b.amount - a.amount).slice(0, UU.topN);
        const gm = new Map(g.map(x => [x.symbol, x]));
        for (const w of gw) w.mine = mine.includes(w.symbol);
        const extra = mine.filter(s => !gw.some(w => w.symbol === s))
          .map(s => ({ symbol: s, currency: 'USD', last: gm.get(s)?.last ?? NaN, amount: gm.get(s)?.amount ?? NaN, change: gm.get(s)?.change ?? NaN, mine: true }));
        watch = [...extra, ...gw];
        if (inSession || REC_PH.has(ph)) recAppend('_rankings.jsonl', { t, ph, gainers: g.map(x => [x.symbol, x.last, x.change, x.amount]), watch: watch.map(w => w.symbol), mine });
        const need = watch.map(w => w.symbol).filter(s => !md.info.has(s));
        if (need.length) { try { for (const [k, v] of await P.stockInfo(need)) md.info.set(k, v); } catch (e) { log(`종목 정보 조회 실패: ${e.message}`); } }
      }
      const held = new Set(STRATS.flatMap(st => Object.keys(S.accts[st.id].positions)));
      const syms = [...new Set([...held, ...watch.map(w => w.symbol)])];
      if (syms.length) for (const [k, v] of await P.prices(syms)) if (v > 0) lastPx.set(k, v);
      const recNow = inSession || REC_PH.has(ph);
      if (recNow) recAppend('_prices.jsonl', { t, p: Object.fromEntries(syms.map(s => [s, lastPx.get(s) ?? null])) });
      // 호가 표본: 감시 종목을 돌아가며 N초마다 한 번씩 녹화 (세션별 스프레드·잔량을 나중에 알려고)
      const BS = CFG.sessions?.bookSampleSec;
      if (REC && recNow && BS) {
        let n = 0;
        for (const w of watch) {
          if (n >= (CFG.sessions.bookSamplePerLoop || 2)) break;
          if (now() - (recBook.get(w.symbol) || 0) < BS * 1000) continue;
          n++; try { await bookOf(w.symbol); } catch { /* 표본 실패는 무시 */ }
        }
      }
      if (t - lastDump >= 10 * MIN) { lastDump = t; dumpBars(); }

      // 분봉·일봉 갱신: 한 바퀴에 호출 6번까지 (초당 한도 보호). 보유 종목 먼저
      let calls = 0;
      for (const sym of syms) {
        if (calls >= 6) break;
        const at = md.barsAt.get(sym);
        if (at && t - at < CFG.candleRefreshSec * 1000) continue;
        const first = !md.bars.has(sym);
        await refreshBars(sym); calls += first ? 3 : 1;
        if (first) { await refreshDaily(sym); calls += 1; }
      }

      for (const st of STRATS) checkOrders(st, S.accts[st.id], t);
      for (const st of STRATS) await checkExits(st, S.accts[st.id], t);
      const anyOpen = STRATS.some(st => Object.keys(S.accts[st.id].positions).length || Object.keys(S.accts[st.id].orders || {}).length);
      const lastEnd = STRATS.length ? Math.max(...STRATS.map(st => stEnd(st))) : sess.close; // 모든 전략의 매매가 끝나는 시각 (전략이 없으면 정규장 마감)
      if (t >= lastEnd && !S.summaryDone && !anyOpen) { daySummary(); dumpBars(); S.summaryDone = true; saveState(S); }
      if (ph) for (const st of STRATS) if (stSess(st).includes(ph)) await tryEnter(st, S.accts[st.id], t);

      if (t - lastDiag >= 30 * MIN && inSession) {
        lastDiag = t;
        for (const st of STRATS) { const d = S.accts[st.id].diag; if (d && Object.keys(d).length) log(`[${st.id} 진단] 지금까지 막힌 단계: ${topDiag(d)}`); }
      }
      if (t - lastStatus >= 5 * MIN) {
        lastStatus = t;
        log(STRATS.map(st => { const A = S.accts[st.id]; return `${st.id} ${fmt$(equity(A))} 보유 ${Object.keys(A.positions).join(',') || '-'} 오늘 ${A.tradesToday}회 ${fmt$(A.pnlToday)}`; }).join(' | ') + ` | 감시 ${watch.length}종목(내 종목 ${watch.filter(w => w.mine).length})`);
      }
      saveState(S);
    } catch (e) { log(`오류: ${e.message}`); await sleep(10_000); }
    await sleep(CFG.pollSec * 1000);
    if (SIM) { simNow += CFG.pollSec * 1000; P.step?.(simNow, CFG.pollSec); }
  }
  if (SIM && !S.summaryDone) daySummary();
  if (REPLAY) log(`리플레이 호가: 녹화된 호가 ${P.stats.recorded}회, 추정 호가 ${P.stats.estimated}회 사용 (녹화 시작 ${kst(P.recStart)}${P.stats.synth ? `, 그 전은 분봉으로 순위 재구성 ${P.stats.synth}회` : ''})`);
}
function selftest() { // 합성 분봉으로 신호 함수 점검: node bot.mjs --selftest
  const T0 = Date.UTC(2026, 10, 16, 14, 30), bars = []; let px = 1;
  const add = (n, dpx, vol) => { for (let i = 0; i < n; i++) { const o = px; px *= 1 + dpx; bars.push({ t: T0 + bars.length * MIN, o, h: Math.max(o, px) * 1.001, l: Math.min(o, px) * 0.999, c: px, v: vol }); } };
  add(30, 0, 1000);       // 09:30~10:00 잔잔
  add(8, 0.035, 12000);   // 급등 +31%
  add(10, -0.01, 2500);   // 거래량 줄며 -10% 눌림
  add(1, 0.02, 6000);     // 재반등 시작 (완성봉)
  const vw = (() => { let pv = 0, v = 0; for (const b of bars) { pv += (b.h + b.l + b.c) / 3 * b.v; v += b.v; } return pv / v; })();
  const last = px * 1.01;
  const pb = pullback(bars, last, vw, T0, CFG.pullback);
  console.log('눌림목 신호:', pb ? `발생 — 고점 $${pb.H.toFixed(3)}, 눌림 ${pct(pb.depth)}, 재돌파 기준 $${pb.ref.toFixed(3)}, 구조 손절 $${pb.stopPx.toFixed(3)}` : '없음');
  const bo = breakout(bars.slice(0, 35), bars[34].c * 1.01, CFG.entry);
  console.log('돌파 신호(급등 초입):', bo ? `발생 — 기준 $${bo.ref.toFixed(3)}, 거래량 ${bo.volRatio.toFixed(1)}배` : '없음');
  const ctx = { done: bars.slice(0, 35), last: bars[34].c * 1.01, vw, shares: 8e6, rvol: 6 };
  console.log('B 필터(급등 초입):', preFilters(CFG.strategies.find(s => s.id === 'B').filters, ctx).join(', ') || '통과');
  const dg = {}; const d = why => { dg[why] = (dg[why] || 0) + 1; };
  const cb = bars.slice(0, 35), lbC = cb[cb.length - 1]; // 급등 초입: 방금 마감한 봉이 고점 위에서 끝남
  const bc = breakoutClose(cb, lbC.c * 1.005, CFG.entry, d);
  console.log('봉마감 돌파(D):', bc ? `발생 — 마감가 $${lbC.c.toFixed(3)}, 기준 $${bc.ref.toFixed(3)}, 손절 기준 $${bc.stopPx.toFixed(3)}` : `없음 (${Object.keys(dg)})`);
  const db = []; let q = 2; const put = (n, dq, v) => { for (let i = 0; i < n; i++) { const o = q; q *= 1 + dq; db.push({ t: T0 + db.length * MIN, o, h: Math.max(o, q) * 1.001, l: Math.min(o, q) * 0.999, c: q, v }); } };
  put(25, 0.002, 1000); put(6, -0.04, 7000); put(1, 0.015, 3000); put(1, 0.025, 4000); // 잔잔 → -22% 투매 → 반등 양봉 두 개
  const er = dipRebound(db, q * 1.002, T0, CFG.dipRebound, d);
  console.log('급락 반등(E):', er ? `발생 — 고점 $${er.H.toFixed(3)} → 저점 $${er.L.toFixed(3)} (-${pct(er.depth)}), 손절 기준 $${er.stopPx.toFixed(3)}` : `없음 (${JSON.stringify(dg)})`);
  const vwapOfT = arr => { let pv = 0, v = 0; for (const b of arr) { pv += (b.h + b.l + b.c) / 3 * b.v; v += b.v; } return pv / v; };
  const vb = []; q = 1.0; const putV = (n, dq, v) => { for (let i = 0; i < n; i++) { const o = q; q *= 1 + dq; vb.push({ t: T0 + vb.length * MIN, o, h: Math.max(o, q) * 1.001, l: Math.min(o, q) * 0.999, c: q, v }); } };
  putV(20, 0.012, 20000); putV(15, -0.012, 15000); putV(5, -0.004, 12000); // 급등 → VWAP 아래로 밀림 → 최근 5분도 하락
  const vwF = vwapOfT(vb), fv = vwapDip(vb, q, vwF, { gain: q / 0.8 - 1 }, CFG.vwapDip, d);
  console.log('VWAP 아래 눌림(F):', fv ? `발생 — VWAP $${vwF.toFixed(3)}보다 ${pct(fv.depth)} 아래, 5분 ${pct(fv.r5)}` : `없음 (${JSON.stringify(dg)})`);
  const fv2 = vwapDip(vb.slice(0, 22), vb[21].c, vwapOfT(vb.slice(0, 22)), { gain: 0.3 }, CFG.vwapDip, d);
  console.log('VWAP 아래 눌림(F) — 아직 VWAP 위일 때:', fv2 ? '발생(이상함)' : '없음(정상)');
  const book = { bids: [{ p: 0.99, q: 500 }, { p: 0.98, q: 800 }], asks: [{ p: 1.0, q: 300 }, { p: 1.01, q: 400 }] };
  console.log('호가잔량 비율:', imbalance(book).toFixed(2), '→', bookFilters({ minBidAskRatio: 1 }, book).join(', ') || '통과');
  const f = simFill({ asks: [{ p: 1.0, q: 20 }, { p: 1.01, q: 30 }, { p: 1.02, q: 100 }], bids: [] }, 'BUY', 30, 1.02);
  console.log('체결 시뮬레이션: 30주 중', f.filled, '주, 평균', f.avgPx.toFixed(4));
}
if (process.argv.includes('--selftest')) selftest();
else main().catch(e => { log(`중단: ${e.message}`); try { if (!SIM) unlinkSync(LOCK); } catch { /* 무시 */ } process.exit(1); });
