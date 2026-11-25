# 복잡한 규칙(기계학습): 진입·청산 방식마다 찾기 기간으로 학습 → 확인 기간에서 '예측 상위' 거래만 했을 때 결과
import os
import sys, json, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_intra import *
from sklearn.ensemble import HistGradientBoostingRegressor
res = []
for en in ENTRIES:
    Fe = feats(en); tr0 = (Z[f'{en}__je'] >= 0) & DISC; keys = [k for k in sorted(Fe) if np.unique(Fe[k][tr0 & ~np.isnan(Fe[k])]).size > 3]; X = np.column_stack([Fe[k] for k in keys]); tr = Z[f'{en}__je'] >= 0
    for ex in EXITS:
        y = net(Z, en, ex); a = tr & DISC & np.isfinite(y); b = tr & VAL & np.isfinite(y)
        if a.sum() < 500: continue
        yc = np.clip(y, -0.2, 0.2)
        mdl = HistGradientBoostingRegressor(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=80, l2_regularization=1.0, random_state=0)
        mdl.fit(X[a], yc[a]); pa = mdl.predict(X[a]); pb = mdl.predict(X[b])
        row = dict(en=en, ex=ex, n_disc=int(a.sum()))
        for q in (0.9, 0.97):
            th = np.quantile(pa, q); m = pb >= th
            mu, t, nd = daystat(y[b][m], d[b][m]) if m.sum() > 5 else (np.nan, np.nan, 0)
            row[f'q{q}'] = dict(th=float(th), n=int(m.sum()), mean=float(mu), t=float(t), days=int(nd))
        res.append(row)
    print(en, flush=True)
json.dump(res, open(W + '/ml_intra.json', 'w'))
for q in ('q0.9', 'q0.97'):
    v = np.array([r[q]['mean'] for r in res]); t = np.array([r[q]['t'] for r in res])
    print(f'{q}: {len(res)}개 중 확인 기간 플러스 {np.nanmean(v>0)*100:.0f}%, t>2 {np.nansum(t>2)}개, 평균 {np.nanmean(v)*100:+.2f}%')
best = sorted(res, key=lambda r: -np.nan_to_num(r['q0.9']['t'], nan=-9))[:12]
for r in best: print(f"{r['en']:7}{r['ex']:10} 상위10%: {r['q0.9']['n']:4}건 {r['q0.9']['mean']*100:+.2f}% t={r['q0.9']['t']:.1f} | 상위3%: {r['q0.97']['n']:4}건 {r['q0.97']['mean']*100:+.2f}% t={r['q0.97']['t']:.1f}")
