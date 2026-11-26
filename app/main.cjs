'use strict';
// 토스 봇 — Immerse OS처럼 트레이에 상주하면서 봇 세 개를 돌리고, 열면 화면으로 보여 줘요.
//   · PC 켤 때 자동 시작(--hidden: 창 없이 트레이에서 시작) · 창을 닫아도 트레이에 남음 · 종료는 트레이 메뉴
//   · 두 번 실행하면 이미 떠 있는 창을 앞으로 · 봇이 도는 동안 PC 절전 방지 · 체결·청산·오류는 알림
// 실행 파일: app/runtime/TossBot.exe (Electron 44.5.0, runtime/resources/app/boot.cjs → 이 파일)
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, powerSaveBlocker, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Supervisor } = require('./supervisor.cjs');
const { readStats, tail, setFlag } = require('./stats.cjs');
const { TossReader } = require('./toss.cjs');
const { marketNow, etToMs } = require('./market.cjs');
const icons = require('./icons.cjs');

const APP_ID = 'com.tossbot.app';
const ROOT = path.resolve(__dirname, '..'); // C:\Projects\toss-bot
const HIDDEN = process.argv.includes('--hidden');
const TEST = !!process.env.TOSS_BOT_SMOKE;
app.setName('TossBot');
app.setPath('userData', process.env.TOSS_BOT_DATA_DIR ? path.resolve(process.env.TOSS_BOT_DATA_DIR) : path.join(app.getPath('appData'), 'TossBot'));

if (!app.requestSingleInstanceLock()) app.quit();
else start();

function findNode() {
  if (process.env.TOSS_BOT_NODE) return { cmd: process.env.TOSS_BOT_NODE, env: {}, label: process.env.TOSS_BOT_NODE };
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(s => s && fs.existsSync(s));
    if (first) return { cmd: first, env: { ELECTRON_RUN_AS_NODE: '' }, label: first };
  } catch { /* PATH에 node 없음 */ }
  // PC에 node가 없으면 이 앱(Electron) 안의 node로 돌려요
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, label: '토스 봇 안의 node (PC에 node 없음)' };
}

function start() {
  let win = null, tray = null, quitting = false, stopped = false, blocker = null, trayColor = '';
  let account = { data: null, error: null, at: 0, busy: false }, market = null, marketAt = 0;
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  const settings = Object.assign({ loginStart: true, notify: true, shortcutsMade: false, trayHint: false }, (() => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } })());
  const saveSettings = () => { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); };

  // 이미 켜져 있을 때 또 열면(바로가기·vbs) 그 창을 앞으로. whenReady 전에도 불릴 수 있어서 start() 안에 둠
  function showWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* 트레이에 남음 */ });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    const node = findNode();
    const sup = new Supervisor({ root: ROOT, nodeCmd: node.cmd, nodeEnv: node.env, startGapMs: TEST ? 0 : 2500 });
    // 토큰은 봇들과 같은 파일을 같이 써요(토스는 새로 발급하면 예전 토큰을 끊어서)
    const toss = new TossReader({ envFile: path.resolve(ROOT, '..', 'toss-mcp', '.env'), tokenFile: path.join(ROOT, 'orb', '.toss-token.json') });
    const icoFile = path.join(app.getPath('userData'), 'tossbot.ico');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    try { fs.writeFileSync(icoFile, icons.icoBuffer(nativeImage)); } catch (e) { console.error('icon', e.message); }

    // ---------- 바로가기 · 자동 시작 ----------
    function makeShortcuts() {
      if (process.platform !== 'win32') return [];
      const opts = { target: process.execPath, description: '토스 봇 — 자동매매 봇 상태 화면', icon: icoFile, iconIndex: 0, appUserModelId: APP_ID };
      const spots = [path.join(app.getPath('desktop'), '토스 봇.lnk'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '토스 봇.lnk')];
      return spots.filter(p => { try { return shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', opts); } catch { return false; } });
    }
    function applyLoginStart() {
      if (process.platform !== 'win32' || TEST) return;
      app.setLoginItemSettings({ openAtLogin: !!settings.loginStart, path: process.execPath, args: ['--hidden'] });
    }
    if (!settings.shortcutsMade && !TEST) { makeShortcuts(); settings.shortcutsMade = true; saveSettings(); }
    applyLoginStart(); // 매번 다시 등록 → 폴더를 옮겨도 새 위치로

    // ---------- 창 ----------
    // 노트북 배율(125~150%)에서도 창이 화면 밖으로 안 나가게 작업 영역에 맞춤
    const work = (() => { try { return screen.getPrimaryDisplay().workAreaSize; } catch { return { width: 1440, height: 900 }; } })();
    win = new BrowserWindow({
      width: Math.min(1480, Math.round(work.width * 0.94)), height: Math.min(940, Math.round(work.height * 0.94)), minWidth: 860, minHeight: 560, show: false, title: '토스 봇',
      icon: icons.image(nativeImage, 'live', 64, 1), backgroundColor: '#0e1728', // 화면은 밤 색 하나 (ui/style.css)
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.once('ready-to-show', () => { if (!HIDDEN && !TEST) showWindow(); });
    win.on('show', () => { void refreshAccount(); });
    win.on('close', e => {
      if (quitting) return;
      e.preventDefault(); win.hide();
      if (!settings.trayHint) { settings.trayHint = true; saveSettings(); balloon('토스 봇은 계속 돌고 있어요', '봇은 작업 표시줄 오른쪽 트레이에서 계속 돌아요. 완전히 끄려면 트레이 아이콘을 오른쪽 클릭 → 종료.'); }
    });
    win.on('query-session-end', () => { quitting = true; });
    win.on('session-end', () => { quitting = true; });


    // ---------- 알림 (트레이 풍선: 시작 메뉴 등록 없이도 Windows 알림으로 떠요) ----------
    let lastBalloon = 0, pending = [];
    function balloon(title, content, warn = false) {
      if (TEST || !tray) return;
      tray.displayBalloon({ title, content: content.slice(0, 250), iconType: warn ? 'warning' : 'info' });
      lastBalloon = Date.now();
    }
    function notifyLater(title, content, warn) {
      if (!settings.notify) return;
      pending.push({ title, content, warn });
      setTimeout(() => {
        if (!pending.length || Date.now() - lastBalloon < 3500) return;
        const list = pending; pending = [];
        if (list.length === 1) balloon(list[0].title, list[0].content, list[0].warn);
        else balloon(`토스 봇 알림 ${list.length}건`, list.map(x => `${x.title}: ${x.content}`).join('\n'), list.some(x => x.warn));
      }, 1500);
    }
    const IMPORTANT = /매수 체결|청산\(|매도 시작|매도 \d+\/\d+주|매도 실패|주문 실패|⚠|새 주문 멈춤|오류로|멈췄어요|못 팔았|못 판/;
    const nameOf = key => sup.status().find(b => b.key === key)?.name || key;
    sup.on('line', (key, line, kind) => {
      if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('line', key, line, kind);
      const msg = line.replace(/^\[[^\]\d][^\]]*\]\s*/, '').replace(/^\[\d\d-\d\d [\d:]+\]\s*/, '');
      if (kind === 'out' && IMPORTANT.test(msg) && !/^시작 —/.test(msg)) notifyLater(nameOf(key), msg, /⚠|실패|멈춤|오류|멈췄|못 /.test(msg));
    });
    sup.on('crash', (key, code) => notifyLater(nameOf(key), `봇이 멈췄어요(코드 ${code ?? '?'}) — 1분 뒤 다시 켜요`, true));
    sup.on('gave-up', key => notifyLater(nameOf(key), '1시간에 5번 넘게 멈춰서 다시 안 켰어요 — 화면에서 기록을 확인해 주세요', true));

    // ---------- 트레이 ----------
    const MODE = { live: '실전', paper: '연습', off: '끔' };
    const STATE = { running: '돌고 있음', waiting: '멈춤 → 곧 다시 켬', 'gave-up': '멈춤', external: '다른 창에서 실행 중', stopped: '꺼짐', off: '꺼 둠' };
    function updateTray() {
      const bots = sup.status();
      const color = bots.some(b => b.state === 'gave-up' || b.state === 'waiting') ? 'alert'
        : bots.some(b => b.state === 'running' && b.runMode === 'live') ? 'live'
        : bots.some(b => b.state === 'running') ? 'paper' : 'idle';
      if (!tray) {
        tray = new Tray(icons.image(nativeImage, color));
        tray.on('click', showWindow);
        tray.on('balloon-click', showWindow);
      } else if (color !== trayColor) tray.setImage(icons.image(nativeImage, color));
      trayColor = color;
      const tip = '토스 봇\n' + bots.map(b => `${b.name}: ${b.mode === 'off' ? '꺼 둠' : `${MODE[b.mode]} · ${STATE[b.state] || b.state}`}`).join('\n');
      tray.setToolTip(tip.slice(0, 127));
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '토스 봇 열기', click: showWindow },
        { type: 'separator' },
        ...bots.map(b => ({ label: `${b.name} — ${b.mode === 'off' ? '꺼 둠' : `${MODE[b.mode]}, ${STATE[b.state] || b.state}`}`, enabled: false })),
        { type: 'separator' },
        { label: '종료 (봇 모두 끄기)', click: () => void confirmQuit() },
      ]));
      // 봇이 하나라도 돌면 PC가 잠들지 않게 (화면은 꺼져도 됨)
      const anyRunning = bots.some(b => b.state === 'running' || b.state === 'waiting');
      if (anyRunning && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!anyRunning && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    }
    let pushTimer = null;
    const pushChanged = () => {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { updateTray(); if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('changed'); }, 150);
    };
    sup.on('change', pushChanged);
    sup.on('tick', pushChanged);

    // ---------- 계좌 · 장 시간 ----------
    async function refreshAccount() {
      if (account.busy) return account;
      account.busy = true;
      try { account = { data: await toss.account(), error: null, at: Date.now(), busy: false }; }
      catch (e) { account = { data: account.data, error: e.message, at: Date.now(), busy: false }; }
      if (win && !win.isDestroyed()) win.webContents.send('changed');
      return account;
    }
    async function marketInfo() {
      if (market && Date.now() - marketAt < 30_000) return market;
      market = await marketNow(Date.now(), date => toss.calendarDay(date, etToMs).catch(() => null));
      marketAt = Date.now();
      return market;
    }
    setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) void refreshAccount(); }, 60_000);
    setInterval(pushChanged, 30_000);

    // ---------- 화면 ↔ 앱 ----------
    function handle(channel, fn) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!win || event.sender !== win.webContents) throw Error('허용하지 않는 요청이에요');
        return fn(...args);
      });
    }
    const parent = () => (win && !win.isDestroyed() && win.isVisible() ? win : undefined);
    async function ask(message, detail, ok = '네', type = 'warning') {
      const opts = { type, buttons: [ok, '취소'], defaultId: 1, cancelId: 1, title: '토스 봇', message, detail, noLink: true };
      const r = parent() ? await dialog.showMessageBox(parent(), opts) : await dialog.showMessageBox(opts);
      return r.response === 0;
    }
    const botOf = key => { const b = sup.status().find(x => x.key === key); if (!b) throw Error('없는 봇이에요'); return b; };
    // 지금 끄거나 다시 켜면 위험한 경우 (봇이 들고 있는 주식·걸어 둔 주문, 애프터장 도중)
    async function riskNote(b) {
      const s = readStats(ROOT).bots[b.key]?.live, notes = [];
      const legs = b.runMode === 'live' ? s?.legs ?? [] : [], held = legs.filter(g => g.st === 'hold'), wait = legs.filter(g => g.st === 'buy');
      if (held.length) notes.push(`지금 ${held.map(g => `${g.sym} ${g.qty}주`).join(', ')}를 들고 있어요. 꺼져 있는 동안은 -20% 손절 감시가 멈춰요(+10% 목표 매도 주문은 토스에 걸려 있어요). 다시 켜면 이어서 관리해요.`);
      if (wait.length) notes.push(`매수 주문 ${wait.map(g => `${g.sym} $${g.level}`).join(', ')}이 걸려 있어요. 다시 켜면 이어서 관리해요.`);
      if (b.key === 'ah' && b.runMode === 'live') { const m = await marketInfo(); if (m.phase === 'after') notes.push('애프터장 도중이에요. 애프터장 봇은 다시 켜도 오늘 넣은 주문을 이어서 관리하지 못해요 — 남은 주문·보유는 토스 앱에서 직접 확인해야 해요.'); }
      return notes.join('\n\n');
    }

    handle('snapshot', async () => ({
      now: Date.now(), bots: sup.status(), stats: readStats(ROOT), market: await marketInfo(),
      account: { data: account.data, error: account.error, at: account.at, busy: account.busy },
      settings: { loginStart: settings.loginStart, notify: settings.notify }, node: node.label, root: ROOT, version: app.getVersion(),
    }));
    handle('log', key => {
      const b = botOf(key), modes = sup.readModes();
      const mode = modes[key] !== 'off' ? modes[key] : (fs.existsSync(sup.dataDir(key, 'live')) ? 'live' : 'paper');
      return { key, mode, file: path.join(sup.dataDir(key, mode), 'events.log'), lines: tail(path.join(sup.dataDir(key, mode), 'events.log'), 400), err: b.err };
    });
    handle('setMode', async (key, mode) => {
      const b = botOf(key), L = readStats(ROOT).limits;
      if (mode === b.mode) return true;
      if (mode === 'live') {
        const lim = `손실 한도(갭·애프터장 합계): 하루 $${L?.dailyLossLimitUsd}, 누적 $${L?.totalLossLimitUsd} (orb\\live.json)`;
        const extra = key === 'gap' ? `\n\n갭 큰 ${L?.gapSlots ?? 5}종목까지 ${L?.perTradeUsd === 'all' ? '주문 가능 달러 현금을 나눠' : `$${L?.perTradeUsd}씩`} 동시에 사요.\n${lim}`
          : key === 'ah' ? `\n\n애프터장 실전은 토스 API 주문이 애프터장에 실제로 들어가는지 확인(orb_paper.mjs --test-order) 뒤에 켜는 게 좋아요. 돈은 주문 가능 달러 현금을 최대 5종목에 나눠 써요.\n${lim}`
          : '\n\n봇이 사지 않은 미국 보유 주식도 +10% / -20%에 실제로 팔아요(한국 주식·orb\\hold_skip.txt 종목 제외).';
        if (!await ask(`${b.name}을(를) 실전으로 바꿀까요?`, `토스에 실제 주문이 나가요.${extra}`, '실전으로 바꾸기')) return false;
      } else if (b.runMode === 'live') {
        const note = await riskNote(b);
        if (note && !await ask(`${b.name}을(를) ${mode === 'off' ? '끌' : '연습으로 바꿀'}까요?`, note, mode === 'off' ? '끄기' : '바꾸기')) return false;
      }
      await sup.setMode(key, mode); pushChanged(); return true;
    });
    handle('restart', async key => {
      const b = botOf(key), note = await riskNote(b);
      if (note && !await ask(`${b.name}을(를) 다시 켤까요?`, note, '다시 켜기')) return false;
      await sup.restart(key); pushChanged(); return true;
    });
    handle('takeOver', async key => {
      const b = botOf(key);
      if (!await ask(`다른 창에서 돌고 있는 ${b.name}을(를) 끄고 여기서 켤까요?`, `pid ${b.ext} 봇을 끄고 토스 봇 앱에서 다시 켜요. 그 창(예: 봇켜기.cmd 창)을 직접 닫아도 돼요 — 닫으면 여기서 저절로 켜요.`, '끄고 여기서 켜기')) return false;
      await sup.takeOver(key); pushChanged(); return true;
    });
    handle('setFlag', async (name, on) => {
      if (name === 'FLATTEN_GAP' && on && !await ask('봇이 산 주식을 지금 다 팔까요?', '갭 봇과 애프터장 봇이 지금 들고 있는 주식(봇이 산 것만)을 바로 팔고, 이 스위치를 끌 때까지 새로 사지 않아요. 봇이 꺼져 있으면 아무 일도 안 일어나요.', '다 팔기', 'warning')) return false;
      setFlag(ROOT, name, on); pushChanged(); return true;
    });
    handle('refreshAccount', () => refreshAccount().then(() => true));
    handle('setSetting', (key, value) => {
      if (!['loginStart', 'notify'].includes(key)) throw Error('없는 설정이에요');
      settings[key] = !!value; saveSettings();
      if (key === 'loginStart') applyLoginStart();
      return true;
    });
    handle('makeShortcuts', () => makeShortcuts().length);
    handle('openPath', what => {
      const [kind, key] = String(what).split(':');
      if (kind === 'project') return shell.openPath(ROOT);
      const b = botOf(key), modes = sup.readModes(), mode = modes[key] !== 'off' ? modes[key] : 'live', dir = sup.dataDir(b.key, mode);
      if (kind === 'data') return shell.openPath(dir);
      if (kind === 'trades') return shell.openPath(fs.existsSync(path.join(dir, 'trades.csv')) ? path.join(dir, 'trades.csv') : dir);
      throw Error('열 수 없는 위치예요');
    });
    handle('quit', () => confirmQuit());

    // ---------- 종료 ----------
    async function confirmQuit() {
      const running = sup.status().filter(b => b.state === 'running' || b.state === 'waiting');
      if (running.length && !await ask('토스 봇을 끌까요?', `돌고 있는 봇(${running.map(b => b.name).join(', ')})도 같이 꺼져요. 다시 켜려면 바탕화면이나 시작 메뉴의 "토스 봇"을 여세요.`, '끄기')) return false;
      quitting = true; app.quit(); return true;
    }
    app.on('before-quit', e => {
      quitting = true;
      if (stopped) return;
      e.preventDefault();
      sup.stopAll().finally(() => { stopped = true; if (blocker !== null) powerSaveBlocker.stop(blocker); tray?.destroy(); tray = null; app.quit(); });
    });

    updateTray();
    sup.startAll();
    updateTray();
    await win.loadFile(path.join(__dirname, 'ui', 'index.html')); // 화면 요청 처리(handle)를 다 등록한 뒤에 화면을 열어요
    // 화면 파일(ui/)을 고치면 앱을 다시 켜지 않아도 창이 새로 고쳐짐 (봇은 그대로)
    let reloadT = null;
    try { fs.watch(path.join(__dirname, 'ui'), () => { clearTimeout(reloadT); reloadT = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); }, 400); }); } catch { /* 감시 못 하면 다시 켤 때 반영 */ }
    if (TEST) globalThis.__tossBot = { sup, win, settings, refreshAccount, marketInfo, ipcMain };
  }).catch(e => { console.error(e); dialog.showErrorBox('토스 봇', `시작하지 못했어요: ${e.message}`); app.exit(1); });
}
