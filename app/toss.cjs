'use strict';
// 화면에 보여 줄 계좌(주문 가능 달러, 보유 주식)와 미국 장 운영시간만 토스 API에서 읽어요. 주문은 안 해요.
// 키는 봇과 같은 toss-mcp/.env를 써요(화면에 키를 보여 주거나 저장하지 않음).
// 토스는 토큰을 새로 발급하면 예전 토큰을 끊어요 → 봇들과 같은 orb/.toss-token.json 토큰을 같이 쓰고, 끊겼을 때만 새로 받아요.
const fs = require('node:fs');

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(), i = line.indexOf('=');
    if (line && !line.startsWith('#') && i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

class TossReader {
  constructor({ envFile, tokenFile = null, base = process.env.TOSS_BOT_API_BASE || 'https://openapi.tossinvest.com', fetchImpl = globalThis.fetch, gapMs = 150 }) {
    this.envFile = envFile; this.tokenFile = tokenFile; this.base = base; this.fetch = fetchImpl; this.gapMs = gapMs; this.issued = 0;
    this.tok = null; this.bad = null; this.acct = null; this.queue = Promise.resolve(); this.cal = new Map();
  }
  env() {
    if (!this._env) {
      if (!fs.existsSync(this.envFile)) throw Error(`토스 키 파일이 없어요: ${this.envFile}`);
      this._env = parseEnv(fs.readFileSync(this.envFile, 'utf8'));
      if (!this._env.TOSS_CLIENT_ID || !this._env.TOSS_CLIENT_SECRET) throw Error('토스 키 파일에 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET이 없어요');
    }
    return this._env;
  }
  shared() {
    if (!this.tokenFile) return null;
    try { const j = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')); return j.token && !(j.exp < Date.now()) ? j.token : null; } catch { return null; }
  }
  async token() {
    if (this.tok) return this.tok;
    const sh = this.shared();
    if (sh && sh !== this.bad) return (this.tok = sh);
    const env = this.env();
    const res = await this.fetch(`${this.base}/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TOSS_CLIENT_ID, client_secret: env.TOSS_CLIENT_SECRET }) });
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) throw Error(`토큰 발급 실패 (${res.status})`);
    this.tok = j.access_token; this.issued++;
    if (this.tokenFile) {
      try {
        const tmp = `${this.tokenFile}.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ token: this.tok, exp: Date.now() + (Number(j.expires_in) > 120 ? Number(j.expires_in) * 1000 - 60_000 : 12 * 3_600_000), at: new Date().toISOString(), by: `토스 봇 앱 pid ${process.pid}` }));
        fs.renameSync(tmp, this.tokenFile);
      } catch { /* 저장 못 하면 이 앱만 씀 */ }
    }
    return this.tok;
  }
  // 한 번에 하나씩, 조금 띄워서 (봇들과 같이 써도 초당 요청이 몰리지 않게)
  call(method, p, opts = {}) {
    const run = this.queue.then(() => this.send(method, p, opts)).finally(() => new Promise(r => setTimeout(r, this.gapMs)));
    this.queue = run.catch(() => {});
    return run;
  }
  async send(method, p, { query = {}, account = false } = {}, attempt = 0) {
    const url = new URL(p, this.base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' };
    if (account) headers['X-Tossinvest-Account'] = String(await this.accountSeq());
    const res = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 && attempt < 2) { this.bad = this.tok; this.tok = null; return this.send(method, p, { query, account }, attempt + 1); }
    if (res.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, Math.min(5, Number(res.headers.get('Retry-After')) || 1) * 1000)); return this.send(method, p, { query, account }, attempt + 1); }
    const j = await res.json().catch(() => null);
    if (!res.ok) throw Error(`${method} ${p} ${res.status} ${j?.error?.code ?? ''} ${j?.error?.message ?? ''}`.trim());
    return j && typeof j === 'object' && 'result' in j ? j.result : j;
  }
  accountSeq() {
    if (this.acct) return this.acct;
    const env = this.env();
    if (env.TOSS_ACCOUNT_SEQ) return (this.acct = Promise.resolve(env.TOSS_ACCOUNT_SEQ));
    this.acct = (async () => {
      const r = await this.send('GET', '/api/v1/accounts');
      const list = Array.isArray(r) ? r : (r?.accounts ?? r?.items ?? []);
      if (!list.length) throw Error('조회되는 계좌가 없어요');
      return list[0].accountSeq; // 봇과 같은 계좌(첫 번째)
    })();
    this.acct.catch(() => { this.acct = null; });
    return this.acct;
  }
  async account() {
    const [h, bp] = await Promise.all([
      this.call('GET', '/api/v1/holdings', { account: true }),
      this.call('GET', '/api/v1/buying-power', { query: { currency: 'USD' }, account: true }),
    ]);
    const items = (Array.isArray(h) ? h : h?.items ?? []).map(x => ({
      symbol: x.symbol, name: x.name || x.symbol, country: x.marketCountry, currency: x.currency,
      qty: num(x.quantity), avg: num(x.averagePurchasePrice), last: num(x.lastPrice),
      value: num(x.marketValue?.amount), pnl: num(x.profitLoss?.amount), rate: num(x.profitLoss?.rate),
      daily: num(x.dailyProfitLoss?.amount),
    }));
    return {
      at: Date.now(), cashUsd: num(bp?.cashBuyingPower), items,
      usd: { value: num(h?.marketValue?.amount?.usd), pnl: num(h?.profitLoss?.amount?.usd), daily: num(h?.dailyProfitLoss?.amount?.usd) },
    };
  }
  // 그 날(미국 동부 날짜) 정규장 시작·마감 (휴장이면 closed)
  async calendarDay(date, etToMs) {
    const hit = this.cal.get(date);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.v;
    const T = (await this.call('GET', '/api/v1/market-calendar/US', { query: { date } }))?.today;
    const [y, m, d] = date.split('-').map(Number);
    const t = s => { const mm = typeof s === 'string' && s.match(/^(\d{2}):(\d{2})/); return mm ? etToMs(y, m - 1, d, +mm[1], +mm[2]) : Date.parse(s); };
    let v;
    if (T && !T.regularMarket) v = { date, closed: true, source: 'toss' };
    else {
      const open = t(T?.regularMarket?.startTime), close = t(T?.regularMarket?.endTime);
      v = Number.isFinite(open) && Number.isFinite(close) ? { date, open, close, source: 'toss' } : null;
    }
    if (v) this.cal.set(date, { at: Date.now(), v });
    return v;
  }
}

module.exports = { TossReader, parseEnv };
