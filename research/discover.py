"""녹화 데이터로 '어디서 샀으면 비용 빼고 남았나'를 거꾸로 확인하는 스크립트.

사용: python research/discover.py            (data/recordings/ 아래 모든 날짜)
      python research/discover.py 2026-11-13 (특정 날짜만)
필요: numpy, pandas

하는 일
1) 녹화된 1분봉으로 정규장의 매 분마다 '그 순간 알 수 있던 값'(VWAP 대비, 최근 5분 등락, 거래량 배수 등)을 계산
2) 그 다음 봉 시가에 매도호가로 샀다고 치고, 익절/손절/최대 보유 규칙으로 팔았을 때의 순수익(스프레드+수수료 뺀 뒤)을 계산
3) 진입 규칙별로 성과를 날짜·시간대·종목 절반으로 나눠 보여 주고, 종목을 다시 뽑는 방식(부트스트랩)으로 운인지 아닌지 가늠
- 같은 종목은 청산 뒤 30분 재진입 금지, 손절한 종목은 그날 재진입 금지 (봇과 같음)
- 감시 대상: 당일 +15% 이상, $0.3~$20, 최근 5분 거래대금 $1만 이상 (전일 종가는 녹화된 순위에서 역산)
- 주의: 녹화 시작 전 구간은 '나중에 순위에 오른 종목'만 있어서 결과가 좋게 나올 수 있음 (rec_before 열로 구분)
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))
MIN = 60000
FEE = 2 * CFG['fills']['commissionPct'] + (CFG['fills']['minFeeUsd'] + CFG['fills']['sellTaxMinUsd']) / (CFG['seedUsd'] * CFG['positionPct'])


def load_day(d):
    meta = json.load(open(os.path.join(d, '_meta.json')))
    OPEN, CLOSE = meta['open'], meta['close']
    ranks = [json.loads(l) for l in open(os.path.join(d, '_rankings.jsonl'))]
    rec0 = ranks[0]['t']
    prev = {}
    for r in ranks:
        for s, last, ch, amt in r['gainers']:
            if last and ch is not None and ch > -1 and s not in prev: prev[s] = last / (1 + ch)
    sp = {}
    bp = os.path.join(d, '_books.jsonl')
    for l in (open(bp) if os.path.exists(bp) else []):
        b = json.loads(l)
        if not (OPEN <= b['t'] < CLOSE): continue  # 정규장 호가만 (프리·애프터는 훨씬 얇아서 섞으면 안 됨)
        if b['a'] and b['b']:
            a, bb = b['a'][0]['p'], b['b'][0]['p']; sp.setdefault(b['s'], []).append((a - bb) / ((a + bb) / 2))
    allsp = [x for v in sp.values() for x in v]
    gsp = float(np.median(allsp)) if allsp else 0.009
    rows, bars = [], {}
    for f in sorted(os.listdir(d)):
        if not f.endswith('.json') or f.startswith('_'): continue
        s = f[:-5]
        if s not in prev: continue
        b = pd.DataFrame(json.load(open(os.path.join(d, f))))
        if b.empty: continue
        b = b.sort_values('t').drop_duplicates('t')
        b = b[b.t >= OPEN - 330 * MIN].set_index('t')
        if len(b) < 30: continue
        g = b.reindex(np.arange(b.index.min(), CLOSE, MIN))  # 거래 없는 분은 직전 종가, 거래량 0
        g['v'] = g['v'].fillna(0); g['c'] = g['c'].ffill()
        for c in ['o', 'h', 'l']: g[c] = g[c].fillna(g['c'])
        g = g.dropna(subset=['c'])
        t, o, h, l, c, v = (g.index.values, g.o.values, g.h.values, g.l.values, g.c.values, g.v.values)
        reg = t >= OPEN
        cpv = np.cumsum(np.where(reg, (h + l + c) / 3 * v, 0)); cv = np.cumsum(np.where(reg, v, 0))
        vwap = np.where(cv > 0, cpv / np.maximum(cv, 1e-9), np.nan)
        vavg20 = pd.Series(v).shift(1).rolling(20, min_periods=10).mean().values
        dv5 = pd.Series(c * v).rolling(5).sum().values
        hi15 = pd.Series(h).shift(1).rolling(15).max().values
        spread = float(np.median(sp[s])) if len(sp.get(s, [])) >= 5 else gsp
        bars[s] = (t, o, h, l, c)
        for i in range(20, len(c) - 1):
            if not reg[i]: continue
            tmin = (t[i] - OPEN) / MIN
            if tmin < CFG['entry']['noEntryFirstMin'] or t[i] >= CLOSE - CFG['entry']['noEntryLastMin'] * MIN: continue
            rows.append((s, int(t[i]), i, c[i], c[i] / prev[s] - 1, c[i] / vwap[i] - 1, v[i] / vavg20[i] if vavg20[i] > 0 else np.nan,
                         c[i] / c[i - 5] - 1, dv5[i], float(c[i] > hi15[i]), spread, tmin, float(t[i] < rec0)))
    df = pd.DataFrame(rows, columns=['sym', 't', 'i', 'c', 'gain', 'dVWAP', 'vr1', 'r5', 'dv5', 'brk15', 'spread', 'tmin', 'rec_before'])
    df['day'] = meta['date']
    return df, bars, CLOSE - CFG['exit']['flattenBeforeCloseMin'] * MIN


def exit_trade(bar, i, spd, T, S, H, tend, limit_min=0):
    """limit_min=0: 다음 봉 시가에 매도호가로 바로 삼(시장가). limit_min>0: 매수호가에 지정가를 걸고
    그 아래로 거래가 찍혀야(저가 < 지정가) 체결, limit_min분 안에 안 되면 취소 → None.
    지정가 매수는 익절도 미리 걸어 둔 지정가 매도로 봄(고가 > 목표가일 때만 체결). 손절·시간 청산은 매수호가에 시장가."""
    t, o, h, l, c = bar; n = len(c)
    if limit_min:
        lim = o[i + 1] * (1 - spd / 2); k = next((x for x in range(i + 1, min(i + 1 + limit_min, n)) if l[x] < lim), None)
        if k is None: return None, int(t[min(i + limit_min, n - 1)]), 'unfilled'
        e = ent = lim; start = k
    else:
        e = o[i + 1]; ent = e * (1 + spd / 2); start = i + 1
    tgt, stp = e * (1 + T), e * (1 - S)
    last = min(start + H - 1, n - 1)
    while last > start and t[last] > tend: last -= 1
    for x in range(start, last + 1):
        if l[x] <= stp: return (min(o[x], stp) if x > start else stp) * (1 - spd / 2) / ent - 1 - FEE, int(t[x]), 'stop'
        if (h[x] > tgt) if limit_min else (h[x] >= tgt):
            px = tgt if limit_min else (max(o[x], tgt) if x > start else tgt) * (1 - spd / 2)
            return px / ent - 1 - FEE, int(t[x]), 'target'
    return c[last] * (1 - spd / 2) / ent - 1 - FEE, int(t[last]), 'time'


def run(D, mask, bars, tend, T, S, H, rng=None, limits=True, limit_min=0):
    cool = CFG['entry']['cooldownMin'] * MIN; nostop = CFG['entry'].get('noReentryAfterStop', False)
    idx = np.flatnonzero(mask)
    if rng is not None: idx = idx[np.lexsort((rng.random(len(idx)), D.t.values[idx]))]
    busy, dead, openpos, res = {}, set(), [], []
    maxpos = CFG['maxPositions'] if limits else 10**9; maxtr = CFG['maxTradesPerDay'] if limits else 10**9
    for j in idx:
        r = D.iloc[j]
        if r.sym in dead or r.t < busy.get(r.sym, 0) or len(res) >= maxtr: continue
        openpos = [x for x in openpos if x > r.t]
        if len(openpos) >= maxpos: continue
        y, tx, kind = exit_trade(bars[r.sym], int(r.i), r.spread, T, S, H, tend, limit_min)
        if y is None: busy[r.sym] = tx + MIN; continue  # 지정가 미체결 → 취소 후 다시 신호 기다림
        res.append((r.sym, y, kind, r.rec_before, r.tmin)); busy[r.sym] = tx + cool; openpos.append(tx)
        if nostop and kind == 'stop': dead.add(r.sym)
    return pd.DataFrame(res, columns=['sym', 'y', 'kind', 'rec_before', 'tmin'])


def main():
    base = os.path.join(ROOT, 'data', 'recordings')
    days = sys.argv[1:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, '_meta.json')))
    V = CFG['vwapDip']; X = {**CFG['exit'], **next(s for s in CFG['strategies'] if s['signal'] == 'vwapDip').get('exit', {})}
    T, S, H = X['takeProfitPct'], X['stopLossPct'], X['maxHoldMinutes']
    pos_usd = CFG['seedUsd'] * CFG['positionPct']
    rng = np.random.default_rng(0)
    rules = {
        '아무 때나 (기준)': lambda D: np.ones(len(D), bool),
        '추격: 1분 거래량 2배↑ & 5분 +1.5%↑': lambda D: (D.vr1 >= 2).values & (D.r5 >= 0.015).values,
        '추격: 15분 신고가 돌파': lambda D: (D.brk15 == 1).values,
        f'F: VWAP {V["minBelowVwapPct"]*100:.0f}%↓ & 5분 -{V["minDrop5mPct"]*100:.1f}%↓': lambda D: (D.dVWAP <= -V['minBelowVwapPct']).values & (D.r5 <= -V['minDrop5mPct']).values,
    }
    LIM = round(CFG.get('limitOrder', {}).get('waitSec', 180) / 60)
    rules = {k: (f, 0) for k, f in rules.items()}
    rules[f'G: F + 지정가({LIM}분 대기)'] = (rules[next(k for k in rules if k.startswith('F:'))][0], LIM)
    print(f'청산: 익절 +{T*100:.0f}% / 손절 -{S*100:.0f}% / 최대 {H}분, 왕복 비용 = 스프레드 + {FEE*100:.2f}%, 한 번에 ${pos_usd:.0f}, 동시 {CFG["maxPositions"]}종목, 하루 {CFG["maxTradesPerDay"]}회')
    allres = {k: [] for k in rules}
    for day in days:
        df, bars, tend = load_day(os.path.join(base, day))
        U = df[(df.gain >= CFG['universe']['minChangeRate']) & (df.c >= CFG['universe']['minPrice']) & (df.c <= CFG['universe']['maxPrice']) & (df.dv5 >= V['minDollarVol5m'])].reset_index(drop=True)
        print(f'\n=== {day}: 감시 대상 {U.sym.nunique()}종목, {len(U)}분 (녹화 전 구간 {int(U.rec_before.sum())}분) ===')
        for name, (f, lm) in rules.items():
            m = f(U)
            # (1) 봇과 같은 제약(동시 3종목, 하루 15회). 동시에 뜬 신호 중 어느 걸 먼저 잡을지는 섞어서 30번
            sims = [run(U, m, bars, tend, T, S, H, rng, limit_min=lm) for _ in range(30)]
            pnl = np.array([x.y.sum() * pos_usd for x in sims])
            # (2) 제약 없이 신호마다 다 샀다면 (종목별 재진입 규칙만) — 표본을 늘려 규칙 자체의 성과를 봄
            R = run(U, m, bars, tend, T, S, H, limits=False, limit_min=lm); allres[name].append(R.assign(day=day))
            seg = lambda X: f'{len(X)}건 {X.y.mean()*100:+.2f}%' if len(X) else '0건'
            print(f'{name:32} | 봇 제약: 하룻밤 ${pnl.mean():+6.2f} (10~90% ${np.percentile(pnl, 10):+.2f}~${np.percentile(pnl, 90):+.2f})'
                  f' | 신호 전부: {len(R)}건 평균 {R.y.mean()*100:+5.2f}% 승률 {(R.y > 0).mean()*100:3.0f}% (녹화 전 {seg(R[R.rec_before == 1])}, 녹화 구간 {seg(R[R.rec_before == 0])}) | 청산 {R.kind.value_counts().to_dict()}')
    if True:
        print('\n=== 전체 날짜 합산 (신호 전부), 종목을 다시 뽑아 본 90% 구간 ===')
        for name, L in allres.items():
            R = pd.concat(L); g = R.groupby(['day', 'sym']).y.agg(['sum', 'count']); s, c = g['sum'].values, g['count'].values; k = len(g)
            bs = [s[ix].sum() / c[ix].sum() for ix in (rng.integers(0, k, k) for _ in range(3000))] if k else [np.nan]
            print(f'{name:32} | {len(R):>3}건 평균 {R.y.mean()*100:+5.2f}% | 90% 구간 {np.percentile(bs, 5)*100:+.2f}~{np.percentile(bs, 95)*100:+.2f}% | 플러스일 확률 {np.mean(np.array(bs) > 0)*100:.0f}%')
    print('\n읽는 법: 90% 구간이 0을 넘어서 양쪽 다 플러스여야 "운이 아니다"에 가까워요. 하루치로는 거의 항상 0을 걸쳐요.')


if __name__ == '__main__':
    main()
