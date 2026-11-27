'use strict';
// 봇 세 개(갭 봇 · 보유 주식 관리 · 애프터장)를 자식 프로세스로 켜고, 멈추면 다시 켜고, 출력을 모아요.
// Electron 없이 node로도 돌아서(test/supervisor.test.cjs) 가상 봇으로 시험할 수 있어요.
// 켜고 끄는 건 orb/modes.json(live=실전, paper=연습, off=끔) — run_all.ps1과 같은 파일이에요.
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const BOTS = [
  { key: 'gap', name: '갭 봇', arg: null, stopFile: 'STOP_GAP', when: '정규장',
    desc: '시가가 전일 종가보다 15%↑ 뜬 $1~3 종목 중 갭 큰 5개에 현금을 나눠 시가 -5%에 지정가, +10% 익절, -20% 손절, 마감 전 정리' },
  { key: 'hold', name: '보유 주식 관리', arg: '--hold', stopFile: 'STOP_HOLD', when: '정규장',
    desc: '봇이 사지 않은 미국 주식을 평균 매입가 대비 +10%↑ 또는 -20%↓이면 매도 (종목당 하루 한 번)' },
  { key: 'ah', name: '애프터장', arg: '--ah', stopFile: 'STOP_AH', when: '애프터장',
    desc: '정규장 종가가 15%↑ 오른 $1~20 종목을 종가 -10%에 사서 +10% 익절 · -20% 손절 · 19:50 정리' },
  { key: 'pre', name: '프리장 연습', arg: '--pre', stopFile: 'STOP_PRE', when: '프리장', paperOnly: true, // 주문 코드 없음 (기록 모으기용, 2026-11-27)
    desc: '프리장에 전 정규장 종가보다 15%↑ 오른 $1~20 종목을 그 가격 -5%에 가상으로 사서 +10% / -20% / 9:25 정리 — 주문 없이 기록만' },
];
const MODES = ['live', 'paper', 'off'];
const HOUR = 3_600_000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 다른 창의 봇을 끄기 전에, 그 번호가 정말 node(봇)인지 확인해요. 꺼진 봇의 번호를 다른 프로그램이 물려받았을 수 있어서.
function processName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = out.match(/^"([^"]+)"/m); return m ? m[1] : '';
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}
const isBotProcess = pid => /^(node|node\.exe|TossBot\.exe)$/i.test(path.basename(processName(pid)));

function eachLine(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l) fn(l); } });
  stream.on('end', () => { if (buf.trim()) fn(buf.replace(/\r$/, '')); buf = ''; });
}

class Supervisor extends EventEmitter {
  constructor(o) {
    super();
    this.root = o.root;
    this.orb = path.join(o.root, 'orb');
    this.nodeCmd = o.nodeCmd;
    this.nodeEnv = o.nodeEnv || {};
    this.script = o.script || 'orb/gap_dip.mjs';
    this.extraArgs = o.extraArgs || [];
    this.restartDelayMs = o.restartDelayMs ?? 60_000;
    this.maxPerHour = o.maxRestartsPerHour ?? 5;
    this.isBot = o.isBotProcess || isBotProcess;
    this.startGapMs = o.startGapMs ?? 0; // 봇을 한꺼번에 켜지 않고 띄워서 (토큰 발급이 겹치지 않게)
    this.bots = new Map(BOTS.map(d => [d.key, { ...d, child: null, state: 'off', pid: null, since: null, starts: [], timer: null, retryAt: null,
      wanted: false, stopping: false, mode: null, lastExit: null, err: [], waiters: [] }]));
    this.poll = setInterval(() => this.pollExternal(), o.externalPollMs ?? 15_000);
    this.poll.unref?.();
  }
  get modesFile() { return path.join(this.orb, 'modes.json'); }
  readModes() {
    const m = readJson(this.modesFile, {}), out = {};
    for (const b of BOTS) out[b.key] = MODES.includes(m[b.key]) ? m[b.key] : 'off';
    return out;
  }
  writeModes(next) {
    const cur = readJson(this.modesFile, {});
    const merged = { ...cur, ...next };
    fs.writeFileSync(this.modesFile + '.tmp', JSON.stringify(merged, null, 2) + '\r\n');
    fs.renameSync(this.modesFile + '.tmp', this.modesFile);
  }
  dataDir(key, mode) { return path.join(this.orb, `data-${key}${mode === 'live' ? '-live' : ''}`); }
  argsFor(key, mode) {
    const b = this.bots.get(key);
    return [this.script, ...(b.arg ? [b.arg] : []), ...(mode === 'live' ? ['--live'] : []), ...this.extraArgs];
  }
  // 그 모드의 봇이 다른 창에서 돌고 있으면 그 번호 (봇이 기록 폴더에 running.pid를 남겨요)
  lockPid(key, mode) {
    if (!mode || mode === 'off') return null;
    try { const pid = Number(fs.readFileSync(path.join(this.dataDir(key, mode), 'running.pid'), 'utf8')); return alive(pid) ? pid : null; } catch { return null; }
  }
  set(b, state) { b.state = state; this.emit('change', b.key); }

  start(key) {
    const b = this.bots.get(key), mode = this.readModes()[key];
    if (mode === 'off') { b.wanted = false; if (!b.child) this.set(b, 'off'); return false; }
    b.wanted = true;
    if (b.child) return true;
    clearTimeout(b.timer); b.timer = null; b.retryAt = null;
    b.mode = mode; b.stopping = false; b.err = [];
    let child;
    try {
      child = spawn(this.nodeCmd, this.argsFor(key, mode), { cwd: this.root, windowsHide: true, env: { ...process.env, ...this.nodeEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { this.exited(b, null, null, null, e.message); return false; }
    b.child = child; b.pid = child.pid ?? null; b.since = Date.now(); b.starts.push(Date.now());
    b.starts = b.starts.filter(t => t > Date.now() - HOUR);
    eachLine(child.stdout, l => this.emit('line', key, l, 'out'));
    eachLine(child.stderr, l => { b.err.push(l); if (b.err.length > 80) b.err.shift(); this.emit('line', key, l, 'err'); });
    child.on('error', e => { b.err.push(`실행 실패: ${e.message}`); if (!child.pid) this.exited(b, child, null, null, e.message); });
    child.on('exit', (code, signal) => this.exited(b, child, code, signal));
    this.set(b, 'running');
    return true;
  }
  exited(b, child, code, signal, msg) {
    if (child && b.child !== child) return;
    b.child = null; b.pid = null;
    b.lastExit = { code, signal, at: Date.now(), msg: msg || null };
    const waiters = b.waiters; b.waiters = []; waiters.forEach(fn => fn());
    if (b.stopping || !b.wanted) { b.stopping = false; this.set(b, b.wanted ? 'stopped' : 'off'); return; }
    if (code === 3) { this.set(b, 'external'); return; } // 같은 봇이 다른 창에서 돌고 있음 → 그게 꺼지면 pollExternal이 여기서 켬
    const recent = b.starts.filter(t => t > Date.now() - HOUR);
    if (recent.length >= this.maxPerHour) { this.set(b, 'gave-up'); this.emit('gave-up', b.key, b.err.slice(-6)); return; }
    b.retryAt = Date.now() + this.restartDelayMs;
    b.timer = setTimeout(() => { b.timer = null; b.retryAt = null; if (b.wanted) this.start(b.key); }, this.restartDelayMs);
    this.set(b, 'waiting');
    this.emit('crash', b.key, code, b.err.slice(-6));
  }
  stop(key) {
    const b = this.bots.get(key);
    clearTimeout(b.timer); b.timer = null; b.retryAt = null;
    if (!b.child) { this.set(b, b.wanted ? 'stopped' : 'off'); return Promise.resolve(); }
    return new Promise(resolve => {
      b.waiters.push(resolve);
      b.stopping = true;
      try { b.child.kill(); } catch { /* 이미 꺼짐 */ }
    });
  }
  async restart(key) {
    const b = this.bots.get(key);
    b.wanted = true;
    await this.stop(key);
    b.starts = []; // 직접 다시 켠 건 '1시간에 5번' 횟수에서 뺌
    return this.start(key);
  }
  async setMode(key, mode) {
    if (!this.bots.has(key)) throw Error('없는 봇이에요: ' + key);
    if (!MODES.includes(mode)) throw Error('모드는 live/paper/off 중 하나예요');
    const b = this.bots.get(key);
    if (mode === 'live' && b.paperOnly) throw Error(`${b.name}은(는) 연습 전용이에요 (주문 코드 없음)`);
    this.writeModes({ [key]: mode });
    if (mode === 'off') { b.wanted = false; await this.stop(key); return; }
    if (b.child && b.mode !== mode) { await this.stop(key); }
    b.starts = [];
    this.start(key);
  }
  startAll() {
    if (!this.startGapMs) { for (const b of BOTS) this.start(b.key); return; }
    BOTS.forEach((b, i) => { if (i === 0) this.start(b.key); else setTimeout(() => { if (!this.closed) this.start(b.key); }, i * this.startGapMs); });
  }
  async stopAll(timeoutMs = 5000) {
    this.closed = true; clearInterval(this.poll);
    const jobs = [...this.bots.values()].map(b => { b.wanted = false; return this.stop(b.key); });
    await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, timeoutMs))]);
  }
  pollExternal() {
    for (const b of this.bots.values()) {
      if (b.state === 'external' && b.wanted && !this.lockPid(b.key, b.mode)) { b.starts = []; this.start(b.key); }
    }
    this.emit('tick');
  }
  // 다른 창에서 도는 같은 봇을 끄고 여기서 켬. 그 번호가 node가 아니면 안 끔
  async takeOver(key) {
    const b = this.bots.get(key), mode = this.readModes()[key], pid = this.lockPid(key, mode);
    if (pid) {
      if (!this.isBot(pid)) throw Error(`기록에 남은 번호(pid ${pid})가 지금은 봇이 아닌 다른 프로그램이라 안 껐어요. running.pid 파일이 오래된 것 같아요`);
      try { process.kill(pid); } catch (e) { throw Error(`다른 창의 봇(pid ${pid})을 못 껐어요: ${e.message}`); }
      for (let i = 0; i < 25 && alive(pid); i++) await new Promise(r => setTimeout(r, 200));
      if (alive(pid)) throw Error(`다른 창의 봇(pid ${pid})이 아직 안 꺼졌어요`);
    }
    b.starts = [];
    return this.start(key);
  }
  status() {
    const modes = this.readModes();
    return BOTS.map(d => {
      const b = this.bots.get(d.key), mode = modes[d.key];
      return {
        key: d.key, name: d.name, desc: d.desc, when: d.when, stopFile: d.stopFile, paperOnly: !!d.paperOnly, mode,
        runMode: b.child ? b.mode : null, state: b.state, pid: b.pid, since: b.child ? b.since : null,
        retryAt: b.retryAt, restarts: Math.max(0, b.starts.filter(t => t > Date.now() - HOUR).length - 1),
        lastExit: b.lastExit, err: b.err.slice(-8), ext: b.child ? null : this.lockPid(d.key, mode),
      };
    });
  }
}

module.exports = { Supervisor, BOTS, MODES, alive, readJson, isBotProcess };
