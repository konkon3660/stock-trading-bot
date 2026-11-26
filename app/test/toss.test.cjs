// node app/test/toss.test.cjs — 가짜 토스 서버로 계좌·장 달력 읽기 시험
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TossReader } = require('../toss.cjs');
const { marketNow, etToMs } = require('../market.cjs');

(async () => {
  const seen = [];
  let tokens = 0, fail401 = true;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname} acct=${req.headers['x-tossinvest-account'] || '-'}`);
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/oauth2/token') { tokens++; return send(200, { access_token: 'T' + tokens, expires_in: 3600 }); }
    if (req.headers.authorization !== 'Bearer T' + tokens) return send(401, { error: { code: 'expired' } });
    if (u.pathname === '/api/v1/accounts') return send(200, { result: [{ accountSeq: 7 }] });
    if (u.pathname === '/api/v1/holdings') {
      if (fail401) { fail401 = false; tokens++; return send(401, {}); } // 토큰이 바뀐 상황 → 한 번 다시 발급
      return send(200, { result: { marketValue: { amount: { usd: '63.6' } }, profitLoss: { amount: { usd: '-3.32' } }, dailyProfitLoss: { amount: { usd: '-2.35' } },
        items: [{ symbol: 'BENF', name: '베네피선트', marketCountry: 'US', currency: 'USD', quantity: '20', lastPrice: '0.7977', averagePurchasePrice: '0.933', marketValue: { amount: '15.95' }, profitLoss: { amount: '-2.71', rate: '-0.145' } }] } });
    }
    if (u.pathname === '/api/v1/buying-power') return send(200, { result: { currency: 'USD', cashBuyingPower: '45.44' } });
    if (u.pathname === '/api/v1/market-calendar/US') {
      const d = u.searchParams.get('date');
      if (d === '2026-11-26') return send(200, { result: { today: { regularMarket: null } } }); // 추수감사절
      if (d === '2026-11-27') return send(200, { result: { today: { regularMarket: { startTime: '09:30', endTime: '13:00' } } } }); // 조기 마감
      return send(200, { result: { today: { regularMarket: { startTime: '09:30', endTime: '16:00' } } } });
    }
    if (u.pathname === '/api/v1/candles') { // 1분봉 500개를 최신부터 200개씩, nextBefore = 다음 쪽 시작 위치
      const T0 = Date.parse('2026-11-25T23:31:00+09:00'), all = Array.from({ length: 500 }, (_, i) => ({ timestamp: new Date(T0 + i * 60_000).toISOString(), closePrice: String(1 + i / 1000) }));
      const end = u.searchParams.get('before') ? Number(u.searchParams.get('before')) : all.length, start = Math.max(0, end - Number(u.searchParams.get('count')));
      return send(200, { result: { candles: all.slice(start, end).reverse(), nextBefore: start > 0 ? String(start) : null } });
    }
    send(404, {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const env = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tossenv-')), '.env');
  fs.writeFileSync(env, 'TOSS_CLIENT_ID=a\nTOSS_CLIENT_SECRET="b"\n');
  const t = new TossReader({ envFile: env, base: `http://127.0.0.1:${srv.address().port}`, gapMs: 1 });

  const a = await t.account();
  assert.equal(a.cashUsd, 45.44);
  assert.equal(a.items[0].symbol, 'BENF'); assert.equal(a.items[0].qty, 20); assert.equal(a.items[0].rate, -0.145);
  assert.equal(a.usd.pnl, -3.32);
  assert.ok(seen.some(s => s.includes('/holdings acct=7')));
  assert.equal(seen.filter(s => s.includes('/accounts')).length, 1, '계좌 번호는 한 번만 조회');
  console.log('ok 1 계좌 읽기 (401 → 토큰 다시 발급)');

  const day = date => t.calendarDay(date, etToMs);
  // 2026-11-25 수 10:00 KST = 11-24 20:00 ET → 닫힘, 다음 정규장 11-25 09:30 ET = 23:30 KST
  let m = await marketNow(Date.parse('2026-11-25T10:00:00+09:00'), day);
  assert.equal(m.phase, 'closed'); assert.equal(m.next.at, Date.parse('2026-11-25T23:30:00+09:00'));
  m = await marketNow(Date.parse('2026-11-26T01:00:00+09:00'), day); // 11-25 11:00 ET
  assert.equal(m.phase, 'regular'); assert.equal(m.next.at, Date.parse('2026-11-26T06:00:00+09:00'));
  m = await marketNow(Date.parse('2026-11-26T07:00:00+09:00'), day);
  assert.equal(m.phase, 'after'); assert.equal(m.next.at, Date.parse('2026-11-26T10:00:00+09:00'));
  m = await marketNow(Date.parse('2026-11-26T12:00:00+09:00'), day); // 추수감사절 → 27일(금) 조기 마감일이 다음
  assert.equal(m.phase, 'closed'); assert.equal(m.next.date, '2026-11-27');
  assert.equal(m.last.date, '2026-11-25', '한국 낮엔 지난밤(11-25) 장을 보여 줌');
  assert.equal((await marketNow(Date.parse('2026-11-27T01:00:00+09:00'), day)).last.date, '2026-11-25', '휴장일엔 그 전 장');
  m = await marketNow(Date.parse('2026-11-27T01:00:00+09:00'), day); // 11-26 11:00 ET 휴장
  assert.equal(m.holiday, true); assert.equal(m.phase, 'closed');
  m = await marketNow(Date.parse('2026-11-28T02:00:00+09:00'), day); // 11-27 12:00 ET (13:00 마감)
  assert.equal(m.phase, 'regular'); assert.equal(m.next.at, Date.parse('2026-11-28T03:00:00+09:00'));
  m = await marketNow(Date.parse('2026-11-25T23:00:00+09:00'), day); // 09:00 ET 프리장
  assert.equal(m.phase, 'pre');
  m = await marketNow(Date.parse('2026-11-29T12:00:00+09:00'), () => Promise.reject(Error('네트워크 없음'))); // 일요일, 달력 못 읽음 → 평일 규칙
  assert.equal(m.source, 'guess'); assert.equal(m.next.date, '2026-11-30');
  console.log('ok 2 장 시간 (정규·애프터·프리·휴장·조기 마감·달력 없음)');

  // 차트: 정규장(23:30~06:00 KST) 1분봉을 쪽을 넘겨 다 모음, 끝난 장은 캐시
  const open = Date.parse('2026-11-25T23:30:00+09:00'), close = Date.parse('2026-11-26T06:00:00+09:00');
  const calls = () => seen.filter(s => s.includes('/candles')).length;
  const bars = await t.chart('ABC', open, close);
  assert.equal(bars.length, 390); assert.equal(bars[0].t, open + 60_000); assert.equal(bars.at(-1).t, close);
  assert.ok(bars.every((b, i) => !i || b.t > bars[i - 1].t), '시간 순서');
  assert.equal(calls(), 3, '500개를 200개씩 3쪽');
  await t.chart('ABC', open, close); assert.equal(calls(), 3, '끝난 장은 다시 안 받음');
  console.log('ok 4 차트 1분봉 (쪽 넘기기·캐시)');

  const t2 = new TossReader({ envFile: env + '.none' });
  await assert.rejects(() => t2.account(), /토스 키 파일이 없어요/);
  console.log('ok 3 키 파일 없을 때 알림');
  srv.close();
  console.log('ALL OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
