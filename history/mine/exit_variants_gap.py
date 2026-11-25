# 갭상승 눌림(시가 $1~3, 시가 -5% 지정가) 청산 방식 비교: +10% 전부 매도 vs 목표 높이기 / 반만 팔기 / 추적 손절
import os, sys, numpy as np, collections, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_gap.py'), encoding='utf-8').read().split('# ---------- 진입 ----------')[0]
exec(src)  # build_gap.py의 데이터 준비 부분만 (O,H,L,C,Cf,o,d,F 등)
OPEN, LAST = 330, 718
lvl = np.array([np.floor(x * 0.95 * 100 + 1e-9) / 100 for x in o])
cand = (o_off >= 1) & (o_off < 3)
rows = []
for i in np.where(cand)[0]:
    hit = np.where((np.arange(960) >= OPEN) & (np.arange(960) <= OPEN + 300) & (np.nan_to_num(L[i], nan=np.inf) < lvl[i]))[0]
    if not len(hit): continue
    j = hit[0]; pe = min(O[i, j], lvl[i]) if not np.isnan(O[i, j]) else lvl[i]
    rows.append((i, j, pe))
print('체결', len(rows), '건')
def sim(i, j, pe, kind):
    # 돌려줌: [(비중, 청산가, 종류)] 종류 'tp'=지정가 목표(스프레드 없음), 'st'=손절(반 스프레드+0.5%), 'cl'=마감(반 스프레드)
    stop = pe * 0.95; parts = []; w = 1.0; hi = pe
    tp = {'T10': 1.10, 'T15': 1.15, 'T20': 1.20, 'NoT': None, 'Half10_BE': 1.10, 'Half10_T20': 1.10, 'Trail10': None, 'Trail5': None}[kind]
    half_done = False
    for k in range(j, LAST + 1):
        op, h, l = O[i, k], H[i, k], L[i, k]
        if np.isnan(h): continue
        if k > j or True:
            # 손절 먼저 (보수적). 진입 봉은 종가 기준
            if (k == j and Cf[i, k] <= stop) or (k > j and l <= stop):
                px = stop if k == j else min(op if not np.isnan(op) else stop, stop); parts.append((w, px, 'st')); return parts
        if k == j: hi = max(hi, Cf[i, k]); continue
        if tp and h > pe * tp:
            px = max(op if not np.isnan(op) else pe * tp, pe * tp)
            if kind in ('Half10_BE', 'Half10_T20') and not half_done:
                parts.append((0.5, px, 'tp')); w = 0.5; half_done = True; stop = pe * 1.0001
                tp = 1.20 if kind == 'Half10_T20' else None
                if kind == 'Half10_T20' and h > pe * 1.20: parts.append((0.5, max(px, pe * 1.20), 'tp')); return parts
            else: parts.append((w, px, 'tp')); return parts
        hi = max(hi, h)
        if kind == 'Trail10' and hi >= pe * 1.10: stop = max(stop, pe * 1.05, hi * 0.95)
        if kind == 'Trail5' and hi >= pe * 1.05: stop = max(stop, pe * 1.0001, hi * 0.93)
    parts.append((w, Cf[i, LAST], 'cl')); return parts
def net(pe, parts, kcost=1.0):
    s = max(0.008, 0.01 / pe) * kcost; buy = pe * 1.001; tot = 0
    for w, px, t in parts:
        sell = px * (1 - (0 if t == 'tp' else s / 2)) * (1 - (0.005 * kcost if t == 'st' else 0)) * (1 - 0.0013)
        tot += w * (sell / buy - 1)
    return tot
PER = {'찾기': lambda x: x < '2025-11-01', '확인': lambda x: '2025-11-01' <= x < '2026-05-01', '최종': lambda x: x >= '2026-05-01'}
print(f"{'방식':12} {'찾기':>7} {'확인':>7} {'최종':>7} | {'2년':>7} {'t':>5} {'비용1.5배':>8} {'승률':>5} {'최악 거래':>8}")
for kind in ('T10', 'T15', 'T20', 'NoT', 'Half10_BE', 'Half10_T20', 'Trail10', 'Trail5'):
    R = [(d[i], net(pe, sim(i, j, pe, kind)), net(pe, sim(i, j, pe, kind), 1.5)) for i, j, pe in rows]
    def daymean(sel, col=1):
        by = collections.defaultdict(list)
        for r in R:
            if sel(r[0]): by[r[0]].append(r[col])
        m = np.array([np.mean(v) for v in by.values()]); return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    ps = [daymean(f)[0] for f in PER.values()]; a, t = daymean(lambda x: True); a15, _ = daymean(lambda x: True, 2)
    allr = np.array([r[1] for r in R])
    print(f"{kind:12} {ps[0]*100:+6.2f}% {ps[1]*100:+6.2f}% {ps[2]*100:+6.2f}% | {a*100:+6.2f}% {t:+5.1f} {a15*100:+7.2f}% {np.mean(allr>0)*100:4.0f}% {allr.min()*100:+7.1f}%")
