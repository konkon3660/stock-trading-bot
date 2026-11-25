# 당일매매 규칙 탐색: 진입 13 × 청산 15 × (조건 1~2개) — 찾기 기간에서만 고르고, 확인 기간으로 거름. 최종 기간은 여기서 안 봄
import os
import sys, json, numpy as np, itertools, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import *
Z = load(); d = Z['d']; N = len(d)
DISC = d < '2025-11-01'; VAL = (d >= '2025-11-01') & (d < '2026-05-01'); HOLD = d >= '2026-05-01'
F0 = {k[2:]: Z[k].astype(float) for k in Z if k.startswith('F_')}
ENTRIES = list(ENTRY_KIND)

def feats(en):
    F = dict(F0); je = Z[f'{en}__je']
    F['ret_open'] = Z[f'{en}__ret_open']; F['vwd'] = Z[f'{en}__vwd']; F['cvol'] = Z[f'{en}__cvol']; F['tmin'] = je.astype(float)
    for k in ('r30', 'rv30', 'or30'): F[k] = np.where(je >= 30, F[k], np.nan)  # 첫 30분 정보는 10:00 이후 진입에서만 씀 (미래 정보 차단)
    return F

def conditions(en):
    F = feats(en); tr = Z[f'{en}__je'] >= 0; base = DISC & tr; C = []; M = []
    for k, v in F.items():
        if k == 'dow':
            for x in range(5): C.append((k, '==', x)); M.append(v == x)
            continue
        if k == 'rank_rv5':
            for x in (3, 5, 10, 20): C.append((k, '<=', x)); M.append(v <= x)
            continue
        vv = v[base & ~np.isnan(v)]
        if len(vv) < 100 or np.unique(vv).size < 5: continue
        for q in (0.2, 0.4, 0.6, 0.8):
            th = float(np.quantile(vv, q))
            C.append((k, '>=', th)); M.append(v >= th)
            C.append((k, '<', th)); M.append(v < th)
    return C, np.array(M)

def rule_mask(en, conds):
    F = feats(en); m = Z[f'{en}__je'] >= 0
    for k, op, th in conds:
        v = F[k]; m = m & (v >= th if op == '>=' else v < th if op == '<' else v <= th if op == '<=' else v == th)
    return m

def evaluate(en, ex, conds, period, k=1.0, mode='px'):
    m = rule_mask(en, conds) & period; r = net(Z, en, ex, k, mode)[m]
    mu, t, nd = daystat(r, d[m]); return dict(n=int(m.sum()), days=nd, mean=mu, t=t)

if __name__ == '__main__':
    t0 = time.time(); found = []; tested = 0
    for en in ENTRIES:
        C, A = conditions(en); K = len(C); tr = (Z[f'{en}__je'] >= 0) & DISC
        idx = np.where(tr)[0]; idx = idx[np.argsort(d[idx], kind='stable')]
        R = np.stack([net(Z, en, ex)[idx] for ex in EXITS], 1)  # n × 15
        Aa = A[:, idx].astype(np.float64); dd = d[idx]
        S1 = np.zeros((len(EXITS), K, K)); S2 = np.zeros_like(S1); CD = np.zeros((K, K)); NT = np.zeros((K, K))
        cuts = np.flatnonzero(np.r_[True, dd[1:] != dd[:-1], True])
        for a, b in zip(cuts[:-1], cuts[1:]):
            Ad = Aa[:, a:b]; Rd = R[a:b]; Nd = Ad @ Ad.T
            Sd = (Ad[None, :, :] * Rd.T[:, None, :]) @ Ad.T  # 15 × K × K
            has = Nd > 0; md = np.where(has, Sd / np.maximum(Nd, 1), 0)
            S1 += md; S2 += md * md; CD += has; NT += Nd
        with np.errstate(invalid='ignore', divide='ignore'):
            mu = S1 / CD; var = (S2 - CD * mu * mu) / (CD - 1); tt = mu / np.sqrt(var / CD)
        iu = np.triu_indices(K)
        for xi, ex in enumerate(EXITS):
            m_, t_, cd_, nt_ = mu[xi][iu], tt[xi][iu], CD[iu], NT[iu]
            ok = (nt_ >= 150) & (cd_ >= 60) & np.isfinite(t_)
            tested += int(ok.sum())
            for j in np.where(ok & (t_ > 2.0))[0]:
                a, b = iu[0][j], iu[1][j]
                conds = [C[a]] if a == b else [C[a], C[b]]
                found.append(dict(en=en, ex=ex, conds=conds, n=int(nt_[j]), days=int(cd_[j]), mean=float(m_[j]), t=float(t_[j])))
        print(en, 'K', K, '누적 후보', len(found), f'{time.time()-t0:.0f}s', flush=True)
    found.sort(key=lambda x: -x['t'])
    json.dump(dict(tested=tested, found=found), open(W + '/found_intra.json', 'w'))
    print('시험한 규칙', tested, '찾기 기간 t>2', len(found))
