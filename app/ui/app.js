'use strict';
// 토스 봇 화면. 데이터는 window.api(preload.cjs)로만 받아요.
// 2026-11-26 새 화면: 오늘 밤 장 일정 띠 위에 봇 한 줄씩(일하는 시간 + 체결 점), 들고 있는 종목은 손절 ─ 산 값 ─ 목표 막대.
// 앱 본체(main.cjs·stats.cjs)를 아직 다시 안 켰어도 돌게 예전 데이터 모양(pos·buy·holdSkip, curve 없음)도 읽어요.
const API = window.api; // 'api'라고 이름 지으면 contextBridge가 만든 window.api와 겹쳐 스크립트가 안 돌아요
const $ = id => document.getElementById(id);
const HOUR = 3_600_000, MIN = 60_000;
let snap = null, logKey = 'trades', busy = false;
const shown = new Map();
const put = (el, html) => { if (el && shown.get(el) !== html) { el.innerHTML = html; shown.set(el, html); } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 숫자·시간 ----------
const hm = ms => new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
const md = ms => new Date(ms).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short' });
function durParts(ms) {
  if (!(ms > 0)) return [[0, '분']];
  const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / MIN);
  if (h >= 24) return [[Math.floor(h / 24), '일'], [h % 24, '시간']];
  if (h) return m ? [[h, '시간'], [m, '분']] : [[h, '시간']];
  return [[Math.max(1, m), '분']];
}
const dur = ms => durParts(ms).map(([n, u]) => `${n}${u}`).join(' ');
const bigDur = ms => durParts(ms).map(([n, u]) => `<b>${n}</b><small>${u}</small>`).join('');
const signCls = v => (v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'flat');       // 달러
const rateCls = r => (r > 0.0005 ? 'up' : r < -0.0005 ? 'down' : 'flat');      // 비율
function usd(v, { sign = true } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const s = Math.abs(v).toFixed(2);
  return sign ? (v > 0.004 ? `+$${s}` : v < -0.004 ? `−$${s}` : `$${s}`) : `$${s}`;
}
const money = v => `<span class="${signCls(v)}">${usd(v)}</span>`;
const px = v => (!Number.isFinite(v) ? '–' : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const krw = v => (!Number.isFinite(v) ? '–' : `${Math.round(v).toLocaleString('ko-KR')}원`);
const pctTxt = r => (!Number.isFinite(r) ? '–' : `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%`);
const mdOf = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const MODE = { live: '실전', paper: '연습', off: '끔' };
const SHORT = { gap: '갭', hold: '보유', ah: '애프터' };
function kstOf(date, t) { // trades.csv의 'MM-DD HH:MM:SS'(KST) → ms
  const m = /^(\d\d)-(\d\d) (\d\d:\d\d(?::\d\d)?)/.exec(t || ''); if (!m || !date) return NaN;
  let y = Number(date.slice(0, 4)); if (m[1] === '01' && date.slice(5, 7) === '12') y++;
  return Date.parse(`${y}-${m[1]}-${m[2]}T${m[3].length === 5 ? m[3] + ':00' : m[3]}+09:00`);
}

// ---------- 데이터 (예전 모양도) ----------
const legsOf = s => s?.legs ?? [...(s?.pos ? [{ ...s.pos, st: 'hold' }] : []), ...(s?.buy ? [{ ...s.buy, st: 'buy' }] : [])];
const holdSkip = () => new Set((snap.stats.holdSkip ?? []).map(x => String(x).toUpperCase()));
const botSyms = () => new Set(Object.values(snap.stats.bots).flatMap(x => legsOf(x?.live).map(g => g.sym)));
const kr = it => it.currency === 'KRW' || it.country === 'KR';
const holdOn = () => snap.bots.find(b => b.key === 'hold')?.mode !== 'off';
// 실전 거래 + 지금 연습 모드인 봇의 연습 거래만 (연습 '팔 것' 기록처럼 손익 없는 줄은 뺌)
const visibleTrades = () => snap.stats.trades.filter(t => (t.mode === 'live' || snap.bots.find(b => b.key === t.bot)?.mode === 'paper') && t.pnl !== null);
const curveOf = () => snap.stats.curve ?? snap.stats.trades.filter(t => t.mode === 'live' && t.bot !== 'hold' && t.pnl !== null).slice().reverse();
function summaryFor(b) {
  const st = snap.stats.bots[b.key] || {};
  return b.mode === 'paper' ? st.paper : b.mode === 'live' ? st.live : (st.live || st.paper);
}

// ---------- 머리: 지금 장 + 남은 시간 + 돈 ----------
function lampState() {
  const b = snap.bots;
  if (b.some(x => x.state === 'gave-up' || x.state === 'waiting')) return 'alert';
  if (b.some(x => x.state === 'running' && x.runMode === 'live')) return 'live';
  if (b.some(x => x.state === 'running')) return 'paper';
  return 'idle';
}
function renderTop() {
  $('mark').className = 'mark ' + lampState();
  const m = snap.market, now = snap.now;
  put($('clock'), !m ? '<p class="phase-line">장 시간을 확인하는 중이에요</p>' : (() => {
    const at = m.next?.at, day = at && md(at) !== md(now) ? `${md(at)} ` : '';
    const [label, what] = m.phase === 'regular' ? ['정규장', `${hm(at)} 마감까지`] : m.phase === 'after' ? ['애프터장', `${hm(at)} 끝까지`]
      : m.phase === 'pre' ? ['프리장', `정규장 ${hm(at)} 시작까지`] : [m.holiday ? '미국 휴장일' : '장 닫힘', at ? `정규장 ${day}${hm(at)} 시작까지` : '다음 장 일정을 모름'];
    const guess = m.source === 'guess' ? '<span title="토스 장 달력을 못 읽어서 평일 규칙으로 계산했어요">휴장일 확인 못 함</span>' : '';
    return `<p class="phase-line"><span class="phase ${m.phase}">${label}</span><span>${what}</span>${guess}</p><p class="count">${at ? bigDur(at - now) : ''}</p>`;
  })());
  const a = snap.account?.data;
  put($('wallet'), a ? `<div class="w-main"><span>주문 가능 달러</span><b>${usd(a.cashUsd, { sign: false })}</b></div>`
    + `<div class="w-sub"><span>평가금 <b>${usd(a.usd.value, { sign: false })}</b></span><span>오늘 <b class="${signCls(a.usd.daily)}">${usd(a.usd.daily)}</b></span></div>` : '');
}

// ---------- 오늘 밤: 세션 띠 위에 봇 한 줄씩 ----------
function frame() { // 프리장 시작 ~ 애프터장 끝 (한국 시각으로 대략 18:00 ~ 10:00)
  const m = snap.market; let s = m?.session; if (!s?.open) return null;
  const next = s, past = !!m.last?.open && snap.now < s.open - 5.5 * HOUR; // 장이 다 끝나고 다음 프리장 전(한국 낮)엔 지난밤을 보여 줌
  if (past) s = m.last;
  const close = s.close || s.open + 6.5 * HOUR;
  return { s, close, F0: s.open - 5.5 * HOUR, F1: close + 4 * HOUR, past, next };
}
const at = (f, t) => Math.max(0, Math.min(100, ((t - f.F0) / (f.F1 - f.F0)) * 100));
const workOf = (f, key) => ({ gap: [f.s.open, f.close - 2 * MIN], hold: [f.s.open + MIN, f.close], ah: [f.close, f.close + 230 * MIN] }[key]);
function statusOf(b) {
  const now = snap.now, ex = b.lastExit;
  switch (b.state) {
    case 'running': return ['running', '돌고 있음', `${dur(now - b.since)}째${b.restarts ? `, 1시간에 ${b.restarts}번 다시 켬` : ''}`];
    case 'waiting': return ['waiting', '멈춤', `${Math.max(0, Math.round((b.retryAt - now) / 1000))}초 뒤 다시 켜요 (코드 ${ex?.code ?? '?'})`];
    case 'gave-up': return ['gave-up', '멈춤', '여러 번 멈춰서 쉬는 중'];
    case 'external': return ['external', '다른 창에서 실행 중', ''];
    case 'stopped': return ['', '꺼짐', ''];
    default: return ['', '꺼 둠', b.ext ? '다른 창에서 돌고 있어요' : ''];
  }
}
function doingHtml(s) {
  const m = /^\[(\d\d-\d\d) ([\d:]{5})[\d:]*\]\s?(.*)$/.exec(s?.lastLine || '');
  if (!m) return '<p class="doing">아직 기록이 없어요</p>';
  return `<p class="doing" title="${esc(m[3])}"><time>${m[2]}</time>${esc(m[3])}</p>`;
}
function laneHtml(b, f) {
  const s = summaryFor(b), on = !!snap.stats.flags[b.stopFile], [cls, label, sub] = statusOf(b);
  const main = b.state === 'gave-up' || b.state === 'stopped' ? `<button class="btn strong" data-act="restart" data-key="${b.key}">${b.state === 'stopped' ? '켜기' : '다시 켜기'}</button>`
    : b.state === 'external' ? `<button class="btn strong" data-act="takeover" data-key="${b.key}">여기서 켜기</button>`
    : b.state === 'running' ? `<button class="btn ghost" data-act="restart" data-key="${b.key}">다시 켜기</button>` : '';
  const head = `<div class="lane-head${b.mode === 'off' ? ' off' : ''}">
    <div class="lh-top"><h3 title="${esc(b.desc)}">${esc(b.name)}</h3><span class="st ${cls}">${label}</span>${sub ? `<span class="st-sub">${esc(sub)}</span>` : ''}<span class="grow"></span>
      <div class="mode" role="group" aria-label="${esc(b.name)} 모드">${['live', 'paper', 'off'].map(m => `<button class="${m}" aria-pressed="${b.mode === m}" data-act="mode" data-key="${b.key}" data-mode="${m}">${MODE[m]}</button>`).join('')}</div></div>
    ${doingHtml(s)}
    <div class="lh-act"><label class="switch${on ? ' on' : ''}" title="orb\\${b.stopFile} 파일"><input type="checkbox" data-act="flag" data-name="${b.stopFile}" ${on ? 'checked' : ''}><span>${b.key === 'hold' ? '팔지 않기' : '새로 사지 않기'}</span></label>${main}<button class="btn ghost" data-act="log" data-key="${b.key}">기록</button></div>
  </div>`;
  let track = '';
  if (f) {
    const [a, z] = workOf(f, b.key);
    track += `<div class="work ${b.mode}${b.state === 'running' ? '' : ' idle'}" style="left:${at(f, a)}%;width:${at(f, z) - at(f, a)}%" title="${esc(`${b.name}: ${hm(a)}–${hm(z)}에 일해요`)}"></div>`;
    for (const t of visibleTrades().filter(t => t.bot === b.key && t.date === f.s.date)) {
      const ms = kstOf(t.date, t.time); if (!Number.isFinite(ms)) continue;
      const r = Math.round(Math.min(18, 7 + Math.sqrt(Math.abs(t.pnl ?? 0)) * 5)); // 손익이 클수록 큰 점
      track += `<i class="dot ${signCls(t.pnl)}" style="left:${at(f, ms)}%;--r:${r}px" title="${esc(`${hm(ms)} ${t.sym} ${t.reason} ${usd(t.pnl)} (${t.ret})`)}"></i>`;
    }
    if (s?.mode === 'live') for (const g of legsOf(s)) {
      const ms = g.st === 'hold' ? g.t : g.orderT; if (!(ms >= f.F0 && ms <= f.F1)) continue;
      track += `<i class="leg ${g.st}" style="left:${at(f, ms)}%" title="${esc(g.st === 'hold' ? `${g.sym} ${g.qty}주 들고 있음` : `${g.sym} ${px(g.level)}에 ${g.qty}주 매수 주문`)}"></i>`;
    }
  }
  return head + `<div class="lane-track">${track}</div>`;
}
function renderNight() {
  const f = frame(), now = snap.now;
  let sky = '';
  if (f) {
    const band = (cls, a, z, name) => `<div class="band ${cls}" style="left:${at(f, a)}%;width:${at(f, z) - at(f, a)}%"><span>${name}</span><small>${hm(a)}–${hm(z)}</small></div>`;
    sky += band('pre', f.F0, f.s.open, '프리장') + band('regular', f.s.open, f.close, '정규장') + band('after', f.close, f.F1, '애프터장');
    let ticks = '';
    for (let t = Math.ceil(f.F0 / HOUR) * HOUR; t <= f.F1; t += HOUR) if (Number(hm(t).slice(0, 2)) % 2 === 0 && at(f, t) > 2 && at(f, t) < 98) ticks += `<span style="left:${at(f, t)}%">${hm(t)}</span>`;
    sky += `<div class="axis">${ticks}</div>`;
    if (now >= f.F0 && now <= f.F1) sky += `<div class="now" style="left:${at(f, now)}%"><span>지금 ${hm(now)}</span></div>`;
    else if (f.past) sky += `<div class="offframe">지난밤 (${mdOf(f.s.date)} 미국장). 다음 프리장은 ${dur(f.next.open - 5.5 * HOUR - now)} 뒤 ${hm(f.next.open - 5.5 * HOUR)}에 열려요</div>`;
    else if (now < f.F0) sky += `<div class="offframe">지금 ${hm(now)}, ${dur(f.F0 - now)} 뒤 프리장이 열려요</div>`;
  }
  put($('night'), `<div class="sky">${sky}</div><div class="corner"></div><div class="labels"></div>${snap.bots.map(b => laneHtml(b, f)).join('')}<div class="corner foot-row"></div><div class="foot-row"></div>`);
}

// ---------- 갭 후보 차트: 봇이 9:30에 찾은 후보마다 그날 1분봉 + 시가·지정가 선 + 산 곳▲·판 곳▼ ----------
const charts = new Map(); // 'SYM|from|to' → { bars, at, busy }
function chartOf(sym, from, to) { // 없으면 받아 오고(앱 본체가 캐시), 받으면 다시 그림. 장중엔 55초마다 새로
  if (!API?.chart) return undefined;
  const k = `${sym}|${from}|${to}`, h = charts.get(k), live = to > snap.now - MIN;
  if (!h || (!h.busy && live && Date.now() - h.at > 55_000)) {
    charts.set(k, { bars: h?.bars ?? null, at: Date.now(), busy: true });
    API.chart(sym, from, to).then(bars => { charts.set(k, { bars, at: Date.now() }); renderReel(); })
      .catch(() => { charts.set(k, { bars: h?.bars ?? [], at: Date.now() }); renderReel(); });
  }
  return h?.bars ?? null;
}
const STATUS = { seen: ['기다리는 중', ''], ordered: ['주문 걸어 둠', 'lamp'], held: ['들고 있음', 'lamp'], missed: ['닿고 튐', ''], nocash: ['현금 부족', ''], full: ['자리 없음', ''], expired: ['안 닿음', ''], closed: ['팔았음', ''] };
function sparkSvg(bars, o) {
  const W = 300, H = 104, P = 7, pts = bars.map(b => b.c), marks = [...o.buys, ...o.sells].filter(m => m.p > 0 && Number.isFinite(m.t));
  let lo = Math.min(...pts, ...[o.open, o.level].filter(v => v > 0), ...marks.map(m => m.p)), hi = Math.max(...pts, ...[o.open, o.level, o.target].filter(v => v > 0), ...marks.map(m => m.p));
  if (o.stop > 0 && lo <= o.stop * 1.05) lo = Math.min(lo, o.stop); // 손절선(-20%)은 가격이 근처까지 왔을 때만
  const pad = (hi - lo) * 0.1 || hi * 0.02; lo -= pad; hi += pad;
  const x = t => P + ((Math.max(o.from, Math.min(o.to, t)) - o.from) / (o.to - o.from)) * (W - 2 * P), y = v => P + ((hi - v) / (hi - lo)) * (H - 2 * P);
  const line = bars.map((b, i) => `${i ? 'L' : 'M'}${x(b.t).toFixed(1)},${y(b.c).toFixed(1)}`).join('');
  const area = `${line}L${x(bars.at(-1).t).toFixed(1)},${H}L${x(bars[0].t).toFixed(1)},${H}Z`;
  const ref = (v, cls) => (v > lo && v < hi ? `<line class="${cls}" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` : '');
  const buy = m => `<path class="mk buy" d="M${x(m.t).toFixed(1)},${(y(m.p) + 3).toFixed(1)}l-5.5,9h11z"><title>${esc(`산 곳 ${hm(m.t)} ${px(m.p)}`)}</title></path>`;
  const sell = m => `<path class="mk sell ${m.cls}" d="M${x(m.t).toFixed(1)},${(y(m.p) - 3).toFixed(1)}l-5.5,-9h11z"><title>${esc(`판 곳 ${hm(m.t)} ${px(m.p)}`)}</title></path>`;
  const tip = bars.at(-1), live = o.to > snap.now && snap.now - tip.t < 3 * MIN;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${o.sym} 1분봉, 마지막 ${px(tip.c)}`)}">
    <path class="ar ${o.cls}" d="${area}"/>${ref(o.open, 'open')}${ref(o.level, 'level')}${ref(o.target, 'target')}${ref(o.stop, 'stop')}
    <path class="ln" d="${line}"/>${o.buys.filter(m => m.p > 0).map(buy).join('')}${o.sells.filter(m => m.p > 0).map(sell).join('')}
    ${live ? `<circle class="live-dot" cx="${x(tip.t).toFixed(1)}" cy="${y(tip.c).toFixed(1)}" r="4"/>` : ''}</svg>`;
}
function tradeCard({ sym, bot, c, ts, leg, from, to }) {
  const bars = chartOf(sym, from, to), pnl = ts.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const buys = [...new Map([...ts.filter(t => t.buyTime).map(t => [t.buyTime, { t: kstOf(t.date, t.buyTime), p: t.buyPx }]), ...(leg?.t ? [['leg', { t: leg.t, p: leg.px }]] : [])]).values()];
  const sells = ts.map(t => ({ t: kstOf(t.date, t.time), p: t.sellPx, cls: signCls(t.pnl) }));
  const t0 = ts[0], target = leg?.target ?? t0?.target, stop = leg?.stop ?? t0?.stop;
  const [stTxt, stCls] = STATUS[c?.status] ?? STATUS.seen;
  const chip = ts.length ? `<span class="chip ${signCls(pnl)}">${esc([...new Set(ts.map(t => t.reason))].join(', '))} ${usd(pnl)}</span>` : `<span class="chip ${stCls}">${stTxt}</span>`;
  const ref = c?.o ?? bars?.[0]?.c, tip = bars?.at(-1), chg = tip && ref ? tip.c / ref - 1 : NaN, past = to < snap.now;
  const cardCls = ts.length ? (pnl > 0.004 ? 'won' : pnl < -0.004 ? 'lost' : '') : c?.status === 'held' || c?.status === 'ordered' ? 'live' : '';
  const body = bars === undefined ? '<div class="spark-wait">앱을 다시 켜면 차트가 나와요</div>'
    : bars === null ? '<div class="spark-wait">차트 불러오는 중</div>'
    : !bars.length ? '<div class="spark-wait">이 시간대엔 거래가 없었어요</div>'
    : sparkSvg(bars, { sym, from, to, open: c?.o, level: c?.level, target, stop, buys, sells, cls: rateCls(chg) });
  return `<article class="tcard ${cardCls}">
    <header><b>${esc(sym)}</b><span class="tag">${SHORT[bot]}</span>${c ? `<span class="gap">갭 +${Math.round(c.gap * 100)}%</span>` : ''}${chip}</header>
    ${body}
    <footer>${c ? `<span>시가 ${px(c.o)}</span><span class="lv">지정가 ${px(c.level)}</span>` : ''}${tip ? `<span class="grow"></span><span>${past ? '마지막' : '지금'} <b>${px(tip.c)}</b> <b class="${rateCls(chg)}">${pctTxt(chg)}</b></span>` : ''}</footer>
  </article>`;
}
function renderReel() {
  const el = $('reel'), gapBot = snap.bots.find(b => b.key === 'gap'), board = gapBot && summaryFor(gapBot)?.board;
  if (!board?.list?.length) { el.hidden = true; put(el, ''); return; }
  const m = snap.market, ses = [m?.session, m?.last].find(s => s?.date === board.date && s.open);
  const open = ses?.open ?? board.open, close = ses?.close ?? open + 6.5 * HOUR;
  const trades = visibleTrades().filter(t => t.date === board.date), legs = legsOf(snap.stats.bots.gap?.live);
  const tonight = m?.session?.date === board.date && m.phase !== 'closed';
  let cards = board.list.map(c => tradeCard({ sym: c.s, bot: 'gap', c, ts: trades.filter(t => t.bot === 'gap' && t.sym === c.s), leg: legs.find(g => g.sym === c.s && g.st === 'hold'), from: open, to: close }));
  const others = new Map(); // 같은 밤 애프터장·보유 관리 거래도 같은 모양으로
  for (const t of trades.filter(t => t.bot !== 'gap')) { const k = `${t.bot}|${t.sym}`; others.set(k, [...(others.get(k) ?? []), t]); }
  for (const ts of others.values()) { const ah = ts[0].bot === 'ah'; cards.push(tradeCard({ sym: ts[0].sym, bot: ts[0].bot, ts, from: ah ? close : open, to: ah ? close + 4 * HOUR : close })); }
  el.hidden = false;
  put(el, `<div class="reel-head"><h2>${tonight ? '오늘 밤' : '지난밤'} 갭 후보</h2><span class="meta">${mdOf(board.date)} 미국장, 갭 큰 순서. 시가 -5% 지정가(노란 점선)에 닿으면 사요</span></div><div class="reel-grid">${cards.join('')}</div>`);
}

// ---------- 지금 들고 있는 것 ----------
function gauge(o) { // 손절(-20%) ─ 산 값 ─ 목표(+10%) 위에 지금 가격
  const span = o.target - o.stop; if (!(span > 0) || !(o.base > 0)) return '';
  const pos = v => Math.max(0, Math.min(100, ((v - o.stop) / span) * 100));
  const has = o.now > 0, b = pos(o.base), n = has ? pos(o.now) : b, r = has ? o.now / o.base - 1 : NaN, c = rateCls(r);
  return `<div class="gauge">
    <div class="g-head"><b>${esc(o.sym)}</b>${o.name && o.name !== o.sym ? `<span class="name">${esc(o.name)}</span>` : ''}<span class="tag">${esc(o.tag)}</span><span class="qty">${o.qty}주${has ? `, 지금 ${px(o.now)}` : ''}</span><span class="r ${c}">${has ? pctTxt(r) : '–'}</span></div>
    <div class="g-track" role="img" aria-label="${esc(`손절 ${px(o.stop)}, ${o.baseLabel} ${px(o.base)}, 목표 ${px(o.target)}${has ? `, 지금 ${px(o.now)}` : ''}`)}"><i class="fill ${c}" style="left:${Math.min(b, n)}%;width:${Math.abs(n - b)}%"></i><i class="base" style="left:${b}%"></i>${has ? `<i class="cur ${c}" style="left:${n}%"></i>` : ''}</div>
    <div class="g-scale"><span class="lo">손절 ${px(o.stop)}</span><span class="mid" style="left:${b}%">${o.baseLabel} ${px(o.base)}</span><span class="hi">목표 ${px(o.target)}</span></div>
  </div>`;
}
function renderHeld() {
  const a = snap.account?.data, last = new Map((a?.items ?? []).map(it => [it.symbol, it.last])), skip = holdSkip(), mine = botSyms();
  let h = '';
  for (const b of snap.bots) {
    if (b.key === 'hold') continue;
    for (const g of legsOf(snap.stats.bots[b.key]?.live)) h += g.st === 'buy'
      ? `<div class="wait"><b>${esc(g.sym)}</b><span class="tag">${SHORT[b.key]}</span><span>${px(g.level)}에 ${g.qty}주 사려고 기다리는 중</span></div>`
      : gauge({ sym: g.sym, tag: SHORT[b.key], qty: g.qty, base: g.px, stop: g.stop, target: g.target, now: last.get(g.sym), baseLabel: '산 값' });
  }
  if (holdOn()) for (const it of a?.items ?? []) if (!kr(it) && it.avg > 0 && !mine.has(it.symbol) && !skip.has(String(it.symbol).toUpperCase())) // 보유 주식 관리가 +10%/-20%에 파는 종목
    h += gauge({ sym: it.symbol, name: it.name, tag: '보유 관리', qty: it.qty, base: it.avg, stop: it.avg * 0.8, target: it.avg * 1.1, now: it.last, baseLabel: '평균' });
  if (!h) { const m = snap.market; h = `<p class="empty">봇이 들고 있는 주식이 없어요.${m?.session?.open && m.phase !== 'regular' && m.phase !== 'after' ? ` 갭 봇은 ${hm(m.session.open)}에 정규장이 열리면 주문을 걸어요.` : ''}</p>`; }
  put($('held'), h);
}

// ---------- 봇이 번 돈 ----------
function curveSvg(vals, trades) {
  const W = 600, H = 140, P = 12, n = vals.length, rad = n > 60 ? 2.5 : 5;
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = i => P + (i * (W - 2 * P)) / Math.max(1, n - 1), y = v => P + ((hi - v) * (H - 2 * P)) / span, z = y(0);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${z.toFixed(1)}L${x(0).toFixed(1)},${z.toFixed(1)}Z`;
  const dots = vals.slice(1).map((v, k) => { const t = trades[k];
    return `<circle class="${signCls(t.pnl)}" cx="${x(k + 1).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${rad}"><title>${esc(`${mdOf(t.date)} ${t.sym} ${t.reason} ${usd(t.pnl)}, 누적 ${usd(v)}`)}</title></circle>`; }).join('');
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="실전 거래 ${n - 1}건의 누적 손익">
    <defs><clipPath id="cu"><rect x="0" y="0" width="${W}" height="${z.toFixed(1)}"/></clipPath><clipPath id="cd"><rect x="0" y="${z.toFixed(1)}" width="${W}" height="${(H - z).toFixed(1)}"/></clipPath></defs>
    <path class="area-up" d="${area}" clip-path="url(#cu)"/><path class="area-down" d="${area}" clip-path="url(#cd)"/>
    <line class="zero" x1="0" x2="${W}" y1="${z.toFixed(1)}" y2="${z.toFixed(1)}"/><path class="line" d="${line}"/>${dots}</svg>`;
}
function renderScore() {
  const list = curveOf(), L = snap.stats.limits;
  let c = 0; const vals = [0, ...list.map(t => (c += t.pnl ?? 0))];
  const stat = (label, v) => `<div class="stat"><span>${label}</span><b>${v}</b></div>`;
  const g0 = snap.stats.bots.gap?.live, a0 = snap.stats.bots.ah?.live, total = typeof g0?.cum === 'number' || typeof a0?.cum === 'number' ? (g0?.cum ?? 0) + (a0?.cum ?? 0) : c; // 봇이 한도 계산에 쓰는 state.json 누적 (거래 기록 합계와 몇 센트 다를 수 있음)
  let h = `<div class="score-top"><div class="stat"><span>지금까지</span><div class="big ${signCls(total)}">${usd(total)}</div></div>${stat('거래', `${list.length}건`)}${stat('이긴 거래', list.filter(t => t.pnl > 0).length)}${stat('진 거래', list.filter(t => t.pnl < 0).length)}</div>`;
  h += list.length ? curveSvg(vals, list) : '<p class="empty">아직 실전 거래가 없어요</p>';
  if (L) {
    const g = snap.stats.bots.gap?.live, ah = snap.stats.bots.ah?.live, last = [g?.latestDate, ah?.latestDate].filter(Boolean).sort().pop();
    const day = [g, ah].filter(x => x && x.latestDate === last).reduce((a, x) => a + (x.latestPnl ?? 0), 0), cum = (g?.cum ?? 0) + (ah?.cum ?? 0);
    const meter = (label, used, lim) => { const r = lim ? Math.min(1, used / lim) : 0;
      return `<div class="meter"><p><span>${label}</span><b>${usd(used, { sign: false })} / $${lim}</b></p><div class="bar"><i class="${r >= 1 ? 'full' : r >= 0.7 ? 'near' : ''}" style="width:${(r * 100).toFixed(1)}%"></i></div></div>`; };
    h += `<div class="meters">${meter(`${last ? mdOf(last) : '최근 거래일'} 손실`, Math.max(0, -day), L.dailyLossLimitUsd)}${meter('누적 손실', Math.max(0, -cum), L.totalLossLimitUsd)}</div>`;
    h += '<p class="note">손실 한도는 갭·애프터장 봇 합계예요. 한도에 닿으면 새로 안 사요. 보유 주식 관리 매도는 원래 있던 주식을 정리한 거라 여기 안 넣어요.</p>';
  }
  put($('score'), h);
}

// ---------- 계좌 ----------
function renderAccount() {
  const A = snap.account, a = A?.data, el = $('account');
  $('acct-refresh').textContent = A?.busy ? '불러오는 중' : '새로고침';
  $('acct-meta').textContent = a ? `${hm(a.at)} 기준` : '';
  if (!a) { put(el, A?.error ? `<p class="err">계좌를 못 읽었어요: ${esc(A.error)}</p><p class="muted">토스 키 파일(toss-mcp\\.env)과 인터넷 연결을 확인한 뒤 새로고침을 눌러 주세요.</p>` : '<p class="empty">계좌를 불러오는 중이에요</p>'); return; }
  const skip = holdSkip(), on = holdOn(), mine = botSyms();
  let h = `<div class="acct-sum"><div><span>평가금(달러)</span><b>${usd(a.usd.value, { sign: false })}</b></div><div><span>평가 손익</span><b>${money(a.usd.pnl)}</b></div><div><span>오늘</span><b>${money(a.usd.daily)}</b></div></div>`;
  if (A.error) h += `<p class="err">마지막 새로고침 실패: ${esc(A.error)}</p>`;
  if (!a.items.length) h += '<p class="empty">보유 주식이 없어요</p>';
  for (const it of a.items) {
    const k = kr(it), f = k ? krw : px, bot = mine.has(it.symbol), skipped = skip.has(String(it.symbol).toUpperCase()), managed = !k && on && !bot && !skipped;
    const rule = k ? '한국 주식, 봇이 안 건드려요' : bot ? '갭·애프터장 봇이 관리 중' : skipped ? 'hold_skip.txt, 봇이 안 건드려요' : managed ? `${px(it.avg * 1.1)} 넘거나 ${px(it.avg * 0.8)} 밑이면 봇이 팔아요` : '봇이 안 건드려요';
    const w = Math.min(50, Math.abs(it.rate ?? 0) * 200); // 막대 끝 = ±25%
    h += `<div class="hrow"><div class="nm"><b>${esc(it.name)}</b><span class="sym">${esc(it.symbol)}, ${it.qty}주</span><span class="rule${bot || managed ? ' managed' : ''}">${esc(rule)}</span></div>`
      + `<div class="pr">${f(it.avg)} → <b>${f(it.last)}</b></div><div class="dbar" aria-hidden="true"><i class="${rateCls(it.rate)}" style="left:${it.rate >= 0 ? 50 : 50 - w}%;width:${w}%"></i></div><div class="rt ${rateCls(it.rate)}">${pctTxt(it.rate)}</div></div>`;
  }
  put(el, h);
}

// ---------- 최근 거래 / 봇 기록 ----------
function tradesHtml() {
  const list = visibleTrades().slice(0, 40);
  if (!list.length) return '<p class="empty">아직 거래가 없어요</p>';
  return '<div class="trow head"><span>날짜</span><span>판 때</span><span>봇</span><span>종목</span><span>사유</span><span class="rt">수익률</span><span class="pl">손익</span></div>'
    + list.map(t => `<div class="trow ${signCls(t.pnl)}${t.mode === 'paper' ? ' paper' : ''}"><span class="d">${mdOf(t.date)}</span><span class="d">${esc((t.time || '').slice(6, 11))}</span><span><span class="tag">${SHORT[t.bot]}${t.mode === 'paper' ? ' 연습' : ''}</span></span><span class="sym">${esc(t.sym)}</span><span class="rs">${esc(t.reason)}</span><span class="rt ${signCls(t.pnl)}">${esc(t.ret)}</span><span class="pl ${signCls(t.pnl)}">${usd(t.pnl)}</span></div>`).join('');
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
  const f = $('log-file'); if (f) f.textContent = `${MODE[r.mode]} 기록, ${r.file.split(/[\\/]/).slice(-3).join('\\')}`;
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

function render() { if (!snap) return; renderTop(); renderNight(); renderReel(); renderHeld(); renderScore(); renderAccount(); renderTabs(); renderFoot(); if (logKey === 'trades') void loadLog(); }
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
