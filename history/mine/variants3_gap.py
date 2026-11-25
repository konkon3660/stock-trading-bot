# 갭상승 눌림(시가 $1~3, 시가 -5% 지정가 매수) — 부분 손절·부분 익절 비교 (2026-11-21, 사용자: "부분손절이랑 부분익절도 가능한건데")
# 물량을 반으로 나눠 각 절반이 자기 손절·목표를 따로 가짐. 진입 1분 안 손절은 실전식(그 분 저가). 목표는 진입 다음 분부터.
# 데이터 준비·비용은 variants2_gap.py와 같음. 결과: results/mine/variants3_gap.txt
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants2_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"후보(시가")[0], p, 'exec'))
E = []
for i in cand:
    lv = fl(o[i] * 0.95); Li = LL[i]
    for j in range(OPEN, LASTIN + 1):
        if not isn(Li[j]) and Li[j] < lv: E.append((i, j, min(OL[i][j], lv) if not isn(OL[i][j]) else lv)); break
def tr(i, j, pe, sm, tm=None, trail=None, be=None):
    Oi, Hi, Li, Ci = OL[i], HL[i], LL[i], CL[i]; stop = pe * sm
    if Li[j] <= stop: return stop, 'st'
    hi = max(pe, Ci[j])
    for k in range(j + 1, LAST + 1):
        op, h, l = Oi[k], Hi[k], Li[k]
        if isn(h): continue
        if l <= stop: return (min(op, stop) if not isn(op) else stop), 'st'
        if tm and h > pe * tm: return (max(op, pe * tm) if not isn(op) else pe * tm), 'tp'
        hi = max(hi, h)
        if be and hi >= pe * be: stop = max(stop, pe * 1.0001)
        if trail and hi >= pe * trail[0]: stop = max(stop, hi * (1 - trail[1]))
    return Ci[LAST], 'cl'
def netp(pe, parts, kc=1.0):
    s = max(0.008, 0.01 / pe) * kc; b = pe * 1.001
    return sum(w * (px * (1 - (0 if t == 'tp' else s / 2)) * (1 - (0.005 * kc if t == 'st' else 0)) * (1 - 0.0013) / b - 1) for w, px, t in parts)
PERS = [lambda x: x < '2025-11-01', lambda x: '2025-11-01' <= x < '2026-05-01', lambda x: x >= '2026-05-01']
def rep(name, spec):
    R = []
    for i, j, pe in E:
        parts = [(w,) + tr(i, j, pe, *a) for w, *a in spec]
        R.append((d[i], netp(pe, parts), netp(pe, parts, 2.0)))
    by = collections.defaultdict(list); by2 = collections.defaultdict(list)
    for x in R: by[x[0]].append(x[1]); by2[x[0]].append(x[2])
    days = sorted(by); m = np.array([np.mean(by[k]) for k in days]); m2 = np.array([np.mean(by2[k]) for k in days])
    per = [m[[f(k) for k in days]].mean() for f in PERS]; t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    mon = collections.defaultdict(list)
    for k, v in zip(days, m): mon[k[:7]].append(v)
    r = np.array([x[1] for x in R]); cut = np.sort(r)[:int(len(r) * .98)]
    print(f"{name:34} " + ' '.join(f'{q*100:+6.2f}%' for q in per) + f" | {m.mean()*100:+6.2f}% {t:+5.1f} {m2.mean()*100:+6.2f}% {np.mean(r>0)*100:4.0f}% {sum(np.mean(v)>0 for v in mon.values()):3d}/25 {np.mean(r>=.195)*100:4.1f}% {r.max()*100:+5.0f}% {cut.mean()*100:+6.2f}% {r.min()*100:+6.1f}%")
print(f"체결 {len(E)}건 (시가 -5% 지정가)")
print(f"{'방식 (절반씩: 손절/목표)':34} {'찾기':>7} {'확인':>7} {'최종':>7} | {'2년':>7} {'t':>5} {'비용2배':>7} {'승률':>4} {'플러스달':>6} {'+20%↑':>5} {'최고':>5} {'상위2%뺌':>7} {'최악거래':>7}")
print('— 기준')
rep('전부 손절-5%/목표+10% (지금)', [(1, .95, 1.10)])
rep('전부 손절-10%/목표+10%', [(1, .90, 1.10)])
print('— 부분 손절 (목표는 전부 +10%)')
rep('반 -5%, 반 -10%', [(.5, .95, 1.10), (.5, .90, 1.10)])
rep('반 -5%, 반 -15%', [(.5, .95, 1.10), (.5, .85, 1.10)])
rep('반 -10%, 반 -20%', [(.5, .90, 1.10), (.5, .80, 1.10)])
print('— 부분 익절 (손절은 전부 -10%)')
rep('반 +5%, 반 +10%', [(.5, .90, 1.05), (.5, .90, 1.10)])
rep('반 +10%, 반 +20%', [(.5, .90, 1.10), (.5, .90, 1.20)])
rep('반 +10%, 반 +20%(+10% 뒤 본전 손절)', [(.5, .90, 1.10), (.5, .90, 1.20, None, 1.10)])
rep('반 +10%, 반 +30%', [(.5, .90, 1.10), (.5, .90, 1.30)])
rep('반 +10%, 반 마감까지', [(.5, .90, 1.10), (.5, .90, None)])
rep('반 +10%, 반 추적(고점-10%)', [(.5, .90, 1.10), (.5, .90, None, (1.10, .10))])
print('— 둘 다 나눔')
rep('반 -5%/+10%, 반 -10%/+20%', [(.5, .95, 1.10), (.5, .90, 1.20)])
rep('반 -5%/+10%, 반 -15%/+20%', [(.5, .95, 1.10), (.5, .85, 1.20)])
rep('반 -10%/+10%, 반 -15%/+20%', [(.5, .90, 1.10), (.5, .85, 1.20)])
