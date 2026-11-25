'use strict';
// 지금 미국 장이 어느 때인지(프리장·정규장·애프터장·닫힘)와 다음 일정. 시간 계산은 봇(gap_dip.mjs)과 같아요.
const HOUR = 3_600_000, DAY = 24 * HOUR;
function nthSunday(y, m, n) { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (n - 1) * 7; }
function etOffset(ms) { const y = new Date(ms).getUTCFullYear(); const s = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), e = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); return ms >= s && ms < e ? -4 : -5; }
function etParts(ms) { const d = new Date(ms + etOffset(ms) * HOUR); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; }
function etToMs(y, mo, d, h, mi) { const naive = Date.UTC(y, mo, d, h, mi); return naive - etOffset(naive + 5 * HOUR) * HOUR; }
const ymd = p => `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// 토스 달력을 못 읽을 때: 평일 9:30~16:00 (휴장일은 모름)
function guessDay(date) {
  const [y, m, d] = date.split('-').map(Number), dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return { date, closed: true, source: 'guess' };
  return { date, open: etToMs(y, m - 1, d, 9, 30), close: etToMs(y, m - 1, d, 16, 0), source: 'guess' };
}

async function marketNow(now, getDay) {
  const day = async date => { try { return (await getDay(date)) || guessDay(date); } catch { return guessDay(date); } };
  const p = etParts(now), today = await day(ymd(p));
  const out = { now, date: today.date, source: today.source, holiday: !!today.closed && p.dow !== 0 && p.dow !== 6 };
  if (!today.closed) {
    const { open, close } = today, afterEnd = close + 4 * HOUR;
    out.open = open; out.close = close; out.session = { date: today.date, open, close };
    if (now < open) return { ...out, phase: now >= open - 5.5 * HOUR ? 'pre' : 'closed', next: { what: '정규장 시작', at: open } };
    if (now < close) return { ...out, phase: 'regular', next: { what: '정규장 마감', at: close } };
    if (now < afterEnd) return { ...out, phase: 'after', next: { what: '애프터장 끝', at: afterEnd } };
  }
  const base = etToMs(p.y, p.mo, p.d, 12, 0);
  for (let i = 1; i <= 7; i++) {
    const nd = await day(ymd(etParts(base + i * DAY)));
    if (!nd.closed) return { ...out, phase: 'closed', next: { what: '정규장 시작', at: nd.open, date: nd.date }, session: { date: nd.date, open: nd.open, close: nd.close } };
  }
  return { ...out, phase: 'closed', next: null };
}

module.exports = { marketNow, etParts, etToMs, ymd, guessDay };
