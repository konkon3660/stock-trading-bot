# 분봉 백테스터 — 봇의 VWAP 아래 눌림(vwapDip) 신호를 과거 분봉으로 시험해요.
# 데이터: history/data (fetch.mjs가 받은 Massive 분봉) 또는 data/recordings (봇 녹화)
# 사용 예:  python3 history/backtest.py               → 받은 분봉 전체로 F 기본 설정 결과
#           python3 history/backtest.py --src rec      → 봇 녹화(11/13, 11/16 등)로 같은 계산 (리플레이와 맞는지 확인용)
# 비용: 스프레드(가격대별 실측 중간값) 절반씩 사고팔 때 + 수수료 0.1%씩 + 손절 미끄러짐 1% (실제 F·G 손절 평균 -6.3%에 맞춤)
import json, os, glob, bisect, math, argparse, statistics as st, datetime as dt
sys_path_here = __import__('os').path.dirname(__import__('os').path.abspath(__file__))
import sys as _sys; _sys.path.insert(0, sys_path_here)
import et  # 동부시간 계산 (zoneinfo 없이)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HDATA = os.environ.get('HIST_DATA') or os.path.join(HERE, 'data')
MIN = 60_000

BASE = dict(minGain=0.15, maxGain=3.0, minPx=0.3, maxPx=20, minAmt=300_000,          # 감시 대상 (config.universe)
            minBelow=0.02, maxBelow=None, minDrop5=0.004, maxDrop5=None, minDv5=10_000,  # 신호 (config.vwapDip)
            upbar=False,
            sl=0.05, tp=0.12, hold=60, be=0.0, trailStart=9.0, trail=0.05,           # 청산 (F)
            firstMin=15, lastMin=30, flattenMin=15, cooldown=30, noReentryAfterStop=True,
            fee=0.001, sellExtra=0.0003, stopSlip=0.01,  sprMult=1.0, amb='stop',
            maxPos=3, maxTrades=15, lossLimit=7.5, size=30.0)

def spread_of(px, P):  # 봇 실제 진입 스프레드 중간값 (11/13~16, 105건): $1 미만 0.6%, $1~2 0.8%, $2~5 0.5%, $5 이상 0.3%
    s = 0.006 if px < 1 else 0.008 if px < 2 else 0.005 if px < 5 else 0.003
    return s * P['sprMult']

# ---------- 데이터 ----------
_daily_dates = None
def daily_dates():
    global _daily_dates
    if _daily_dates is None:
        _daily_dates = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(HDATA, 'daily', '*.json')))
    return _daily_dates

_prev_cache = {}
def prev_closes(d):
    if d in _prev_cache: return _prev_cache[d]
    ds = daily_dates(); i = bisect.bisect_left(ds, d)
    out = {}
    if i > 0:
        for r in json.load(open(os.path.join(HDATA, 'daily', ds[i - 1] + '.json'))): out[r[0]] = r[4]
    _prev_cache[d] = out; return out

def session(d):
    return et.session(d)

def days_massive():
    return sorted(os.path.basename(p) for p in glob.glob(os.path.join(HDATA, 'minute', '*')) if os.path.isdir(p))

def load_massive(d):
    out = {}
    for f in glob.glob(os.path.join(HDATA, 'minute', d, '*.json')):
        rows = json.load(open(f))
        if rows: out[os.path.basename(f)[:-5]] = [(r[0], r[1], r[2], r[3], r[4], r[5]) for r in rows]
    return out

def load_rec(d):
    out = {}
    for f in glob.glob(os.path.join(ROOT, 'data', 'recordings', d, '*.json')):
        n = os.path.basename(f)[:-5]
        if n.startswith('_'): continue
        rows = json.load(open(f))
        if isinstance(rows, list) and rows: out[n] = sorted((b['t'], b['o'], b['h'], b['l'], b['c'], b['v']) for b in rows)
    return out

# ---------- 한 종목 하루 ----------
def run_symbol(sym, bars, pc, d, P):
    if not pc or pc <= 0: return []
    o_ts, c_ts = session(d)
    bars = sorted(bars)
    ts = [b[0] for b in bars]
    trades = []; pos = None; cool_until = 0; stopped = False
    pv = vv = 0.0; amt = 0.0
    tp_on = P['tp'] and P['tp'] > 0
    for i, (t, o, h, l, c, v) in enumerate(bars):
        amt += c * v
        if t >= o_ts and t < c_ts: pv += (h + l + c) / 3 * v; vv += v
        # --- 청산 (이 봉 안에서) ---
        if pos and t >= pos['t']:
            s = pos['s']; bid = lambda x: x * (1 - s / 2)
            bo, bh, bl, bc = bid(o), bid(h), bid(l), bid(c)
            E = pos['px']; reason = None; xp = None
            if P['be'] and pos['peak'] >= E * (1 + P['be']): pos['stop'] = max(pos['stop'], E * 1.003)
            tpx = E * (1 + P['tp']) if tp_on else math.inf
            if bo <= pos['stop']: reason, xp = '손절', bo * (1 - P['stopSlip'])
            elif bo >= tpx: reason, xp = '익절', bo
            else:
                hs, ht = bl <= pos['stop'], bh >= tpx
                if hs and ht: first = P['amb'] if P['amb'] != 'dir' else ('tp' if c >= o else 'stop')
                else: first = 'stop' if hs else 'tp' if ht else None
                if first == 'stop': reason, xp = '손절', pos['stop'] * (1 - P['stopSlip'])
                elif first == 'tp': reason, xp = '익절', (tpx if not P.get('tpMid') else (tpx + max(tpx, bh)) / 2)  # tpMid: 봉 안에서 익절선을 넘으면 넘은 폭의 절반만큼 더 받았다고 침(봇은 5초마다 매수호가로 팖)
                else:
                    pk = max(pos['peak'], bh)
                    if pk >= E * (1 + P['trailStart']) and bl <= pk * (1 - P['trail']): reason, xp = '트레일링', pk * (1 - P['trail']) * (1 - P['stopSlip'])
                    elif t + MIN - pos['t'] >= P['hold'] * MIN: reason, xp = '보유시간 만료', bc
                    elif t + MIN >= c_ts - P['flattenMin'] * MIN: reason, xp = '장마감', bc
                    pos['peak'] = pk
            if reason:
                r = xp * (1 - P['fee'] - P['sellExtra']) / (E * (1 + P['fee'])) - 1
                trades.append(dict(d=d, sym=sym, t=pos['t'], xt=t, px=E, xp=xp, r=r, why=reason, peak=pos['peak'] / E - 1,
                                   r5=pos['r5'], below=pos['below'], gain=pos['gain'], s=s))
                if reason == '손절': stopped = True
                cool_until = t + MIN + P['cooldown'] * MIN; pos = None
            continue  # 보유 중인 봉에서는 신호를 안 봄
        if pos: continue
        # --- 진입 신호 (이 봉이 끝난 시점) ---
        tc = t + MIN
        if not (o_ts + P['firstMin'] * MIN <= tc < c_ts - P['lastMin'] * MIN): continue
        if tc < cool_until or (stopped and P['noReentryAfterStop']): continue
        if i + 1 >= len(bars) or bars[i + 1][0] > tc + 2 * MIN: continue
        if not (P['minPx'] <= c <= P['maxPx']) or amt < P['minAmt'] or vv <= 0: continue
        gain = c / pc - 1
        if not (P['minGain'] <= gain <= P['maxGain']): continue
        vw = pv / vv; below = 1 - c / vw
        if below < P['minBelow'] or (P['maxBelow'] is not None and below > P['maxBelow']): continue
        j = bisect.bisect_right(ts, t - 5 * MIN) - 1
        if j < 0: continue
        r5 = c / bars[j][4] - 1
        if r5 > -P['minDrop5'] or (P['maxDrop5'] is not None and r5 < -P['maxDrop5']): continue
        k = bisect.bisect_right(ts, t - 5 * MIN)
        if sum(b[4] * b[5] for b in bars[k:i + 1]) < P['minDv5']: continue
        if P['upbar'] and not (c > o): continue
        nb = bars[i + 1]; s = spread_of(nb[1], P); E = nb[1] * (1 + s / 2)
        pos = dict(t=nb[0], px=E, s=s, stop=E * (1 - P['sl']), peak=E, r5=r5, below=below, gain=gain)
    if pos:  # 데이터가 끝날 때까지 못 판 경우: 마지막 가격
        t, o, h, l, c, v = bars[-1]; xp = c * (1 - pos['s'] / 2)
        trades.append(dict(d=d, sym=sym, t=pos['t'], xt=t, px=pos['px'], xp=xp, r=xp * (1 - P['fee']) / (pos['px'] * (1 + P['fee'])) - 1,
                           why='데이터끝', peak=pos['peak'] / pos['px'] - 1, r5=pos['r5'], below=pos['below'], gain=pos['gain'], s=pos['s']))
    return trades

def run_day(data, d, P, prev=None):
    pc = prev if prev is not None else prev_closes(d)
    T = []
    for sym, bars in data.items(): T += run_symbol(sym, bars, pc.get(sym), d, P)
    return sorted(T, key=lambda x: x['t'])

def portfolio(T, P):
    """동시 보유 3개, 하루 15회, 일일 손실 한도 — 실제 봇과 같은 제한을 걸었을 때 뽑히는 거래"""
    out = []; byd = {}
    for x in T: byd.setdefault(x['d'], []).append(x)
    for d, L in byd.items():
        openx = []; n = 0; pnl = 0.0
        for x in sorted(L, key=lambda x: x['t']):
            openx = [y for y in openx if y['xt'] + MIN > x['t']]
            if len(openx) >= P['maxPos'] or n >= P['maxTrades'] or pnl <= -P['lossLimit']: continue
            openx.append(x); n += 1; pnl += x['r'] * P['size']; out.append(x)
    return out

def summary(T, size=30.0):
    if not T: return dict(n=0)
    r = [x['r'] for x in T]; days = {}
    for x in T: days[x['d']] = days.get(x['d'], 0) + x['r'] * size
    dv = list(days.values())
    se = st.pstdev(r) / math.sqrt(len(r)) if len(r) > 1 else float('nan')
    return dict(n=len(r), days=len(days), mean=st.mean(r), med=st.median(r), win=sum(v > 0 for v in r) / len(r), se=se,
                usd=sum(dv), usd_day=st.mean(dv), up_days=sum(v > 0 for v in dv) / len(dv))

def fmt(s):
    if not s.get('n'): return '거래 없음'
    return (f"{s['n']:5d}건 {s['days']:4d}일 | 거래당 평균 {s['mean']*100:+5.2f}% (±{s['se']*100*1.96:.2f}) 중간값 {s['med']*100:+5.1f}% 승률 {s['win']*100:4.1f}% "
            f"| $30씩 합계 {s['usd']:+8.2f} 하루 {s['usd_day']:+6.2f} 플러스인 날 {s['up_days']*100:4.1f}%")

def cli():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='massive', choices=['massive', 'rec'])
    ap.add_argument('--dates', default='')
    ap.add_argument('--set', nargs='*', default=[], help='예: tp=0.16 sl=0.08 hold=180')
    a = ap.parse_args()
    P = dict(BASE)
    for kv in a.set:
        k, v = kv.split('='); P[k] = None if v == 'None' else (v if k == 'amb' else (v.lower() == 'true') if v.lower() in ('true', 'false') else float(v))
    if a.src == 'massive': dates = a.dates.split(',') if a.dates else days_massive(); load = load_massive
    else: dates = a.dates.split(',') if a.dates else sorted(os.path.basename(p) for p in glob.glob(os.path.join(ROOT, 'data', 'recordings', '*'))); load = load_rec
    T = []
    for d in dates: T += run_day(load(d), d, P)
    print('신호 전부   ', fmt(summary(T, P['size'])))
    print('봇처럼 제한', fmt(summary(portfolio(T, P), P['size'])))

if __name__ == '__main__':
    cli()
