import os
import sys, json, numpy as np, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_intra import *
J = json.load(open(W + '/found_intra.json')); found = J['found']
print('시험', J['tested'], 't>2', len(found))
print('진입별', collections.Counter(f['en'] for f in found).most_common())
print('청산별', collections.Counter(f['ex'] for f in found).most_common(8))
top = found[:3000]
for f in top:
    v = evaluate(f['en'], f['ex'], f['conds'], VAL); f['v'] = v
json.dump(top, open(W + '/val_intra.json', 'w'))
vm = np.array([f['v']['mean'] for f in top]); vt = np.array([f['v']['t'] for f in top])
for lo, hi in [(0, 100), (100, 500), (500, 1000), (1000, 3000)]:
    a = vm[lo:hi]; a = a[np.isfinite(a)]
    print(f'찾기 t 순위 {lo}~{hi}: 확인 기간 플러스 {np.mean(a>0)*100:.0f}%  평균 {np.mean(a)*100:+.2f}%  t>2 {np.mean(vt[lo:hi]>2)*100:.0f}%')
fmt = lambda c: ' & '.join(f'{k}{op}{th:.3g}' for k, op, th in c)
print('\n찾기 상위 25')
for f in top[:25]:
    print(f"{f['en']:7}{f['ex']:10}{fmt(f['conds']):45} 찾기 {f['n']:4}건 {f['mean']*100:+.2f}% t={f['t']:.1f} | 확인 {f['v']['n']:4}건 {f['v']['mean']*100:+.2f}% t={f['v']['t']:.1f}")
