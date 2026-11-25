# 갭상승 눌림(시가 $1~3, -5% 지정가, 목표 +10%·손절 -20%, 실전식) — 15:58에 안 팔고 애프터장까지 들고 가면? (2026-11-24 사용자: "데이장이나 앱장")
# 정규장에 안 끝난 거래만 애프터장(16:00~19:50 ET)까지 목표·손절 유지 → 19:50에 남은 것 매도.
# 애프터장 체결은 스프레드 1.62%(토스 녹화 급등주 중간값, 정규장 0.8%)로 계산. 데이마켓(20:00~04:00 ET)은 분봉 데이터가 없어서 못 잼.
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
AH_END = 950  # 19:50 ET (4:00부터 분)
def tr2(i, j, pe, sm, tm, last):
    Oi, Hi, Li, Ci = OL[i], HL[i], LL[i], CL[i]; stop = pe * sm
    if Li[j] <= stop: return stop, 'st', j
    for k in range(j + 1, last + 1):
        op, h, l = Oi[k], Hi[k], Li[k]
        if isn(h): continue
        if l <= stop: return (min(op, stop) if not isn(op) else stop), 'st', k
        if tm and h > pe * tm: return (max(op, pe * tm) if not isn(op) else pe * tm), 'tp', k
    c = next((Ci[k] for k in range(last, j, -1) if not isn(Ci[k])), Ci[last]); return c, 'cl', last
def net2(pe, px, t, k, kc=1.0):
    ah = k > LAST; s = (max(0.0162, 0.01 / pe) if ah else max(0.008, 0.01 / pe)) * kc; b = pe * 1.001
    return px * (1 - (0 if t == 'tp' else s / 2)) * (1 - (0.005 * kc if t == 'st' else 0)) * (1 - 0.0013) / b - 1
rows = []
for i, j, pe in E:
    a = tr2(i, j, pe, .80, 1.10, LAST); b = tr2(i, j, pe, .80, 1.10, AH_END) if a[1] == 'cl' else a
    rows.append((d[i], net2(pe, *a), net2(pe, *b), a[1], b[1], b[2] > LAST))
def per_mean(col, sel=lambda r: True):
    by = collections.defaultdict(list)
    for r in rows:
        if sel(r): by[r[0]].append(r[col])
    m = np.array([np.mean(v) for v in by.values()]); return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
PER = [('찾기', lambda x: x < '2025-11-01'), ('확인', lambda x: '2025-11-01' <= x < '2026-05-01'), ('최종', lambda x: x >= '2026-05-01')]
print(f"체결 {len(rows)}건, 그중 15:58까지 안 끝난 것 {sum(r[3]=='cl' for r in rows)}건")
for col, nm in ((1, '지금: 15:58 정리'), (2, '애프터장 19:50까지 들고 감')):
    a, t = per_mean(col); ps = [per_mean(col, lambda r, f=f: f(r[0]))[0] for _, f in PER]
    print(f"{nm:24} 거래당 {a*100:+.2f}% (t={t:+.1f}) | " + ' '.join(f"{n} {v*100:+.2f}%" for (n, _), v in zip(PER, ps)))
cl = [r for r in rows if r[3] == 'cl']
x = np.array([r[1] for r in cl]); y = np.array([r[2] for r in cl]); k = collections.Counter(r[4] for r in cl)
print(f"15:58 미정리 {len(cl)}건만: 15:58에 팔면 평균 {x.mean()*100:+.2f}% / 애프터장까지 {y.mean()*100:+.2f}% "
      f"(애프터장에서 목표 {k['tp']}건·손절 {k['st']}건·19:50 정리 {k['cl']}건), 애프터장이 나았던 비율 {np.mean(y > x)*100:.0f}%")
