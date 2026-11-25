'use strict';
// 토스 봇 화면. 데이터는 window.api(preload.cjs)로만 받아요.
const API = window.api; // 'api'라고 이름 지으면 contextBridge가 만든 window.api와 겹쳐 스크립트가 안 돌아요
const $ = id => document.getElementById(id);
const HOUR = 3_600_000, MIN = 60_000;
let snap = null, logKey = 'trades', busy = false;
const shown = new Map();
const put = (el, html) => { if (shown.get(el) !== html) { el.innerHTML = html; shown.set(el, html); } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 숫자·시간 ----------
const hm = ms => new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
const md = ms => new Date(ms).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short' });
function dur(ms) {
  if (!(ms > 0)) return '곧';
  const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / MIN);
  if (h >= 24) return `${Math.floor(h / 24)}일 ${h % 24}시간`;
  if (h) return m ? `${h}시간 ${m}분` : `${h}시간`;
  return m ? `${m}분` : '1분 안';
}
const signCls = v => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'flat');
function usd(v, { sign = true } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const s = Math.abs(v).toFixed(2);
  return sign ? (v > 0.004 ? `+$${s}` : v < -0.004 ? `−$${s}` : `$${s}`) : `$${s}`;
}
const money = v => `<span class="${signCls(v)}">${usd(v)}</span>`;
const px = v => (!Number.isFinite(v) ? '–' : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const krw = v => (!Number.isFinite(v) ? '–' : `${Math.round(v).toLocaleString('ko-KR')}원`);
const pctTxt = r => (!Number.isFinite(r) ? '–' : `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%`);
const MODE = { live: '실전', paper: '연습', off: '끔' };
const SHORT = { gap: '갭', hold: '보유', ah: '애프터' };
function kstOf(date, t) { // trades.csv의 'MM-DD HH:MM:SS'(KST) → ms
  const m = /^(\d\d)-(\d\d) (\d\d:\d\d(?::\d\d)?)/.exec(t || ''); if (!m || !date) return NaN;
  let y = Number(date.slice(0, 4)); if (m[1] === '01' && date.slice(5, 7) === '12') y++;
  return Date.parse(`${y}-${m[1]}-${m[2]}T${m[3].length === 5 ? m[3] + ':00' : m[3]}+09:00`);
}

// ---------- 머리 ----------
function brandColor() {
  const b = snap.bots;
  if (b.some(x => x.state === 'gave-up' || x.state === 'waiting')) return 'alert';
  if (b.some(x => x.state === 'running' && x.runMode === 'live')) return '';
  if (b.some(x => x.state === 'running')) return 'paper';
  return 'idle';
}
function renderTop() {
  const m = snap.market, now = snap.now;
  document.querySelector('.mark').className = 'mark ' + brandColor();
  put($('now'), (() => {
    if (!m) return '<span class="muted">장 시간을 확인하는 중…</span>';
    const at = m.next?.at, when = at ? hm(at) : '', left = at ? dur(at - now) : '';
    const day = at && md(at) !== md(now) ? ` (${md(at)})` : '';
    const guess = m.source === 'guess' ? ' <span class="muted" title="토스 장 달력을 못 읽어서 평일 규칙으로 계산했어요">· 휴장일 확인 못 함</span>' : '';
    if (m.phase === 'regular') return `<span class="phase regular">정규장</span><span>${when} 마감까지 <b>${left}</b></span>`;
    if (m.phase === 'after') return `<span class="phase after">애프터장</span><span>${when} 끝까지 <b>${left}</b></span>`;
    if (m.phase === 'pre') return `<span class="phase pre">프리장</span><span>정규장 ${when} 시작까지 <b>${left}</b></span>`;
    return `<span class="phase">${m.holiday ? '미국 휴장일' : '장 닫힘'}</span><span>정규장 ${when}${day} 시작까지 <b>${left}</b>${guess}</span>`;
  })());
  const a = snap.account?.data;
  put($('cash'), a ? `<span class="l">주문 가능 달러</span><span class="v">${usd(a.cashUsd, { sign: false })}</span>` : '');
}

// ---------- 하루 띠 ----------
function renderStrip() {
  const m = snap.market, s = m?.session, el = $('strip');
  if (!s) { put(el, ''); return; }
  const close = s.close || s.open + 6.5 * HOUR, F0 = s.open - 6 * HOUR, F1 = close + 4.5 * HOUR, now = snap.now;
  const x = t => `${(Math.max(0, Math.min(1, (t - F0) / (F1 - F0))) * 100).toFixed(3)}%`;
  const w = (a, b) => `${(Math.max(0, (Math.min(b, F1) - Math.max(a, F0)) / (F1 - F0)) * 100).toFixed(3)}%`;
  const band = (cls, a, b, label) => `<div class="band ${cls}" style="left:${x(a)};width:${w(a, b)}">${label}</div>`;
  let h = '<div class="track">';
  h += band('pre', s.open - 5.5 * HOUR, s.open, '프리장');
  h += band('reg', s.open, close, `정규장<small>${hm(s.open)}–${hm(close)}</small>`);
  h += band('after', close, close + 4 * HOUR, `애프터장<small>${hm(close)}–${hm(close + 4 * HOUR)}</small>`);
  h += '<div class="ticks">';
  for (let t = Math.ceil(F0 / HOUR) * HOUR; t <= F1; t += HOUR) if (Number(hm(t).slice(0, 2)) % 2 === 0) h += `<span class="tick" style="left:${x(t)}">${hm(t)}</span>`;
  h += '</div>';
  if (now >= F0 && now <= F1) h += `<div class="nowline${(now - F0) / (F1 - F0) > 0.82 ? ' end' : ''}" style="left:${x(now)}"><span>지금 ${hm(now)}</span></div>`;
  else if (now < F0) h += `<div class="offframe">지금 ${hm(now)} ▸</div>`;
  put(el, h + '</div>');
}

// ---------- 봇 카드 ----------
// 봇이 일하는 때 (그 세션의 한국 시각)
function workTime(b) {
  const s = snap.market?.session; if (!s) return '';
  const close = s.close || s.open + 6.5 * HOUR;
  const [a, z, what] = { gap: [s.open, close - 2 * MIN, '정규장'], hold: [s.open + MIN, close, '정규장'], ah: [close, close + 230 * MIN, '애프터장'] }[b.key];
  return `${what} ${hm(a)}–${hm(z)}에 일해요`;
}
function summaryFor(b) {
  const st = snap.stats.bots[b.key] || {};
  return b.mode === 'paper' ? st.paper : b.mode === 'live' ? st.live : (st.live || st.paper);
}
function statusHtml(b) {
  const now = snap.now, ex = b.lastExit;
  const btn = (act, label) => `<button class="btn strong" data-act="${act}" data-key="${b.key}">${label}</button>`;
  switch (b.state) {
    case 'running': return `<span class="pill running">돌고 있음</span><span class="sub">${dur(now - b.since)}째${b.restarts ? `, 1시간 동안 ${b.restarts}번 다시 켬` : ''}</span>`;
    case 'waiting': return `<span class="pill waiting">멈춤</span><span class="sub">${Math.max(0, Math.round((b.retryAt - now) / 1000))}초 뒤 다시 켜요 (코드 ${ex?.code ?? '?'})</span>`;
    case 'gave-up': return `<span class="pill gave-up">멈춤</span><span class="sub">여러 번 멈춰서 쉬는 중</span>${btn('restart', '다시 켜기')}`;
    case 'external': return `<span class="pill external">다른 창에서 실행 중</span>${btn('takeover', '여기서 켜기')}`;
    case 'stopped': return `<span class="pill">꺼짐</span>${btn('restart', '켜기')}`;
    default: return `<span class="pill">꺼 둠</span>${b.ext ? '<span class="sub">다른 창에서 돌고 있어요</span>' : ''}`;
  }
}
function doingHtml(s) {
  const m = /^\[(\d\d-\d\d) ([\d:]{5})[\d:]*\]\s?(.*)$/.exec(s?.lastLine || '');
  if (!m) return '<p class="doing muted">아직 기록이 없어요</p>';
  return `<p class="doing" title="${esc(m[3])}"><time>${m[2]}</time>${esc(m[3])}</p>`;
}
const fig = (label, value, small) => `<div class="fig"><span>${label}</span><b${small ? ' class="small"' : ''}>${value}</b></div>`;
function figsHtml(b, s) {
  if (!s) return `<div class="figs">${fig('기록', '<span class="muted">아직 없음</span>', true)}</div>`;
  const L = snap.stats.limits, which = s.mode === 'live' ? '실전' : '연습', day = s.latestDate ? ` (${Number(s.latestDate.slice(5, 7))}/${Number(s.latestDate.slice(8))})` : '';
  if (b.key === 'hold') // 원래 갖고 있던 주식을 정리한 결과라 '봇이 번 돈'이 아님
    return `<div class="figs">${fig(`${which} 최근 매도${day}`, s.latestDate ? `${s.latestEntries}건` : '–', true)}${fig('평균 매입가 대비', s.cum == null ? '–' : money(s.cum), true)}</div><p class="note">원래 갖고 있던 주식을 정리한 결과라 봇이 번 돈은 아니에요</p>`;
  let h = `<div class="figs">${fig(`${which} 누적 손익`, s.cum == null ? '–' : money(s.cum))}${fig(`최근 거래일${day}`, s.latestDate ? money(s.latestPnl ?? 0) : '–')}${fig('거래', `${s.count}건`, true)}</div>`;
  if (s.mode === 'live' && L && typeof s.cum === 'number') {
    const used = Math.max(0, -s.cum), lim = Number(L.totalLossLimitUsd) || 0, r = lim ? Math.min(1, used / lim) : 0;
    h += `<div class="limit" title="하루 손실 한도 $${L.dailyLossLimitUsd} (orb\\live.json)"><div class="bar"><i class="${r >= 0.7 ? 'near' : ''}" style="width:${(r * 100).toFixed(1)}%"></i></div><p>누적 손실 ${usd(used, { sign: false })} / 한도 $${lim}${b.key === 'ah' ? ' (애프터장 따로)' : ''} — 넘으면 새로 안 사요</p></div>`;
  }
  return h;
}
function renderBots() {
  const flags = snap.stats.flags;
  put($('bots'), snap.bots.map(b => {
    const s = summaryFor(b), on = !!flags[b.stopFile];
    const pos = s?.mode === 'live' && s.pos ? `<p class="pos">보유 중 ${esc(s.pos.sym)} ${s.pos.qty}주 ${px(s.pos.px)} · 목표 ${px(s.pos.target)} · 손절 ${px(s.pos.stop)}</p>`
      : s?.mode === 'live' && s.buy ? `<p class="pos">매수 주문 중 ${esc(s.buy.sym)} ${s.buy.qty}주 ${px(s.buy.level)}</p>` : '';
    return `<article class="card${b.mode === 'off' ? ' off' : ''}" data-bot="${b.key}">
      <div class="card-head"><div><h3 title="${esc(b.desc)}">${esc(b.name)}</h3><p class="when">${workTime(b)}</p></div>
        <div class="mode" role="group" aria-label="${esc(b.name)} 모드">${['live', 'paper', 'off'].map(m => `<button class="${m}" aria-pressed="${b.mode === m}" data-act="mode" data-key="${b.key}" data-mode="${m}">${MODE[m]}</button>`).join('')}</div></div>
      <div class="status">${statusHtml(b)}</div>
      ${doingHtml(s)}
      ${figsHtml(b, s)}${pos}
      <div class="card-foot">
        <label class="toggle${on ? ' on' : ''}" title="orb\\${b.stopFile} 파일"><input type="checkbox" data-act="flag" data-name="${b.stopFile}" ${on ? 'checked' : ''}><span>${b.key === 'hold' ? '팔지 않기' : '새로 사지 않기'}</span></label>
        ${b.state === 'running' ? `<button class="btn" data-act="restart" data-key="${b.key}">다시 켜기</button>` : ''}
        <button class="btn" data-act="log" data-key="${b.key}">기록</button>
      </div>
    </article>`;
  }).join(''));
}

// ---------- 보유 주식 ----------
function renderAccount() {
  const A = snap.account, a = A?.data, el = $('account');
  $('acct-refresh').textContent = A?.busy ? '불러오는 중…' : '새로고침';
  $('acct-meta').textContent = a ? `${hm(a.at)} 기준` : '';
  if (!a) { put(el, A?.error ? `<p class="err">계좌를 못 읽었어요: ${esc(A.error)}</p><p class="muted">토스 키 파일(toss-mcp\\.env)과 인터넷 연결을 확인한 뒤 새로고침을 눌러 주세요.</p>` : '<p class="empty">계좌를 불러오는 중…</p>'); return; }
  const holdOn = snap.bots.find(b => b.key === 'hold')?.mode !== 'off', skip = new Set(snap.stats.holdSkip || []);
  const botPos = new Set(Object.values(snap.stats.bots).flatMap(x => [x.live?.pos?.sym, x.live?.buy?.sym]).filter(Boolean));
  let h = `<div class="acct-sum"><div><span>평가금(달러)</span><b>${usd(a.usd.value, { sign: false })}</b></div><div><span>평가 손익</span><b>${money(a.usd.pnl)}</b></div><div><span>오늘</span><b>${money(a.usd.daily)}</b></div></div>`;
  if (A.error) h += `<p class="err">마지막 새로고침 실패: ${esc(A.error)}</p>`;
  if (!a.items.length) h += '<p class="empty">보유 주식이 없어요</p>';
  else {
    h += '<table><thead><tr><th>종목</th><th class="r">수량</th><th class="r">평균 → 지금</th><th class="r">수익률</th></tr></thead><tbody>';
    for (const it of a.items) {
      const kr = it.currency === 'KRW', f = kr ? krw : px;
      let rule = '';
      if (kr || it.country === 'KR') rule = '한국 주식 — 봇이 안 건드려요';
      else if (botPos.has(it.symbol)) rule = '갭·애프터장 봇이 관리 중';
      else if (skip.has(it.symbol)) rule = 'hold_skip.txt — 봇이 안 건드려요';
      else if (holdOn) rule = `${px(it.avg * 1.1)} 넘거나 ${px(it.avg * 0.8)} 밑이면 봇이 팔아요`;
      h += `<tr><td><b>${esc(it.name)}</b><span class="sym">${esc(it.symbol)}</span>${rule ? `<span class="rule">${esc(rule)}</span>` : ''}</td><td class="r">${it.qty}</td><td class="r">${f(it.avg)} → ${f(it.last)}</td><td class="r"><b class="${signCls(it.rate)}">${pctTxt(it.rate)}</b></td></tr>`;
    }
    h += '</tbody></table>';
  }
  put(el, h);
}

// ---------- 최근 거래 / 봇 기록 ----------
// 실전 거래 + 지금 연습 모드인 봇의 연습 거래만 (연습 '팔 것' 기록처럼 손익 없는 줄은 뺌)
const visibleTrades = () => snap.stats.trades.filter(t => (t.mode === 'live' || snap.bots.find(b => b.key === t.bot)?.mode === 'paper') && t.pnl !== null);
function tradesHtml() {
  const list = visibleTrades().slice(0, 40);
  if (!list.length) return '<p class="empty">아직 거래가 없어요</p>';
  let h = '<table><thead><tr><th>날짜</th><th>판 때(한국)</th><th>봇</th><th>종목</th><th>사유</th><th class="r">수익률</th><th class="r">손익</th></tr></thead><tbody>';
  for (const t of list) h += `<tr class="${t.mode}"><td>${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8))}</td><td>${esc((t.time || '').slice(6, 11))}</td><td>${SHORT[t.bot]}${t.mode === 'paper' ? '<span class="tag">연습</span>' : ''}</td><td><b>${esc(t.sym)}</b></td><td>${esc(t.reason)}</td><td class="r">${esc(t.ret)}</td><td class="r"><b>${money(t.pnl)}</b></td></tr>`;
  return h + '</tbody></table>';
}
function renderTabs() {
  const tabs = `<button role="tab" aria-selected="${logKey === 'trades'}" data-act="log" data-key="trades">최근 거래</button>`
    + snap.bots.map(b => `<button role="tab" aria-selected="${b.key === logKey}" data-act="log" data-key="${b.key}">${esc(b.name)} 기록</button>`).join('');
  put($('log-tabs'), tabs + '<span class="file" id="log-file"></span>');
}
async function loadLog() {
  if (!API || !snap) return;
  const box = $('log-body'), err = $('log-err');
  if (logKey === 'trades') { put(box, tradesHtml()); err.hidden = true; const f = $('log-file'); if (f) f.textContent = ''; return; }
  let r; try { r = await API.log(logKey); } catch { return; }
  if (logKey !== r.key) return;
  const wasLog = (shown.get(box) || '').startsWith('<ol'), atEnd = !wasLog || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const html = '<ol class="log-lines">' + (r.lines.map(l => {
    const m = /^\[(\d\d-\d\d [\d:]+)\]\s?(.*)$/.exec(l), t = m ? m[1] : '', msg = m ? m[2] : l;
    const cls = /^===/.test(msg) ? 'day' : /⚠|실패|멈춤|오류|멈췄|못 /.test(msg) && !/^시작 —/.test(msg) ? 'warn' : /매수 체결|청산\(|매도 \d|매도 시작|지정가 매수 주문/.test(msg) ? 'key' : '';
    return `<li class="${cls}"><time>${esc(t)}</time><span>${esc(msg)}</span></li>`;
  }).join('') || '<li><time></time><span class="muted">아직 기록이 없어요</span></li>') + '</ol>';
  put(box, html);
  if (atEnd) box.scrollTop = box.scrollHeight;
  const f = $('log-file'); if (f) f.textContent = `${MODE[r.mode]} 기록 — ${r.file.split(/[\\/]/).slice(-3).join('\\')}`;
  const b = snap.bots.find(x => x.key === logKey);
  if (b && (b.state === 'waiting' || b.state === 'gave-up') && r.err?.length) { err.hidden = false; err.textContent = '마지막 오류 출력\n' + r.err.slice(-8).join('\n'); } else err.hidden = true;
}

// ---------- 바닥 ----------
function renderFoot() {
  $('set-login').checked = !!snap.settings.loginStart;
  $('set-notify').checked = !!snap.settings.notify;
  const fl = $('flag-flatten'); fl.checked = !!snap.stats.flags.FLATTEN_GAP; fl.closest('label').classList.toggle('on', fl.checked);
  $('set-login').closest('label').title = `봇 실행: ${snap.node}`;
}

function render() { if (!snap) return; renderTop(); renderStrip(); renderBots(); renderAccount(); renderTabs(); renderFoot(); if (logKey === 'trades') void loadLog(); }
async function refresh() { if (!API) return; try { snap = await API.snapshot(); render(); } catch (e) { toast(msgOf(e)); } }
const msgOf = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let toastT = null;
function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 5000); }

async function act(fn, done) {
  if (busy) return; busy = true; document.body.style.cursor = 'progress';
  try { const r = await fn(); if (done && r !== false) toast(done); } catch (e) { toast(msgOf(e)); }
  finally { busy = false; document.body.style.cursor = ''; await refresh(); }
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.tagName === 'INPUT') return;
  const { act: a, key, mode, what } = t.dataset;
  if (a === 'mode') { if (snap.bots.find(b => b.key === key)?.mode === mode) return; t.parentElement.querySelectorAll('button').forEach(x => { x.disabled = true; }); act(() => API.setMode(key, mode)); }
  else if (a === 'restart') act(() => API.restart(key), '다시 켰어요');
  else if (a === 'takeover') act(() => API.takeOver(key));
  else if (a === 'log') { logKey = key; renderTabs(); void loadLog().then(() => { if (key !== 'trades') $('log-body').scrollTop = 1e9; }); }
  else if (a === 'open') act(() => API.openPath(what));
  else if (a === 'refresh-account') act(() => API.refreshAccount());
  else if (a === 'shortcuts') act(() => API.makeShortcuts().then(n => { toast(n ? `바로가기 ${n}개를 만들었어요` : '바로가기를 못 만들었어요'); return false; }));
  else if (a === 'quit') act(() => API.quit());
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.act === 'flag') act(() => API.setFlag(t.dataset.name, t.checked));
  else if (t.id === 'flag-flatten') act(() => API.setFlag('FLATTEN_GAP', t.checked));
  else if (t.id === 'set-login') act(() => API.setSetting('loginStart', t.checked), t.checked ? 'PC를 켜면 토스 봇이 트레이에서 저절로 켜져요' : '이제 PC를 켜도 저절로 켜지지 않아요');
  else if (t.id === 'set-notify') act(() => API.setSetting('notify', t.checked));
});

if (API) {
  let deb = null;
  API.on('changed', () => { clearTimeout(deb); deb = setTimeout(refresh, 120); });
  let logDeb = null;
  API.on('line', key => { if (key === logKey) { clearTimeout(logDeb); logDeb = setTimeout(loadLog, 400); } });
  refresh().then(loadLog);
  setInterval(() => { if (!document.hidden) refresh(); }, 4000);
  setInterval(() => { if (!document.hidden) loadLog(); }, 6000);
}
