# 갭상승 급등주 기계학습: 진입·청산마다 찾기 기간 학습 → 확인 기간 예측 상위 20%만 매매
import os, sys, json, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_gap import *
from sklearn.ensemble import HistGradientBoostingRegressor
res = []
for en in ENTRIES:
    Fe = feats(en); tr = Z[f'{en}__je'] >= 0
    keys = [k for k in sorted(Fe) if np.unique(Fe[k][tr & DISC & ~np.isnan(Fe[k])]).size > 3]; X = np.column_stack([Fe[k] for k in keys])
    for ex in EXITS:
        y = net(en, ex); a = tr & DISC & np.isfinite(y); b = tr & VAL & np.isfinite(y)
        if a.sum() < 300: continue
        mdl = HistGradientBoostingRegressor(max_iter=100, learning_rate=0.05, max_leaf_nodes=8, min_samples_leaf=40, l2_regularization=1.0, random_state=0).fit(X[a], y[a])
        th = np.quantile(mdl.predict(X[a]), 0.8); m = mdl.predict(X[b]) >= th
        mu, t, nd = daystat(y[b][m], d[b][m]) if m.sum() > 5 else (np.nan, np.nan, 0)
        res.append(dict(en=en, ex=ex, n=int(m.sum()), mean=float(mu), t=float(t), base=float(np.nanmean(y[b]))))
v = np.array([r['mean'] for r in res]); t = np.array([r['t'] for r in res]); bs = np.array([r['base'] for r in res])
print(f'{len(res)}개 모형: 확인 기간 예측 상위 20% 플러스 {np.nanmean(v > 0)*100:.0f}%, 전체보다 나음 {np.nanmean(v > bs)*100:.0f}%, t>2 {np.nansum(t > 2)}개, 평균 {np.nanmean(v)*100:+.2f}%')
json.dump(res, open(OUT + '/ml_gap.json', 'w'))
