# ※ 직접 실행하는 대신 python history/analyze.py gainers 를 쓰세요 (이 파일은 그 안에서 불려요)
# 조사한 전략들을 급등일 분봉으로 시험 (2026-11-18). 날짜를 나눠 이어서 실행:  python3 history/research.py 0/2 160
#  S1a/S1b  5분 시가범위 돌파 (Zarattini·Barbon·Aziz 2024): 상대거래량 상위 20, 첫 5분 양봉 → 고점 돌파 매수, 손절 ATR×10%, 마감 청산
#  S2       갭 종목 시가 매수 → 마감 (Berkman 외 2012: 갭 뒤 장중 되돌림)
#  S3a/S3b  장 막판 모멘텀 (Gao 외 2018): 15:30 매수 → 마감, 10시까지 상승(+ 직전 30분 상승)
#  S4       Warrior식 갭앤고 근사: $2~20, 갭+15%, 프리장 거래량 ≥ 평소 하루치, 프리장 고점 돌파, 손절 직전 5분 저점, 목표 2R, 11시 청산
# 판단 시점에 알 수 있는 조건만 씀: 그 시각 +15% 이상, 그 시각까지 누적 거래대금 $100만 이상 (급등일 목록이 이 조건을 다 포함)
import sys, os, json, csv, time, bisect, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backtest as B
MIN = 60_000
FEE, SELLX, STOPSLIP, ENTRYSLIP = 0.001, 0.0003, 0.01, 0.005
EV = {}
for r in csv.DictReader(open(os.path.join(B.HDATA, 'events.csv'), encoding='utf-8-sig')): EV.setdefault(r['날짜'], {})[r['종목']] = r
STATS = json.load(open(os.path.join(B.HDATA, 'event_stats.json')))
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)

def net(e_raw, x_raw, px, stop_exit=False, stop_entry=False):
    s = B.spread_of(px, B.BASE)
    e = e_raw * (1 + s / 2) * (1 + (ENTRYSLIP if stop_entry else 0))
    x = x_raw * (1 - s / 2) * (1 - (STOPSLIP if stop_exit else 0))
    return x * (1 - FEE - SELLX) / (e * (1 + FEE)) - 1

def at(bars, ts, t):  # t 이전(포함) 마지막 봉 index
    return bisect.bisect_right(ts, t) - 1

def hold(bars, i0, e_raw, stop, target, t_end, entry_bar_close_check=True):
    """i0 봉에서 진입. 손절(stop), 목표(target 또는 None), t_end(봉 시작 시각 기준)까지 보유. (청산가, 이유)"""
    t, o, h, l, c, v = bars[i0]
    if entry_bar_close_check and c <= stop: return stop, '손절'
    for j in range(i0 + 1, len(bars)):
        t, o, h, l, c, v = bars[j]
        if t >= t_end: return bars[j - 1][4], '시간'
        if o <= stop: return o, '손절'
        if l <= stop: return stop, '손절'
        if target and h >= target: return max(target, o), '목표'
    return bars[-1][4], '데이터끝'

def run_day(d, data):
    o_ts, c_ts = B.session(d); out = []
    E = EV.get(d, {}); names = {safe(T): T for T in E}
    orb = []
    for fn, bars in data.items():
        T = names.get(fn)
        if not T: continue
        r = E[T]; pc = float(r['전일종가']); st = STATS.get(f'{d}|{T}')
        bars = sorted(bars); ts = [b[0] for b in bars]
        cum = []; a = 0.0
        for b in bars: a += b[4] * b[5]; cum.append(a)
        dv = lambda i: cum[i] if i >= 0 else 0.0
        i_pre = at(bars, ts, o_ts - 1)                       # 9:29 이전 마지막 봉
        i_open = bisect.bisect_left(ts, o_ts)
        if i_open >= len(bars) or bars[i_open][0] >= o_ts + 5 * MIN: continue
        op = bars[i_open][1]
        pre_v = sum(b[5] for b in bars[:i_open]); pmh = max((b[2] for b in bars[:i_open]), default=None)
        # ---- S2: 갭 종목 시가 매수 → 마감
        if op >= pc * 1.15 and 1 <= op <= 20 and dv(i_pre) >= 1e6:
            x, why = hold(bars, i_open, op, -1, None, c_ts, False)
            out.append(dict(s='S2', d=d, sym=T, r=net(op, x, op), g=x / op - 1, why=why))
        # ---- S1: 5분 시가범위 (후보만 모아 두고 나중에 상대거래량 순위)
        i5 = at(bars, ts, o_ts + 5 * MIN - 1)
        if st and i5 >= i_open:
            orb_bars = bars[i_open:i5 + 1]; p5 = orb_bars[-1][4]
            if p5 >= pc * 1.15 and dv(i5) >= 1e6:
                orb.append(dict(T=T, bars=bars, ts=ts, i5=i5, o=orb_bars[0][1], c=p5, h=max(b[2] for b in orb_bars),
                                rv=sum(b[5] for b in orb_bars) / max(st['adv'], 1), atr=st['atr']))
        # ---- S3: 15:30 매수 → 마감
        i1530 = at(bars, ts, c_ts - 30 * MIN - 1); i10 = at(bars, ts, o_ts + 30 * MIN - 1); i15 = at(bars, ts, c_ts - 60 * MIN - 1)
        if i1530 > i_open and i10 >= i_open and i1530 + 1 < len(bars):
            p = bars[i1530][4]
            if p >= pc * 1.15 and dv(i1530) >= 1e6 and 1 <= p <= 20 and bars[i10][4] > pc:
                nb = bars[i1530 + 1]
                if nb[0] < c_ts:
                    x, why = hold(bars, i1530 + 1, nb[1], -1, None, c_ts, False)
                    rec = dict(d=d, sym=T, r=net(nb[1], x, nb[1]), g=x / nb[1] - 1, why=why)
                    out.append(dict(rec, s='S3a'))
                    if i15 >= 0 and p > bars[i15][4]: out.append(dict(rec, s='S3b'))
        # ---- S4: Warrior식 갭앤고
        if st and pmh and op >= pc * 1.15 and 2 <= op <= 20 and pre_v >= st['adv'] and dv(i_pre) >= 1e6:
            for j in range(i_open, len(bars)):
                t, o, h, l, c, v = bars[j]
                if t >= o_ts + 60 * MIN: break
                if h > pmh:
                    e_raw = max(o, pmh); stop = min(b[3] for b in bars[max(0, j - 5):j]) if j > 0 else l
                    R = e_raw - stop
                    if R <= 0 or R / e_raw > 0.10: break
                    x, why = hold(bars, j, e_raw, stop, e_raw + 2 * R, o_ts + 90 * MIN)
                    out.append(dict(s='S4', d=d, sym=T, r=net(e_raw, x, e_raw, why == '손절', True), g=x / e_raw - 1, why=why))
                    break
    # ---- S1 순위·매매
    for tag, lo, hi, atr_min in (('S1a', 5, 1e9, 0.5), ('S1b', 1, 20, 0)):
        C = [x for x in orb if lo <= x['c'] <= hi and x['atr'] > atr_min and x['rv'] >= 0.04 and x['atr'] < x['c']]
        for x in sorted(C, key=lambda x: -x['rv'])[:20]:
            if not (x['c'] > x['o']): continue
            bars, ts = x['bars'], x['ts']
            for j in range(x['i5'] + 1, len(bars)):
                t, o, h, l, c, v = bars[j]
                if t >= c_ts - 30 * MIN: break
                if h > x['h']:
                    e_raw = max(o, x['h']); stop = e_raw - 0.10 * x['atr']
                    xr, why = hold(bars, j, e_raw, stop, None, c_ts)
                    out.append(dict(s=tag, d=d, sym=x['T'], r=net(e_raw, xr, e_raw, why == '손절', True), g=xr / e_raw - 1, why=why))
                    break
    return out

if __name__ == '__main__':
    k, m = map(int, sys.argv[1].split('/')); budget = float(sys.argv[2]) if len(sys.argv) > 2 else 160
    OUT = os.path.join(B.HERE, 'results_r'); os.makedirs(OUT, exist_ok=True)
    doneF = os.path.join(OUT, f'done_{k}.txt'); resF = os.path.join(OUT, f'trades_{k}.jsonl')
    done = set(open(doneF).read().split()) if os.path.exists(doneF) else set()
    t0 = time.time(); days = [d for i, d in enumerate(B.days_massive()) if i % m == k and d not in done]; n = 0
    for d in days:
        if time.time() - t0 > budget: break
        T = run_day(d, B.load_massive(d))
        with open(resF, 'a') as f:
            for x in T: f.write(json.dumps(x, ensure_ascii=False) + '\n')
        with open(doneF, 'a') as f: f.write(d + '\n')
        n += 1
    print(f'[{k}/{m}] 이번에 {n}일, 남은 {len(days) - n}일, {time.time() - t0:.0f}초')
