// node app/test/supervisor.test.cjs — 가짜 봇으로 봇 관리자 시험 (Electron 없이)
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Supervisor } = require('../supervisor.cjs');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, what = '') { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await wait(40); } throw Error('시간 초과: ' + what); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tossbot-'));
  fs.mkdirSync(path.join(root, 'orb'));
  fs.copyFileSync(path.join(__dirname, 'fake_bot.mjs'), path.join(root, 'orb', 'fake_bot.mjs'));
  fs.writeFileSync(path.join(root, 'orb', 'modes.json'), JSON.stringify({ gap: 'live', hold: 'paper', ah: 'off', note: '다른 키는 보존' }));
  const sup = new Supervisor({ root, nodeCmd: process.execPath, script: 'orb/fake_bot.mjs', restartDelayMs: 200, maxRestartsPerHour: 3, externalPollMs: 100 });
  const lines = [], events = [];
  sup.on('line', (k, l, kind) => lines.push([k, l, kind]));
  sup.on('crash', k => events.push('crash:' + k));
  sup.on('gave-up', k => events.push('gave-up:' + k));
  const st = k => sup.status().find(b => b.key === k);

  // 1) modes.json대로 켜기
  sup.startAll();
  await until(() => st('gap').state === 'running' && st('hold').state === 'running', 3000, '켜기');
  assert.equal(st('ah').state, 'off');
  assert.equal(st('gap').runMode, 'live');
  await until(() => lines.some(([k, l]) => k === 'gap' && l.includes('매수 체결')), 3000, '출력');
  assert.ok(fs.existsSync(path.join(root, 'orb', 'data-gap-live', 'events.log')));
  console.log('ok 1 켜기·출력·실전/연습 폴더');

  // 2) 모드 바꾸기: hold 끄기 → 파일에 저장, 다른 키 보존
  await sup.setMode('hold', 'off');
  assert.equal(st('hold').state, 'off');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'orb', 'modes.json'), 'utf8'));
  assert.equal(saved.hold, 'off'); assert.equal(saved.note, '다른 키는 보존');
  // gap 실전 → 연습: 다시 켜지고 연습 폴더로
  await sup.setMode('gap', 'paper');
  await until(() => st('gap').state === 'running' && st('gap').runMode === 'paper', 3000, '연습 전환');
  console.log('ok 2 모드 바꾸기');

  // 3) 계속 멈추면 1분(여기선 0.2초) 뒤 다시 켜고, 한도 넘으면 그만
  fs.writeFileSync(path.join(root, 'orb', 'fake-gap.txt'), 'crash');
  await sup.restart('gap');
  await until(() => st('gap').state === 'gave-up', 5000, '그만');
  assert.ok(events.filter(e => e === 'crash:gap').length >= 2, events.join());
  assert.ok(events.includes('gave-up:gap'));
  assert.ok(st('gap').err.some(l => l.includes('가짜 오류')));
  fs.writeFileSync(path.join(root, 'orb', 'fake-gap.txt'), 'run');
  await sup.restart('gap');
  await until(() => st('gap').state === 'running', 3000, '직접 다시 켜기');
  console.log('ok 3 멈춤 → 다시 켬 → 한도에서 그만 → 직접 다시 켜기');

  // 4) 다른 창에서 같은 봇이 돌면(코드 3) 'external' → 그 창이 꺼지면 저절로 여기서 켬
  fs.writeFileSync(path.join(root, 'orb', 'fake-ah.txt'), 'hold-only');
  const other = spawn(process.execPath, ['orb/fake_bot.mjs', '--ah'], { cwd: root, stdio: 'ignore' });
  await until(() => fs.existsSync(path.join(root, 'orb', 'data-ah', 'running.pid')) && Number(fs.readFileSync(path.join(root, 'orb', 'data-ah', 'running.pid'), 'utf8')) === other.pid, 3000, '다른 창 봇');
  fs.writeFileSync(path.join(root, 'orb', 'fake-ah.txt'), 'run');
  await sup.setMode('ah', 'paper');
  await until(() => st('ah').state === 'external', 3000, 'external');
  assert.equal(st('ah').ext, other.pid);
  other.kill();
  await until(() => st('ah').state === 'running', 3000, '넘겨받기');
  console.log('ok 4 다른 창 봇 감지 → 꺼지면 저절로 넘겨받기');

  // 5) takeOver: 다른 창 봇을 끄고 여기서 켜기
  await sup.setMode('hold', 'paper');
  await until(() => st('hold').state === 'running', 3000, 'hold');
  await sup.stop('hold'); // 관리자 쪽만 끄고
  fs.writeFileSync(path.join(root, 'orb', 'fake-hold.txt'), 'hold-only');
  const other2 = spawn(process.execPath, ['orb/fake_bot.mjs', '--hold'], { cwd: root, stdio: 'ignore' });
  await until(() => sup.lockPid('hold', 'paper') === other2.pid, 3000, '다른 창 hold');
  assert.equal(st('hold').ext, other2.pid);
  fs.writeFileSync(path.join(root, 'orb', 'fake-hold.txt'), 'run');
  await sup.takeOver('hold');
  await until(() => st('hold').state === 'running' && other2.exitCode !== null || other2.signalCode !== null, 4000, 'takeOver');
  await until(() => st('hold').state === 'running', 3000, 'takeOver 켜짐');
  console.log('ok 5 다른 창 봇 끄고 넘겨받기');

  // 6) 남이 쓰는 번호면 안 끔
  const sup2 = new Supervisor({ root, nodeCmd: process.execPath, script: 'orb/fake_bot.mjs', isBotProcess: () => false, externalPollMs: 100000 });
  const other3 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'orb', 'data-gap'), { recursive: true });
  await sup.stop('gap');
  fs.writeFileSync(path.join(root, 'orb', 'data-gap', 'running.pid'), String(other3.pid));
  await assert.rejects(() => sup2.takeOver('gap'), /봇이 아닌 다른 프로그램/);
  assert.equal(other3.exitCode, null);
  other3.kill(); sup2.stopAll();
  console.log('ok 6 봇이 아닌 프로그램은 안 끔');

  // 7) 모두 끄기
  await sup.stopAll();
  assert.ok(sup.status().every(b => !b.pid));
  console.log('ok 7 모두 끄기');
  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
