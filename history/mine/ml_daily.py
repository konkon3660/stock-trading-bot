import os
import sys, json, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_daily import *
from sklearn.ensemble import HistGradientBoostingRegressor
keys = sorted(F); X = np.column_stack([F[k] for k in keys]).astype(np.float32)
out = {}
for ex in ('h2', 'h3', 'h5', 'h10', 'oc3', 'oc5', 'sma5x', 'hix'):
    y = net(ex); a = DISC & np.isfinite(y); b = VAL & np.isfinite(y)
    # 같은 날 평균을 뺀 값(종목 고르는 실력)을 학습
    u, inv = np.unique(d, return_inverse=True); dm = np.bincount(inv[np.isfinite(y)], y[np.isfinite(y)], minlength=len(u)) / np.maximum(np.bincount(inv[np.isfinite(y)], minlength=len(u)), 1)
    yx = np.clip(y - dm[inv], -0.3, 0.3)
    mdl = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=300, l2_regularization=1.0, random_state=0)
    mdl.fit(X[a], yx[a]); pb = mdl.predict(X[b])
    # 확인 기간: 날마다 예측 상위 5종목만
    idx = np.where(b)[0]; rows = []
    for day in np.unique(d[idx]):
        ii = idx[d[idx] == day]; top = ii[np.argsort(-pb[d[idx] == day])[:5]]
        rows.append((y[top].mean(), y[ii].mean()))
    r = np.array(rows); x = r[:, 0] - r[:, 1]
    out[ex] = dict(top=float(r[:, 0].mean()), all=float(r[:, 1].mean()), ex=float(x.mean()), t_ex=float(nw_t(x, HOLD_DAYS[ex])), t_abs=float(nw_t(r[:, 0], HOLD_DAYS[ex])))
    print(f"{ex:6} 확인 기간: 예측 상위5 {out[ex]['top']*100:+.2f}% (t={out[ex]['t_abs']:.1f}) / 전체 {out[ex]['all']*100:+.2f}% / 초과 {out[ex]['ex']*100:+.2f}% (t={out[ex]['t_ex']:.1f})", flush=True)
json.dump(out, open(W + '/ml_daily.json', 'w'))
