// node app/test/token.test.cjs [gap_dip.mjs 경로] — 토스처럼 '새로 발급하면 예전 토큰을 끊는' 가짜 서버로
// 봇 셋(진짜 gap_dip.mjs)과 앱(toss.cjs)이 토큰 하나를 같이 쓰는지 시험. 주문은 안 함(휴장일로 응답).
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TossReader } = require('../toss.cjs');

const BOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'orb', 'gap_dip.mjs'));
(async () => {
  let current = null, n = 0, issued = 0, revoked401 = 0, orders = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/oauth2/token') { issued++; current = 'T' + (++n); return send(200, { access_token: current, expires_in: 86400 }); }
    if (req.headers.authorization !== `Bearer ${current}`) { revoked401++; return send(401, { error: { code: 'token-revoked', message: '새로 발급된 토큰으로 대체되어 더 이상 유효하지 않은 토큰입니다.' } }); }
    if (req.method === 'POST') { orders++; return send(400, {}); }
    if (u.pathname === '/api/v1/accounts') return send(200, { result: [{ accountSeq: 1 }] });
    if (u.pathname === '/api/v1/market-calendar/US') return send(200, { result: { today: { regularMarket: null } } }); // 휴장 → 봇은 바로 끝
    if (u.pathname === '/api/v1/holdings') return send(200, { result: { items: [] } });
    if (u.pathname === '/api/v1/buying-power') return send(200, { result: { cashBuyingPower: '10' } });
    send(404, {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toktest-'));
  fs.mkdirSync(path.join(tmp, 'toss-mcp')); fs.writeFileSync(path.join(tmp, 'toss-mcp', '.env'), 'TOSS_CLIENT_ID=a\nTOSS_CLIENT_SECRET=b\n');
  const orb = path.join(tmp, 'toss-paper-bot', 'orb'); fs.mkdirSync(orb, { recursive: true });
  fs.copyFileSync(BOT, path.join(orb, 'gap_dip.mjs'));
  fs.writeFileSync(path.join(orb, 'live.json'), JSON.stringify({ perTradeUsd: 'all', maxEntriesPerDay: 5, maxOpenPositions: 1, dailyLossLimitUsd: 3, totalLossLimitUsd: 10 }));
  const tokenFile = path.join(orb, '.toss-token.json');
  const run = args => new Promise(resolve => {
    const p = spawn(process.execPath, ['orb/gap_dip.mjs', ...args], { cwd: path.join(tmp, 'toss-paper-bot'), env: { ...process.env, TOSS_API_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code, out }));
  });
  const BOTS = [['--live', '--check'], ['--hold', '--live', '--once'], ['--ah', '--live', '--once']];
  const ok = r => { assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /멈췄어요|토큰 발급 실패|401/, r.out); };

  // A) 셋을 동시에 켜도(파일 없음) 모두 끝까지 감
  const a = await Promise.all(BOTS.map(run)); a.forEach(ok);
  assert.ok(fs.existsSync(tokenFile)); assert.ok(issued <= 3, `발급 ${issued}번`);
  console.log(`ok A 동시에 켜기: 셋 다 정상 (발급 ${issued}번, 끊긴 토큰 401 ${revoked401}번)`);

  // B) 파일 토큰이 살아 있으면 새로 안 받음 → 서로 안 끊음
  let before = issued;
  for (const args of BOTS) ok(await run(args));
  assert.equal(issued, before, '새로 발급하면 안 됨');
  console.log('ok B 파일 토큰을 같이 씀 (새 발급 0번)');

  // C) 밖(toss-mcp 같은 다른 프로그램)이 새로 발급해 끊으면: 처음 걸린 봇만 한 번 받고, 나머지는 파일 걸 씀
  await fetch(`${base}/oauth2/token`, { method: 'POST' }); before = issued;
  ok(await run(BOTS[1]));
  assert.equal(issued, before + 1);
  ok(await run(BOTS[0])); ok(await run(BOTS[2]));
  assert.equal(issued, before + 1);
  console.log('ok C 밖에서 끊겨도 한 번만 다시 받음');

  // D) 앱(toss.cjs)도 같은 파일을 씀
  const t = new TossReader({ envFile: path.join(tmp, 'toss-mcp', '.env'), tokenFile, base, gapMs: 1 });
  before = issued;
  const acc = await t.account(); assert.equal(acc.cashUsd, 10); assert.equal(issued, before);
  await fetch(`${base}/oauth2/token`, { method: 'POST' }); before = issued; // 밖에서 또 끊음
  await t.account(); assert.equal(issued, before + 1);
  ok(await run(BOTS[1])); assert.equal(issued, before + 1); // 봇은 앱이 받아 둔 걸 씀
  console.log('ok D 앱과 봇이 같은 토큰');
  assert.equal(orders, 0);
  srv.close();
  console.log('ALL OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
