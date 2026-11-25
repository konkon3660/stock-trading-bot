import os
import sys, json, numpy as np, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_daily import *
J = json.load(open(W + '/found_daily.json')); found = J['found']; print('시험', J['tested'])
fmt = lambda c: ' & '.join(f'{k}{op}{th:.3g}' for k, op, th in c)
base = {ex: (evaluate(ex, [], DISC), evaluate(ex, [], VAL)) for ex in EXITS}
for ex in EXITS:
    b = base[ex]; fs = [f for f in found if f['ex'] == ex]
    for f in fs: f['v'] = evaluate(ex, f['conds'], VAL)
    vm = np.array([f['v']['mean'] for f in fs]); vt = np.array([f['v']['t'] for f in fs])
    print(f"{ex:9} 전체 찾기 {b[0]['mean']*100:+.2f}% 확인 {b[1]['mean']*100:+.2f}% | 상위{len(fs)} 확인 플러스 {np.mean(vm>0)*100:3.0f}% 평균 {np.nanmean(vm)*100:+.2f}% t>2 {np.mean(vt>2)*100:3.0f}%  최고 확인 t {np.nanmax(vt):.1f}")
json.dump(found, open(W + '/val_daily.json', 'w'))
good = sorted([f for f in found if f['v']['t'] > 2.5], key=lambda f: -min(f['t'], f['v']['t']))
print('\n두 기간 모두 t>2.5:', len(good))
for f in good[:40]:
    print(f"{f['ex']:9}{fmt(f['conds']):42} 찾기 {f['n']:5}건 {f['mean']*100:+.2f}% t={f['t']:.1f} | 확인 {f['v']['n']:5}건 {f['v']['mean']*100:+.2f}% t={f['v']['t']:.1f} 승률 {f['v']['win']*100:.0f}%")
