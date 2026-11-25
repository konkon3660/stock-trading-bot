# 일봉(전 종목) → 날짜×종목 배열, 분할 보정
import json, glob, os, numpy as np
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import DATA as R, OUT
files = sorted(glob.glob(R + '/daily/*.json')); days = [os.path.basename(f)[:10] for f in files]
rows = [json.load(open(f)) for f in files]
keep = [i for i, r in enumerate(rows) if r]; files = [files[i] for i in keep]; days = [days[i] for i in keep]; rows = [rows[i] for i in keep]
tick = sorted({r[0] for rs in rows for r in rs}); ti = {t: i for i, t in enumerate(tick)}
nD, nT = len(days), len(tick)
P = {k: np.full((nD, nT), np.nan, np.float32) for k in 'ohlcvw'}
for di, rs in enumerate(rows):
    if not rs: continue
    idx = np.array([ti[r[0]] for r in rs]); a = np.array([(list(r[1:7]) + [np.nan] * 6)[:6] for r in rs], dtype=np.float64)
    for j, k in enumerate('ohlcvw'): P[k][di, idx] = a[:, j]
# 분할 보정: 실행일 d 이전 가격 × from/to, 거래량 × to/from
sp = json.load(open(R + '/splits.json')); dpos = {d: i for i, d in enumerate(days)}
adj = np.ones((nD, nT), np.float64); used = 0
for s in sp:
    if s['T'] not in ti or not s['from'] or not s['to']: continue
    i = np.searchsorted(np.array(days), s['d'])  # 실행일 위치(그날부터 새 기준)
    if i == 0 or i >= nD: continue
    adj[:i, ti[s['T']]] *= s['from'] / s['to']; used += 1
for k in 'ohlcw': P[k] = (P[k] * adj).astype(np.float32)
P['v'] = (P['v'] / adj).astype(np.float32)
np.savez(OUT + '/panel.npz', days=np.array(days), tick=np.array(tick), **P)
print(nD, nT, '분할 적용', used)
