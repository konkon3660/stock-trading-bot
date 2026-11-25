# 상위 규칙이 '그냥 다 사기'보다 나았는지 (같은 날 후보 전체 평균을 뺀 초과수익)
import os
import sys, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_daily import *
found = json.load(open(W + '/val_daily.json')); fmt = lambda c: ' & '.join(f'{k}{op}{th:.3g}' for k, op, th in c)
def excess(ex, conds, period):
    r = net(ex); ok = ~np.isnan(r) & period
    u, inv = np.unique(d[ok], return_inverse=True); base = np.bincount(inv, r[ok]) / np.bincount(inv)
    m = rule_mask(conds) & ok; um, invm = np.unique(d[m], return_inverse=True); rm = np.bincount(invm, r[m]) / np.bincount(invm)
    b = base[np.searchsorted(u, um)]; x = rm - b
    return x.mean(), nw_t(x, HOLD_DAYS[ex]) if len(x) > 3 else np.nan, len(x)
if __name__ == '__main__':
    # SCHB(시장 ETF) 그냥 들고 있기: h일 보유 평균 (비용 0.25% 가정)
    P = np.load(W + '/panel.npz'); days = list(P['days']); j = list(P['tick']).index('SCHB'); c = P['c'][:, j].astype(float)
    for h in (5, 10):
        r = c[h:] / c[:-h] - 1 - 0.0025; dd = np.array(days[:-h])
        for nm, per in (('찾기', (dd >= '2025-02-21') & (dd < '2025-10-17')), ('확인', (dd >= '2025-11-01') & (dd < '2026-04-16'))):
            print(f'SCHB {h}일 보유 {nm} 기간 평균 {r[per].mean()*100:+.2f}%')
    for ex in ('h5', 'h10', 'oc5'):
        fs = [f for f in found if f['ex'] == ex]
        xs = [excess(ex, f['conds'], VAL) for f in fs]; xm = np.array([x[0] for x in xs]); xt = np.array([x[1] for x in xs])
        print(f'{ex}: 상위 {len(fs)}개 확인 기간 초과수익 플러스 {np.mean(xm>0)*100:.0f}%, 평균 {np.nanmean(xm)*100:+.2f}%, t>2 {np.mean(xt>2)*100:.0f}%')
        o = np.argsort(-xt)[:8]
        for i in o:
            f = fs[i]; dx = excess(ex, f['conds'], DISC)
            print(f"   {fmt(f['conds']):44} 찾기 초과 {dx[0]*100:+.2f}% (t={dx[1]:.1f}) 확인 초과 {xm[i]*100:+.2f}% (t={xt[i]:.1f}) 확인 절대 {f['v']['mean']*100:+.2f}%")
