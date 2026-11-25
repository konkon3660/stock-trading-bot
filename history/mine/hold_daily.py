# 최종 기간(2026-05 ~ 2026-11) 한 번만 보는 시험. 확인 기간까지 보고 미리 정한 3개 + 비교 기준만
import os
import sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from search_daily import *; from excess_daily import excess
C3 = [('A 시장이 20일 평균보다 1.5%↑일 때 아무거나 10일 보유', 'h10', [('mkt_sma20', '>=', 0.0152)]),
      ('B A + 전날 거래량 0.59배 이상', 'h10', [('vr', '>=', 0.592), ('mkt_sma20', '>=', 0.0152)]),
      ('C 하루 변동폭(ATR) 7~9.5% 종목 5일 보유', 'h5', [('atrp', '>=', 0.0701), ('atrp', '<', 0.0949)]),
      ('기준: 후보 전부 10일 보유', 'h10', []), ('기준: 후보 전부 5일 보유', 'h5', [])]
for nm, ex, c in C3:
    out = []
    for pn, per in (('찾기', DISC), ('확인', VAL), ('최종', HOLD)):
        e = evaluate(ex, c, per); x = excess(ex, c, per) if c else (np.nan, np.nan, 0)
        out.append(f"{pn} {e['mean']*100:+.2f}% (t={e['t']:.1f}, {e['days']}일)" + (f" 초과 {x[0]*100:+.2f}%" if c else ''))
    print(f'{nm}\n   ' + ' | '.join(out))
P = np.load(W + '/panel.npz'); days = list(P['days']); j = list(P['tick']).index('SCHB'); c = P['c'][:, j].astype(float)
for h in (5, 10):
    r = c[h:] / c[:-h] - 1 - 0.0025; dd = np.array(days[:-h]); per = dd >= '2026-05-01'
    print(f'SCHB {h}일 보유 최종 기간 평균 {np.nanmean(r[per])*100:+.2f}% (자료 있는 날 {np.sum(~np.isnan(r[per]))}일)')
