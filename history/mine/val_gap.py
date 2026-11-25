import os, sys, json, collections, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_gap import *
J = json.load(open(OUT + '/found_gap.json')); found = J['found']; print('시험', J['tested'], '찾기 t>2', len(found))
print('진입별', collections.Counter(f['en'] for f in found).most_common(8))
print('청산별', collections.Counter(f['ex'] for f in found).most_common(8))
# 전체 기준선
for en in ('at0', 'orb5', 'pmh', 'dip10'):
    for ex in ('close', 'tp20s10', 'on'):
        a, b = evaluate(en, ex, [], DISC), evaluate(en, ex, [], VAL)
        print(f'  기준 {en:5}{ex:8} 찾기 {a["n"]:4}건 {a["mean"]*100:+.2f}% (비용전 {a["gross"]*100:+.2f}%) | 확인 {b["n"]:4}건 {b["mean"]*100:+.2f}% (비용전 {b["gross"]*100:+.2f}%)')
top = found[:3000]
for f in top: f['v'] = evaluate(f['en'], f['ex'], f['conds'], VAL)
json.dump(top, open(OUT + '/val_gap.json', 'w'))
vm = np.array([f['v']['mean'] for f in top]); vt = np.array([f['v']['t'] for f in top])
for lo, hi in ((0, 100), (100, 500), (500, 1000), (1000, 3000)):
    a = vm[lo:hi]; print(f'찾기 순위 {lo}~{hi}: 확인 플러스 {np.nanmean(a > 0)*100:.0f}%  평균 {np.nanmean(a)*100:+.2f}%  t>2 {np.nanmean(vt[lo:hi] > 2)*100:.0f}%')
fmt = lambda c: ' & '.join(f'{k}{op}{th:.3g}' for k, op, th in c)
good = sorted([f for f in top if f['v']['t'] > 2], key=lambda f: -min(f['t'], f['v']['t']))
print('\n두 기간 모두 t>2:', len(good))
for f in good[:30]:
    print(f"{f['en']:6}{f['ex']:8}{fmt(f['conds']):40} 찾기 {f['n']:4}건 {f['mean']*100:+.2f}% t={f['t']:.1f} | 확인 {f['v']['n']:4}건 {f['v']['mean']*100:+.2f}% t={f['v']['t']:.1f} 비용전 {f['v']['gross']*100:+.2f}%")
