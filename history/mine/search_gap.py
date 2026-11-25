# 갭상승 급등주 규칙 탐색: 진입 17 × 청산 16 × (조건 1~2개, 프리장 특징 포함). 찾기 기간에서만 고름
import os, sys, json, time, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT
Z = np.load(OUT + '/gap.npz'); Z = {k: Z[k] for k in Z.files}; M = json.load(open(OUT + '/gap_meta.json'))
d = Z['d']; ENTRIES = list(M['entries']); EXITS = M['exits']; GATE = M['gate']
DISC = d < '2025-11-01'; VAL = (d >= '2025-11-01') & (d < '2026-05-01'); HOLD = d >= '2026-05-01'
F0 = {k[2:]: Z[k].astype(float) for k in Z if k.startswith('F_')}
def feats(en):
    je = Z[f'{en}__je'].astype(float); F = dict(F0); F['ret_open'] = Z[f'{en}__ret_open']; F['vwd'] = Z[f'{en}__vwd']; F['tmin'] = je
    for k, g in GATE.items(): F[k] = np.where(je >= g, F[k], np.nan)   # 진입 전에 알 수 없는 값은 가림
    return F
CLIP = 0.5  # 고를 때는 거래당 ±50%로 잘라 극단값 한두 건이 규칙을 끌고 가지 않게
def net(en, ex, k=1.0, clip=CLIP):
    pe = Z[f'{en}__pe']; px = Z[f'{en}__x_{ex}']; kx = Z[f'{en}__k_{ex}']; kind = M['entries'][en]
    s = np.maximum(0.008, 0.01 / pe) * k   # 급등주 실측 스프레드 중간값 0.8%, $1대는 1센트
    buy = pe * (1 + (0 if kind == 'lmt' else s / 2 + 0.002 * k)) * 1.001
    sell = px * (1 - np.where(kx == 2, 0, s / 2)) * (1 - np.where(kx == 1, 0.005 * k, 0)) * (1 - 0.0013)
    r = sell / buy - 1; r = np.clip(r, -clip, clip) if clip else r; return np.where(np.isfinite(r), r, np.nan)
def daystat(r, dd):
    ok = ~np.isnan(r); r, dd = r[ok], dd[ok]
    u, inv = np.unique(dd, return_inverse=True)
    if len(u) < 3: return np.nan, np.nan, len(u)
    m = np.bincount(inv, r) / np.bincount(inv); return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(len(m))), len(m)
def conditions(en):
    F = feats(en); base = DISC & (Z[f'{en}__je'] >= 0); C, A = [], []
    for k, v in F.items():
        if k == 'dow':
            for x in range(5): C.append((k, '==', x)); A.append(v == x)
            continue
        vv = v[base & ~np.isnan(v)]
        if len(vv) < 60 or np.unique(vv).size < 5: continue
        for q in (0.2, 0.4, 0.6, 0.8):
            th = float(np.quantile(vv, q)); C.append((k, '>=', th)); A.append(v >= th); C.append((k, '<', th)); A.append(v < th)
    return C, np.array(A)
def rule_mask(en, conds):
    F = feats(en); m = Z[f'{en}__je'] >= 0
    for k, op, th in conds: v = F[k]; m = m & (v >= th if op == '>=' else v < th if op == '<' else v == th)
    return m
def evaluate(en, ex, conds, period, k=1.0, clip=CLIP):
    m = rule_mask(en, conds) & period; r = net(en, ex, k, clip)[m]; mu, t, nd = daystat(r, d[m])
    g = (Z[f'{en}__x_{ex}'] / Z[f'{en}__pe'] - 1)[m]
    return dict(n=int(np.isfinite(r).sum()), days=nd, mean=mu, t=t, gross=float(np.nanmean(g)) if len(g) else np.nan, win=float(np.nanmean(r > 0)) if len(r) else np.nan)
if __name__ == '__main__':
    t0 = time.time(); found = []; tested = 0
    for en in ENTRIES:
        C, A = conditions(en); K = len(C); tr = (Z[f'{en}__je'] >= 0) & DISC
        idx = np.where(tr)[0]; idx = idx[np.argsort(d[idx], kind='stable')]
        R = np.stack([net(en, ex)[idx] for ex in EXITS], 1); okR = ~np.isnan(R); R = np.nan_to_num(R)
        Aa = A[:, idx].astype(np.float64); dd = d[idx]
        S1 = np.zeros((len(EXITS), K, K)); S2 = np.zeros_like(S1); CD = np.zeros_like(S1); NT = np.zeros_like(S1)
        cuts = np.flatnonzero(np.r_[True, dd[1:] != dd[:-1], True])
        for a, b in zip(cuts[:-1], cuts[1:]):
            Ad = Aa[:, a:b]
            for x in range(len(EXITS)):
                w = okR[a:b, x].astype(float); Nd = (Ad * w) @ Ad.T; Sd = (Ad * (R[a:b, x] * w)) @ Ad.T
                has = Nd > 0; md = np.where(has, Sd / np.maximum(Nd, 1), 0)
                S1[x] += md; S2[x] += md * md; CD[x] += has; NT[x] += Nd
        mu = S1 / CD; var = (S2 - CD * mu * mu) / (CD - 1); tt = mu / np.sqrt(var / CD); iu = np.triu_indices(K)
        for xi, ex in enumerate(EXITS):
            m_, t_, cd_, nt_ = mu[xi][iu], tt[xi][iu], CD[xi][iu], NT[xi][iu]
            ok = (nt_ >= 80) & (cd_ >= 40) & np.isfinite(t_); tested += int(ok.sum())
            for j in np.where(ok & (t_ > 2.0))[0]:
                a, b = iu[0][j], iu[1][j]
                found.append(dict(en=en, ex=ex, conds=[C[a]] if a == b else [C[a], C[b]], n=int(nt_[j]), days=int(cd_[j]), mean=float(m_[j]), t=float(t_[j])))
        print(en, K, len(found), f'{time.time()-t0:.0f}s', flush=True)
    found.sort(key=lambda f: -f['t']); json.dump(dict(tested=tested, found=found), open(OUT + '/found_gap.json', 'w'))
    print('시험', tested, '찾기 t>2', len(found))
