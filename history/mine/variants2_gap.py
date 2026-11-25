# 갭상승 눌림(시가 $1~3) 변형 비교 — 2026-11-21, 실전 첫날(MEDS 손절 뒤 급등) 뒤 사용자 질문:
#  ① 진입한 1분 안의 손절: 백테스트식(그 분 종가) vs 실전식(그 분 저가 — 지정가 체결은 그 분 저가보다 먼저 일어남)
#  ② 더 싸게 사기: 시가 -10%, -15% / 물타기: -5%에 절반 + -10%에 절반 (손절 시가×0.855, 목표 평균가 +10%)
#  ③ 크게 먹기: 목표 +15%, +20%, 목표 없이 마감, 반 +10% 뒤 나머지 +20%(본전 손절), 추적 손절
# 비용은 exit_variants_gap.py와 같음. 수익률은 '계획한 자본(거래당 $20) 대비'.
import os, sys, numpy as np, collections, warnings; warnings.filterwarnings('ignore')
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
exec(open(os.path.join(HERE, 'build_gap.py'), encoding='utf-8').read().split('# 일봉 (전날까지)')[0])
OPEN, LAST, LASTIN = 330, 718, 330 + 300
fl = lambda x: np.floor(x * 100 + 1e-9) / 100
cand = np.where((o_off >= 1) & (o_off < 3))[0]
OL, HL, LL, CL = O.tolist(), H.tolist(), L.tolist(), Cf.tolist()
nan = float('nan'); isn = lambda x: x != x
TPM = {'T10': 1.10, 'T15': 1.15, 'T20': 1.20, 'NoT': None, 'Half10_T20': 1.10, 'Trail10': None}

def sim(i, legs, exitk, stopk, mode):
    oi = o[i]; lv = [fl(oi * m) for _, m in legs]; got = [None] * len(legs)
    Oi, Hi, Li, Ci = OL[i], HL[i], LL[i], CL[i]
    sh = 0.0; frac = 1.0; outs = []; stop = tp = None; hi = 0.0; half = False; tpm = TPM[exitk]
    def setlv():
        nonlocal stop, tp
        fw = [(w, p) for (w, _), p in zip(legs, got) if p is not None]
        avg = sum(w for w, _ in fw) / sum(w / p for w, p in fw)
        stop = avg * stopk[1] if stopk[0] == 'pct' else oi * stopk[1]
        tp = avg * tpm if tpm else None
        return avg
    avg = None
    for k in range(OPEN, LAST + 1):
        op, h, l = Oi[k], Hi[k], Li[k]
        if isn(h): continue
        new = False
        if k <= LASTIN and not half:
            for q, ((w, _), x) in enumerate(zip(legs, lv)):
                if got[q] is None and l < x:
                    got[q] = min(op, x) if not isn(op) else x; new = True
            if new: avg = setlv()
        if avg is None: continue
        if new:
            hit = (Ci[k] <= stop) if mode == 'close' else (l <= stop)
            if hit: outs.append((frac, stop, 'st')); return got, outs
            hi = max(hi, Ci[k]); continue
        if l <= stop:
            outs.append((frac, min(op, stop) if not isn(op) else stop, 'st')); return got, outs
        if tp and h > tp:
            px = max(op, tp) if not isn(op) else tp
            if exitk == 'Half10_T20' and not half:
                outs.append((0.5, px, 'tp')); frac = 0.5; half = True; stop = avg * 1.0001; tp = avg * 1.20
                if h > tp: outs.append((0.5, max(px, tp), 'tp')); return got, outs
            else:
                outs.append((frac, px, 'tp')); return got, outs
        hi = max(hi, h)
        if exitk == 'Trail10' and hi >= avg * 1.10: stop = max(stop, avg * 1.05, hi * 0.95)
    if avg is None: return None
    outs.append((frac, Ci[LAST], 'cl')); return got, outs

def net(legs, res, kc=1.0):
    got, outs = res; fw = [(w, p) for (w, _), p in zip(legs, got) if p is not None]
    s = max(0.008, 0.01 / fw[0][1]) * kc; sh = sum(w / (p * 1.001) for w, p in fw); spent = sum(w for w, _ in fw)
    back = sum(f * sh * px * (1 - (0 if t == 'tp' else s / 2)) * (1 - (0.005 * kc if t == 'st' else 0)) * (1 - 0.0013) for f, px, t in outs)
    return back - spent

PER = [('찾기', lambda x: x < '2025-11-01'), ('확인', lambda x: '2025-11-01' <= x < '2026-05-01'), ('최종', lambda x: x >= '2026-05-01')]
def report(name, legs, exitk, stopk, mode):
    R = []
    for i in cand:
        r = sim(i, legs, exitk, stopk, mode)
        if r: R.append((d[i], net(legs, r), net(legs, r, 1.5)))
    def dm(sel, col=1):
        by = collections.defaultdict(list)
        for x in R:
            if sel(x[0]): by[x[0]].append(x[col])
        m = np.array([np.mean(v) for v in by.values()]); return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    ps = [dm(f)[0] for _, f in PER]; a, t = dm(lambda x: True); a15, _ = dm(lambda x: True, 2)
    r = np.array([x[1] for x in R]); top = np.sort(r)[:int(len(r) * 0.98)]
    print(f"{name:30} {len(R):5d} " + ' '.join(f'{p*100:+6.2f}%' for p in ps) + f" | {a*100:+6.2f}% {t:+5.1f} {a15*100:+6.2f}% {np.mean(r>0)*100:4.0f}% {np.mean(r>=0.195)*100:4.1f}% {r.max()*100:+6.0f}% {top.mean()*100:+6.2f}%  ${r.sum()*20:+7.0f}")

print(f"후보(시가 $1~3) {len(cand)}건")
print(f"{'방식':30} {'거래':>5} {'찾기':>7} {'확인':>7} {'최종':>7} | {'2년':>7} {'t':>5} {'비용1.5':>7} {'승률':>4} {'+20%↑':>5} {'최고':>6} {'상위2%뺌':>7} {'2년합계':>8}")
print('— ① 진입 1분 안 손절 처리 (시가-5%, +10%/-5%)')
report('백테스트식(그 분 종가)', [(1, .95)], 'T10', ('pct', .95), 'close')
report('실전식(그 분 저가)', [(1, .95)], 'T10', ('pct', .95), 'low')
print('— ② 더 싸게 / 물타기 (실전식, 목표 평균가 +10%)')
report('시가 -10% 지정가, 손절 -5%', [(1, .90)], 'T10', ('pct', .95), 'low')
report('시가 -15% 지정가, 손절 -5%', [(1, .85)], 'T10', ('pct', .95), 'low')
report('물타기 -5%·-10% 반반, 손절 시가×0.855', [(.5, .95), (.5, .90)], 'T10', ('lvl', .855), 'low')
print('— ③ 크게 먹기 (실전식, 시가 -5% 진입, 손절 -5%)')
for k, nm in (('T15', '목표 +15%'), ('T20', '목표 +20%'), ('NoT', '목표 없음(마감까지)'), ('Half10_T20', '반 +10%, 반 +20%(본전 손절)'), ('Trail10', '+10% 뒤 추적 손절')):
    report(nm, [(1, .95)], k, ('pct', .95), 'low')
print('— 진단: 물타기가 나은 이유 (넓은 손절 때문인지)')
report('한 번에 -5%, 손절 시가×0.855', [(1, .95)], 'T10', ('lvl', .855), 'low')
report('-5%에 절반만 (+10%/-5%)', [(.5, .95)], 'T10', ('pct', .95), 'low')
print('— ④ 손절 폭만 바꿈 (실전식, 시가 -5% 진입, 목표 +10%) — 플러스 달·비용 2배 포함')
print(f"{'손절(체결가 대비)':14} {'거래':>5} {'찾기':>7} {'확인':>7} {'최종':>7} | {'2년':>7} {'t':>5} {'비용2배':>7} {'승률':>4} {'손절률':>5} {'플러스 달':>8} {'최악 하루':>8}")
for sl in (.97, .95, .93, .92, .90, .88, .85, .80, 0.0):
    legs = [(1, .95)]; R = []
    for i in cand:
        r = sim(i, legs, 'T10', ('pct', sl), 'low')
        if r: R.append((d[i], net(legs, r), net(legs, r, 2.0), r[1][-1][2]))
    by = collections.defaultdict(list); by2 = collections.defaultdict(list)
    for x in R: by[x[0]].append(x[1]); by2[x[0]].append(x[2])
    days = sorted(by); m = np.array([np.mean(by[k]) for k in days]); m2 = np.array([np.mean(by2[k]) for k in days])
    per = [m[[f(k) for k in days]].mean() for _, f in PER]
    mon = collections.defaultdict(list)
    for k, v in zip(days, m): mon[k[:7]].append(v)
    t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    lab = '없음(마감까지)' if sl == 0 else f'-{round((1-sl)*100)}%'
    print(f"{lab:14} {len(R):5d} " + ' '.join(f'{q*100:+6.2f}%' for q in per) + f" | {m.mean()*100:+6.2f}% {t:+5.1f} {m2.mean()*100:+6.2f}% {np.mean(np.array([x[1] for x in R])>0)*100:4.0f}% {np.mean([x[3]=='st' for x in R])*100:4.0f}% {sum(np.mean(v)>0 for v in mon.values()):3d}/{len(mon)} {m.min()*100:+7.1f}%")
