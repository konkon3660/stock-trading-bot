# 며칠 보유 규칙 탐색: 청산 13가지 × (조건 1~2개). 찾기 기간에서 고르고 확인 기간으로 거름 (최종 기간은 안 봄)
import sys, json, numpy as np, time, warnings; warnings.filterwarnings('ignore')
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT as W, DATA
Z = np.load(W + '/daily.npz'); Z = {k: Z[k] for k in Z.files}; d = Z['d']
DISC = d < '2025-10-17'; VAL = (d >= '2025-11-01') & (d < '2026-04-16'); HOLD = d >= '2026-05-01'   # 사이 2주는 보유 기간이 겹치지 않게 비움
F = {k[2:]: Z[k].astype(float) for k in Z if k.startswith('F_')}
EX_C = ['h1', 'h2', 'h3', 'h5', 'h10', 'on', 'sma5x', 'hix', 'st1h5', 'tp1st1h5']; EX_O = ['oc1', 'oc3', 'oc5']; EXITS = EX_C + EX_O
HOLD_DAYS = dict(h1=1, h2=2, h3=3, h5=5, h10=10, on=1, sma5x=5, hix=3, st1h5=5, tp1st1h5=5, oc1=1, oc3=3, oc5=5)
def spread(px): return np.maximum(0.001, 0.02 / px)
def net(ex, k=1.0):
    if ex in EX_O:
        pe = Z['pe_o']; s = spread(pe) * k; buy = pe * (1 + s / 2 + 0.001 * k) * 1.001; kind = np.zeros(len(pe))
    else:
        pe = Z['pe']; s = spread(pe) * k; buy = pe * (1 + s / 2) * 1.001; kind = Z['k_' + ex]
    px = Z['x_' + ex]
    sell = px * (1 - np.where(kind == 2, 0, s / 2)) * (1 - np.where(kind == 1, 0.003 * k, 0)) * (1 - 0.0013)
    r = sell / buy - 1
    return np.where(np.isfinite(r), r, np.nan)
def conditions():
    C, M = [], []
    for k, v in F.items():
        if k == 'dow':
            for x in range(5): C.append((k, '==', x)); M.append(v == x)
            continue
        vv = v[DISC & ~np.isnan(v)]
        if np.unique(vv).size < 5: continue
        qs = (0.1, 0.2, 0.4, 0.6, 0.8, 0.9)
        for q in qs:
            th = float(np.quantile(vv, q)); C.append((k, '>=', th)); M.append(v >= th); C.append((k, '<', th)); M.append(v < th)
    return C, np.array(M)
def rule_mask(conds):
    m = np.ones(len(d), bool)
    for k, op, th in conds:
        v = F[k]; m &= (v >= th if op == '>=' else v < th if op == '<' else v == th)
    return m
def nw_t(x, lags):  # Newey-West t (보유 기간이 겹쳐 생기는 자기상관 보정)
    x = np.asarray(x); n = len(x); mu = x.mean(); e = x - mu; v = e @ e / n
    for l in range(1, lags):
        w = 1 - l / lags; v += 2 * w * (e[l:] @ e[:-l]) / n
    return mu / np.sqrt(max(v, 1e-18) / n)
def evaluate(ex, conds, period, k=1.0):
    m = rule_mask(conds) & period; r = net(ex, k); m &= ~np.isnan(r); r = r[m]
    u, inv = np.unique(d[m], return_inverse=True)
    if len(u) < 3: return dict(n=int(m.sum()), days=len(u), mean=np.nan, t=np.nan)
    dm = np.bincount(inv, r) / np.bincount(inv)
    return dict(n=int(m.sum()), days=len(u), mean=float(dm.mean()), t=float(nw_t(dm, HOLD_DAYS[ex])), med=float(np.median(r)), win=float(np.mean(r > 0)))
if __name__ == '__main__':
    t0 = time.time(); C, A = conditions(); K = len(C); print('조건', K)
    idx = np.where(DISC)[0]; idx = idx[np.argsort(d[idx], kind='stable')]
    R = np.stack([net(ex)[idx] for ex in EXITS], 1); okr = ~np.isnan(R)
    R = np.nan_to_num(R)
    Aa = A[:, idx].astype(np.float32); dd = d[idx]
    S1 = np.zeros((len(EXITS), K, K)); S2 = np.zeros_like(S1); CD = np.zeros((K, K)); NT = np.zeros((K, K))
    cuts = np.flatnonzero(np.r_[True, dd[1:] != dd[:-1], True])
    for a, b in zip(cuts[:-1], cuts[1:]):
        Ad = Aa[:, a:b]; Nd = (Ad @ Ad.T).astype(np.float64)
        Sd = np.stack([((Ad * R[a:b, x][None, :].astype(np.float32)) @ Ad.T) for x in range(len(EXITS))]).astype(np.float64)
        has = Nd > 0; md = np.where(has, Sd / np.maximum(Nd, 1), 0)
        S1 += md; S2 += md * md; CD += has; NT += Nd
    mu = S1 / CD; var = (S2 - CD * mu * mu) / (CD - 1); tt = mu / np.sqrt(var / CD)
    iu = np.triu_indices(K); found = []; tested = 0
    for xi, ex in enumerate(EXITS):
        m_, t_, cd_, nt_ = mu[xi][iu], tt[xi][iu], CD[iu], NT[iu]
        ok = (nt_ >= 150) & (cd_ >= 60) & np.isfinite(t_); tested += int(ok.sum())
        sel = np.where(ok & (m_ > 0))[0]; sel = sel[np.argsort(-t_[sel])][:400]
        for j in sel:
            a, b = iu[0][j], iu[1][j]
            found.append(dict(ex=ex, conds=[C[a]] if a == b else [C[a], C[b]], n=int(nt_[j]), days=int(cd_[j]), mean=float(m_[j]), t=float(t_[j])))
        print(ex, '플러스 규칙', int((ok & (m_ > 0)).sum()), '/', int(ok.sum()), f'{time.time()-t0:.0f}s', flush=True)
    json.dump(dict(tested=tested, found=found), open(W + '/found_daily.json', 'w')); print('시험', tested)
