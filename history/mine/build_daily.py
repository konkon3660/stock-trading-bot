# 며칠 보유(스윙) 규칙 탐색용 표: 전 종목 일봉(저가 $30 이하만 저장된 파일) → (날짜, 종목)별 특징값 + 청산 방식별 결과
# 진입: 그날 종가(c) 또는 다음 날 시가. 특징값은 모두 그날 종가까지의 정보만 씀
import json, numpy as np, warnings; warnings.filterwarnings('ignore')
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT as W, DATA
Z = np.load(W + '/panel.npz'); days = Z['days']; tick = Z['tick']
O, H, L, C, V = [Z[k].astype(np.float64) for k in 'ohlcv']
nD = len(days)
dv = C * V
def rmean(a, w):  # 날짜 방향 이동평균 (NaN 무시, 최소 w*0.8개)
    out = np.full_like(a, np.nan); x = np.nan_to_num(a); n = (~np.isnan(a)).astype(float)
    cs = np.cumsum(x, 0); cn = np.cumsum(n, 0)
    s = cs[w - 1:] - np.vstack([np.zeros((1, a.shape[1])), cs[:-w]]); c = cn[w - 1:] - np.vstack([np.zeros((1, a.shape[1])), cn[:-w]])
    out[w - 1:] = np.where(c >= w * 0.8, s / np.maximum(c, 1), np.nan); return out
def rmax(a, w):
    out = np.full_like(a, np.nan)
    for i in range(w - 1, len(a)): out[i] = np.nanmax(a[i - w + 1:i + 1], 0)
    return out
def rmin(a, w):
    out = np.full_like(a, np.nan)
    for i in range(w - 1, len(a)): out[i] = np.nanmin(a[i - w + 1:i + 1], 0)
    return out
dv20 = rmean(dv, 20)
keepT = np.where(np.nanmax(np.where(np.isnan(dv20), 0, dv20), 0) >= 5e6)[0]
O, H, L, C, V, dv, dv20 = [a[:, keepT] for a in (O, H, L, C, V, dv, dv20)]; tick = tick[keepT]; nT = len(tick)
print('종목', nT)
Cf = C.copy()  # 빈 날은 직전 종가로 (청산가 계산용)
for i in range(1, nD): Cf[i] = np.where(np.isnan(Cf[i]), Cf[i - 1], Cf[i])
pc = np.vstack([np.full((1, nT), np.nan), C[:-1]])
tr = np.fmax(H, pc) - np.fmin(L, pc); atr = rmean(tr, 14)
def lag(a, k): return np.vstack([np.full((k, nT), np.nan), a[:-k]])
F = {}
for k in (1, 2, 3, 5, 10, 20, 60): F[f'ret{k}'] = C / lag(C, k) - 1
d1 = C - pc; up = np.where(d1 > 0, d1, 0); dn = np.where(d1 < 0, -d1, 0)
ru, rd = rmean(up, 2), rmean(dn, 2); F['rsi2'] = 100 * ru / np.maximum(ru + rd, 1e-12)
st = np.zeros((nD, nT))
for i in range(1, nD):
    s = np.sign(np.nan_to_num(d1[i])); st[i] = np.where(s > 0, np.where(st[i - 1] > 0, st[i - 1] + 1, 1), np.where(s < 0, np.where(st[i - 1] < 0, st[i - 1] - 1, -1), 0))
F['streak'] = st
for w in (5, 10, 20, 50): F[f'sma{w}'] = C / rmean(C, w) - 1
F['hi60'] = C / rmax(H, 60) - 1; F['lo60'] = C / rmin(L, 60) - 1
F['cloc'] = np.where(H > L, (C - L) / np.maximum(H - L, 1e-12), 0.5); F['rng_atr'] = (H - L) / lag(atr, 1)
F['vr'] = V / lag(rmean(V, 20), 1); F['gap'] = O / pc - 1; F['intr'] = C / O - 1; F['atrp'] = atr / C; F['px'] = C; F['dv20'] = dv20
j = list(tick).index('SCHB'); m = C[:, j]
mk = {'mkt_ret1': m / np.r_[np.nan, m[:-1]] - 1, 'mkt_ret5': m / np.r_[[np.nan] * 5, m[:-5]] - 1}
mm = np.convolve(np.nan_to_num(m), np.ones(20) / 20, 'full')[:nD]; mk['mkt_sma20'] = m / np.where(np.arange(nD) >= 19, mm, np.nan) - 1
for k, v in mk.items(): F[k] = np.repeat(v[:, None], nT, 1)
F['rel1'] = F['ret1'] - F['mkt_ret1']
# 후보: 종가 $3~25, 20일 평균 거래대금 $5M 이상, 오늘 거래 있음, 60일 이상 이력
U = (C >= 3) & (C <= 25) & (dv20 >= 5e6) & (V > 0) & ~np.isnan(F['ret60'])
U[:61] = False; U[nD - 1:] = False
# ETF·ETN(토스 종류 정보가 있는 것만) 제외
types = json.load(open(DATA + '/stock_types.json')); bad = np.array([(types.get(t) if isinstance(types.get(t), str) else (types.get(t) or {}).get('type')) in ('ETF', 'ETN') for t in tick])
U &= ~bad[None, :]
# 같은 날 안에서 순위·분위기
r1 = np.where(U, F['ret1'], np.nan); r5 = np.where(U, F['ret5'], np.nan)
def pct_rank(x):
    out = np.full_like(x, np.nan)
    for i in range(nD):
        v = x[i]; ok = ~np.isnan(v)
        if ok.sum() > 10: out[i, ok] = (v[ok].argsort().argsort() + 0.5) / ok.sum()
    return out
F['xr1'] = pct_rank(r1); F['xr5'] = pct_rank(r5)
br = np.nanmean(np.where(U, (F['ret1'] > 0).astype(float), np.nan), 1); F['breadth'] = np.repeat(br[:, None], nT, 1)
dow = np.array([np.datetime64(x).astype('datetime64[D]').astype(int) for x in days]); dow = (dow + 3) % 7  # 월=0
F['dow'] = np.repeat(dow[:, None].astype(float), nT, 1)
# ---------- 결과: 종가 진입 ----------
R = {}; K = {}  # K: 청산 종류 1=손절
def at(a, k):  # i+k 날 값 (없으면 NaN)
    return np.vstack([a[k:], np.full((k, nT), np.nan)])
for h in (1, 2, 3, 5, 10): R[f'h{h}'] = at(Cf, h); K[f'h{h}'] = 0
R['on'] = np.where(np.isnan(at(O, 1)), at(Cf, 1), at(O, 1)); K['on'] = 0
# 5일 평균 위로 마감하면 청산 (최대 10일)
sma5 = rmean(C, 5); ex = np.full((nD, nT), np.nan); done = np.zeros((nD, nT), bool)
for k in range(1, 11):
    c_k = at(C, k); s_k = at(sma5, k); hit = ~done & (c_k > s_k)
    ex = np.where(hit, c_k, ex); done |= hit
ex = np.where(done, ex, at(Cf, 10)); R['sma5x'] = ex; K['sma5x'] = 0
# 전날 고가 위로 마감하면 청산 (최대 5일)
ex = np.full((nD, nT), np.nan); done = np.zeros((nD, nT), bool)
for k in range(1, 6):
    c_k = at(C, k); h_p = at(H, k - 1); hit = ~done & (c_k > h_p)
    ex = np.where(hit, c_k, ex); done |= hit
R['hix'] = np.where(done, ex, at(Cf, 5)); K['hix'] = 0
# 손절 ATR×1 (최대 5일), 목표 +ATR×1·손절 ATR×1 (최대 5일). 같은 날 둘 다면 손절 먼저
for nm, tp in (('st1h5', None), ('tp1st1h5', 1.0)):
    s = C - atr; t = C + tp * atr if tp else None
    ex = np.full((nD, nT), np.nan); kind = np.zeros((nD, nT), np.int8); done = np.zeros((nD, nT), bool)
    for k in range(1, 6):
        o_k, l_k, h_k = at(O, k), at(L, k), at(H, k)
        hs = ~done & (l_k <= s); ex = np.where(hs, np.fmin(np.where(np.isnan(o_k), s, o_k), s), ex); kind = np.where(hs, 1, kind); done |= hs
        if tp:
            ht = ~done & (h_k > t); ex = np.where(ht, np.fmax(np.where(np.isnan(o_k), t, o_k), t), ex); kind = np.where(ht, 2, kind); done |= ht
    R[nm] = np.where(done, ex, at(Cf, 5)); K[nm] = kind
# ---------- 결과: 다음 날 시가 진입 ----------
R2 = {'oc1': at(Cf, 1), 'oc3': at(Cf, 3), 'oc5': at(Cf, 5)}
ii, jj = np.where(U)
out = dict(i=ii, j=jj, d=days[ii], T=tick[jj], pe=C[ii, jj], pe_o=at(O, 1)[ii, jj])
for k, v in F.items(): out['F_' + k] = v[ii, jj].astype(np.float32)
for k, v in R.items(): out['x_' + k] = v[ii, jj]; out['k_' + k] = (K[k][ii, jj] if isinstance(K[k], np.ndarray) else np.zeros(len(ii), np.int8))
for k, v in R2.items(): out['x_' + k] = v[ii, jj]
# 청산일 실제 종가가 없던 비율(저가 $30 넘음·상장폐지 등)
print('5일 뒤 종가 없음 비율', np.mean(np.isnan(at(C, 5)[ii, jj])))
np.savez_compressed(W + '/daily.npz', **out); print('행', len(ii))
