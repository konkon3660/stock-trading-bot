// node app/test/main.smoke.cjs — 가짜 Electron으로 main.cjs 시험 (창·트레이·화면 요청·종료). 진짜 봇·토스는 안 씀
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tossbot-main-'));
const root = path.join(tmp, 'toss-paper-bot'), appDir = path.join(root, 'app');
fs.mkdirSync(path.join(root, 'orb'), { recursive: true });
fs.cpSync(path.join(__dirname, '..'), appDir, { recursive: true, filter: s => !s.includes(`${path.sep}runtime`) });
fs.copyFileSync(path.join(__dirname, 'fake_bot.mjs'), path.join(root, 'orb', 'gap_dip.mjs'));
fs.writeFileSync(path.join(root, 'orb', 'modes.json'), JSON.stringify({ gap: 'live', hold: 'live', ah: 'paper' }));
fs.writeFileSync(path.join(root, 'orb', 'live.json'), JSON.stringify({ perTradeUsd: 'all', dailyLossLimitUsd: 3, totalLossLimitUsd: 10 }));

const rec = { handlers: {}, sent: [], dialogs: [], balloons: [], tips: [], blocker: [], login: [], quit: 0, appEvents: {}, shortcuts: [] };
let answer = 0;
class EventBox { constructor() { this.ev = {}; } on(e, f) { (this.ev[e] ??= []).push(f); return this; } once(e, f) { return this.on(e, f); } emit(e, ...a) { (this.ev[e] || []).forEach(f => f(...a)); } }
class BrowserWindow extends EventBox {
  constructor(o) { super(); this.opts = o; this.visible = false; this.webContents = { setWindowOpenHandler() {}, on() {}, send: (...a) => rec.sent.push(a) }; }
  removeMenu() {} loadFile(f) { this.file = f; setTimeout(() => this.emit('ready-to-show'), 0); return Promise.resolve(); }
  isDestroyed() { return false; } isVisible() { return this.visible; } isMinimized() { return false; } restore() {}
  show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; } focus() {}
}
class Tray extends EventBox { constructor() { super(); } setImage() {} setToolTip(t) { rec.tips.push(t); } setContextMenu(m) { this.menu = m; } displayBalloon(b) { rec.balloons.push(b); } destroy() { rec.trayDestroyed = true; } }
const app = {
  setName() {}, setPath(k, v) { this.paths[k] = v; }, getPath(k) { return this.paths[k] || path.join(tmp, k); }, paths: {},
  requestSingleInstanceLock: () => true, on(e, f) { (rec.appEvents[e] ??= []).push(f); }, whenReady: () => Promise.resolve(),
  setAppUserModelId() {}, setLoginItemSettings(o) { rec.login.push(o); }, getVersion: () => '1.0.0',
  quit() { rec.quit++; const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (rec.appEvents['before-quit'] || []).forEach(f => f(ev)); if (!ev.defaultPrevented) rec.exited = true; },
  exit() { rec.exited = true; },
};
const electron = {
  app, BrowserWindow, Tray, Menu: { buildFromTemplate: t => t }, nativeTheme: { shouldUseDarkColors: false },
  nativeImage: { createFromBitmap: (b, o) => ({ toPNG: () => Buffer.from('png'), size: o }) },
  ipcMain: { handle: (ch, fn) => { rec.handlers[ch] = fn; } },
  dialog: { showMessageBox: async (...a) => { rec.dialogs.push(a.at(-1)); return { response: answer }; }, showErrorBox: (t, m) => { rec.fatal = m; } },
  shell: { writeShortcutLink: (p) => { rec.shortcuts.push(p); return true; }, openPath: async p => { rec.opened = p; return ''; } },
  powerSaveBlocker: { start: t => { rec.blocker.push('start:' + t); return 7; }, stop: id => rec.blocker.push('stop:' + id) },
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electron : orig.call(this, req, ...rest); };
process.env.TOSS_BOT_SMOKE = '1';
process.env.TOSS_BOT_DATA_DIR = path.join(tmp, 'userdata');
process.env.TOSS_BOT_NODE = process.execPath;
process.env.TOSS_BOT_API_BASE = 'http://127.0.0.1:9'; // 토스 대신 아무도 없는 곳 → 계좌 읽기 실패가 화면에 나와야 함

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, what = '') { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await wait(50); } throw Error('시간 초과: ' + what); }

(async () => {
  require(path.join(appDir, 'main.cjs'));
  await until(() => globalThis.__tossBot, 3000, '시작');
  const { sup, win } = globalThis.__tossBot;
  const call = (ch, ...a) => rec.handlers[ch]({ sender: win.webContents }, ...a);
  const st = k => sup.status().find(b => b.key === k);

  await until(() => ['gap', 'hold', 'ah'].every(k => st(k).state === 'running'), 4000, '봇 셋 켜짐');
  await until(() => rec.blocker.includes('start:prevent-app-suspension'), 2000, '절전 방지');
  await until(() => rec.tips.at(-1)?.includes('갭 봇: 실전 · 돌고 있음'), 2000, '트레이 툴팁');
  assert.ok(rec.tips.at(-1).length <= 127);
  assert.equal(win.visible, false, 'TEST에선 창을 안 띄움');
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  console.log('ok 1 시작: 봇 셋 켜짐 · 트레이 · 절전 방지 · 샌드박스 창');

  await assert.rejects(() => rec.handlers.snapshot({ sender: {} }), /허용하지 않는/);
  const snap = await call('snapshot');
  assert.equal(snap.bots.length, 3); assert.ok(snap.market.phase); assert.ok(snap.stats.limits);
  assert.equal(snap.settings.loginStart, true);
  win.show(); // 창을 열면 계좌를 읽음 → 실패가 기록돼야
  await until(async () => (await call('snapshot')).account.error, 6000, '계좌 실패 표시');
  const s2 = await call('snapshot');
  assert.match(s2.account.error, /토스 키 파일이 없어요|fetch failed|ECONNREFUSED/);
  console.log('ok 2 화면 요청: 다른 곳에서 온 요청은 거절 · 계좌 실패를 화면에 전달:', s2.account.error.slice(0, 60));

  const log = await call('log', 'gap');
  assert.equal(log.mode, 'live'); assert.ok(log.lines.some(l => l.includes('매수 체결')));
  console.log('ok 3 기록 읽기');

  // 실전 → 연습: 물어보지 않음(보유 없음), 실전으로 바꿀 땐 물어봄 → 취소하면 그대로
  assert.equal(await call('setMode', 'gap', 'paper'), true);
  await until(() => st('gap').runMode === 'paper', 3000, '연습 전환');
  answer = 1; const n = rec.dialogs.length;
  assert.equal(await call('setMode', 'gap', 'live'), false);
  assert.equal(rec.dialogs.length, n + 1); assert.match(rec.dialogs.at(-1).message, /실전으로 바꿀까요/);
  assert.match(rec.dialogs.at(-1).detail, /주문 가능 달러 현금 전부/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'orb', 'modes.json'), 'utf8')).gap, 'paper');
  answer = 0;
  assert.equal(await call('setMode', 'gap', 'live'), true);
  await until(() => st('gap').runMode === 'live', 3000, '실전 전환');
  console.log('ok 4 모드 바꾸기 (실전은 확인 · 취소하면 그대로)');

  // 봇이 주식을 들고 있으면 끄기 전에 경고
  fs.writeFileSync(path.join(root, 'orb', 'data-gap-live', 'state.json'), JSON.stringify({ cum: -1, days: {}, pos: { s: 'KTTA', qty: 27, px: 1.42, target: 1.56, stop: 1.136, date: '2026-11-25' }, buy: null }));
  answer = 1;
  assert.equal(await call('setMode', 'gap', 'off'), false);
  assert.match(rec.dialogs.at(-1).detail, /KTTA 27주를 들고 있어요/);
  assert.equal(st('gap').state, 'running');
  answer = 0;
  console.log('ok 5 보유 중일 때 끄기 경고');

  assert.equal(await call('setFlag', 'STOP_GAP', true), true);
  assert.ok(fs.existsSync(path.join(root, 'orb', 'STOP_GAP')));
  assert.equal(await call('setFlag', 'STOP_GAP', false), true);
  assert.ok(!fs.existsSync(path.join(root, 'orb', 'STOP_GAP')));
  answer = 1; assert.equal(await call('setFlag', 'FLATTEN_GAP', true), false); assert.ok(!fs.existsSync(path.join(root, 'orb', 'FLATTEN_GAP')));
  await assert.rejects(() => call('setFlag', '../../evil', true), /없는 정지 파일/);
  answer = 0;
  console.log('ok 6 정지 파일 켜고 끄기 · 다 팔기는 확인 · 이상한 이름 거절');

  await call('setSetting', 'loginStart', false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'userdata', 'settings.json'), 'utf8')).loginStart, false);
  await assert.rejects(() => call('setSetting', 'evil', 1), /없는 설정/);
  await call('openPath', 'data:hold'); assert.ok(rec.opened.endsWith('data-hold-live'));
  await assert.rejects(() => call('openPath', 'data:../../x'), /없는 봇/);
  console.log('ok 7 설정 저장 · 폴더 열기(봇 이름만)');

  // 이미 켜져 있을 때 또 열기 → 숨은 창이 다시 보임 (2026-11-25 'showWindow is not defined' 오류 다시 안 나게)
  win.hide();
  rec.appEvents['second-instance'].forEach(f => f({}, [], '', {}));
  assert.equal(win.visible, true);
  rec.tips.length = 0; globalThis.__tossBot.sup.emit('change', 'gap'); // 트레이 클릭도 같은 함수
  console.log('ok 7b 두 번째로 열면 창이 앞으로');

  // 창 닫기 → 숨김(트레이에 남음) + 처음 한 번 안내
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  win.emit('close', ev);
  assert.ok(ev.prevented); assert.equal(win.visible, false);
  console.log('ok 8 창 닫으면 트레이로');

  // 종료: 확인 → 봇 모두 끄고 앱 끝
  answer = 1; assert.equal(await call('quit'), false); assert.equal(rec.quit, 0);
  answer = 0; assert.equal(await call('quit'), true);
  await until(() => rec.exited, 6000, '종료');
  assert.ok(sup.status().every(b => !b.pid), '봇 다 꺼짐');
  assert.ok(rec.blocker.includes('stop:7'));
  assert.ok(rec.trayDestroyed);
  console.log('ok 9 종료: 확인 → 봇 모두 끔 · 절전 방지 풂 · 트레이 정리');
  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e, rec.fatal || ''); process.exit(1); });
