# 하따(크게 빠진 종목 사서 반등 노리기) — 미리 정한 규칙만 시험
#   진입 A(지정가): 장 전에 전일 종가×(1-X)에 매수 주문 → 정규장 저가가 그 아래면 체결 (시가가 더 낮으면 시가)
#   진입 B(종가): 종가가 전일 종가×(1-X) 이하이면 종가에 매수
#   X = 15/20/30/40/50%, 청산 = 당일 종가(A만), 다음 날 시가, 다음 날 종가, 3일 뒤 종가, 5일 뒤 종가
#   후보: 전일 종가 $1 이상, 전일까지 20일 평균 거래대금 $100만 이상, 토스 종류가 ETF·ETN인 것 제외
#   비용: 수수료 0.1%씩 + 매도 0.03%, 스프레드 max(0.8%, 2센트/가격)를 시장가 쪽에서 반씩 (지정가 진입은 스프레드 없음)
import os, sys, json, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT, DATA
Z = np.load(OUT + '/panel.npz'); days = Z['days']; tick = Z['tick']
O, H, L, C, V = [Z[k].astype(np.float64) for k in 'ohlcv']; nD, nT = C.shape
types = json.load(open(DATA + '/stock_types.json'))
bad = np.array([(types.get(t) if isinstance(types.get(t), str) else (types.get(t) or {}).get('type')) in ('ETF', 'ETN') for t in tick])
pc = np.vstack([np.full((1, nT), np.nan), C[:-1]])
dv = np.nan_to_num(C * V); cnt = (~np.isnan(C)).astype(float)
cs = np.cumsum(dv, 0); cc = np.cumsum(cnt, 0)
dv20 = np.full((nD, nT), np.nan); dv20[21:] = (cs[20:-1] - cs[:-21]) / np.maximum(cc[20:-1] - cc[:-21], 1)  # 전일까지 20일
U = (pc >= 1) & (dv20 >= 1e6) & ~bad[None, :] & ~np.isnan(O)
def at(a, k): return np.vstack([a[k:], np.full((k, nT), np.nan)])
Cf = C.copy()
for i in range(1, nD): Cf[i] = np.where(np.isnan(Cf[i]), Cf[i - 1], Cf[i])
EXIT = {'당일종가': C, '다음날시가': np.where(np.isnan(at(O, 1)), at(Cf, 1), at(O, 1)), '다음날종가': at(Cf, 1), '3일뒤': at(Cf, 3), '5일뒤': at(Cf, 5)}
def spread(p, k): return np.maximum(0.008, 0.02 / p) * k
def nw_t(x, lags):
    x = np.asarray(x); n = len(x); e = x - x.mean(); v = e @ e / n
    for l in range(1, lags): v += 2 * (1 - l / lags) * (e[l:] @ e[:-l]) / n
    return x.mean() / np.sqrt(max(v, 1e-18) / n)
PER = {'찾기': (days < '2025-10-17'), '확인': (days >= '2025-11-01') & (days < '2026-04-16'), '최종': (days >= '2026-05-01')}
PER['찾기'] &= days >= days[22]
LAG = {'당일종가': 1, '다음날시가': 1, '다음날종가': 1, '3일뒤': 3, '5일뒤': 5}
def run(entry, X, ex, k=1.0, periods=PER, show=True):
    lvl = pc * (1 - X)
    if entry == 'A':
        hit = U & (L < lvl); pe = np.fmin(O, lvl); buy = pe * 1.001
    else:
        if ex == '당일종가': return None
        hit = U & (C <= lvl); pe = C; buy = pe * (1 + spread(pe, k) / 2) * 1.001
    px = EXIT[ex]; sell = px * (1 - spread(pe, k) / 2) * (1 - 0.0013); r = sell / buy - 1
    hit &= np.isfinite(r); out = {}
    for pn, pm in periods.items():
        m = hit & pm[:, None]; ii, jj = np.where(m)
        if len(ii) < 20: out[pn] = None; continue
        rr = r[ii, jj]; u, inv = np.unique(ii, return_inverse=True); dm = np.bincount(inv, rr) / np.bincount(inv)
        gross = (px / pe - 1)[ii, jj]
        out[pn] = dict(n=len(rr), days=len(u), mean=dm.mean(), t=nw_t(dm, LAG[ex]), win=np.mean(rr > 0), gross=np.mean(gross), med=np.median(rr))
    return out
if __name__ == '__main__':
    print('후보 종목-일', int(U.sum()))
    rows = []
    for entry in 'AB':
        for X in (0.15, 0.2, 0.3, 0.4, 0.5):
            for ex in EXIT:
                o = run(entry, X, ex)
                if o is None: continue
                rows.append((entry, X, ex, o))
                s = ' | '.join(f"{pn} {v['n']:5}건 {v['mean']*100:+.2f}% (t={v['t']:+.1f}, 비용전 {v['gross']*100:+.2f}%)" if v else f'{pn} -' for pn, v in o.items() if pn != '최종')
                print(f"{'지정가' if entry=='A' else '종가'} -{int(X*100)}% {ex:6} {s}")
    json.dump([(a, b, c, {k: (v and {kk: float(vv) for kk, vv in v.items()}) for k, v in o.items() if k != '최종'}) for a, b, c, o in rows], open(OUT + '/hatta_disc_val.json', 'w'), ensure_ascii=False)
