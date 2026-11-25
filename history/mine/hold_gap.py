# 최종 기간(2026-05~11) 1회 시험: 찾기·확인 두 기간 모두 t>2였던 규칙만 (val_gap.py가 고름)
import os, sys, json, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_gap import *
top = json.load(open(OUT + '/val_gap.json')); cand = [f for f in top if f['v']['t'] > 2 and f['t'] > 2]
fmt = lambda c: ' & '.join(f'{k}{op}{th:.3g}' for k, op, th in c); res = []
for f in cand:
    h = evaluate(f['en'], f['ex'], f['conds'], HOLD); h2 = evaluate(f['en'], f['ex'], f['conds'], HOLD, k=1.0, clip=None); hh = evaluate(f['en'], f['ex'], f['conds'], HOLD, k=0.5)
    res.append(dict(f, h=h)); print(f"{f['en']:6}{f['ex']:8}{fmt(f['conds']):38} 찾기 {f['mean']*100:+.2f}% | 확인 {f['v']['mean']*100:+.2f}% | 최종 {h['n']:3}건 {h['mean']*100:+.2f}% (t={h['t']:+.1f}, 비용전 {h['gross']*100:+.2f}%, 자르지 않으면 {h2['mean']*100:+.2f}%, 비용 절반 {hh['mean']*100:+.2f}%)")
json.dump(res, open(OUT + '/hold_gap.json', 'w'))
m = np.array([r['h']['mean'] for r in res]); print(f'최종 기간: {len(res)}개 중 플러스 {np.sum(m > 0)}개, t>2 {sum(r["h"]["t"] > 2 for r in res)}개, 평균 {np.nanmean(m)*100:+.2f}%')
