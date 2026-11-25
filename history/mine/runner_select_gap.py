# 갭상승 눌림 — +10%에 닿는 순간 '이건 더 간다'를 골라낼 수 있나 (2026-11-26 사용자: "큰 상승폭을 보였던 것들의 특징을 파악해서 맞는 것들만")
# 결정 시점: 지금 규칙대로 가다가 +10% 목표에 처음 닿는 분 k. 특징은 그때까지 알 수 있는 값만 씀 (k분 봉은 '+10%에 닿았다'는 사실만).
# 비교: A) 지금 규칙 — +10%에 전부 매도  B) 남김 — 본전 손절 + 고점 -20% 추적, 15:58 정리 (variants8에서 '남기기' 중 제일 덜 잃은 방식)
# 차이 = B - A (거래당). 특징별로 찾기 기간 3등분 기준을 정하고, 칸마다 세 기간 차이 평균. 세 기간 모두 플러스여야 의미 있음.
# 2개 조합: 찾기 기간에서 t>2인 조합만 골라 확인·최종에서 한 번 봄. 결과: results/mine/runner_select_gap.txt
import os, itertools, numpy as np, collections, warnings; warnings.filterwarnings('ignore')
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
TP, SM, TRAIL = 1.10, .80, .20
F_NAMES = {'gap': '갭 크기', 'tmin': '개장 후 분', 'speed': '체결→+10% 분', 'px': '체결가 $', 'hod': '+10%가 당일 고가 대비',
           'dv': '당일 거래대금 log$', 'pmdv': '프리장 거래대금 log$', 'vacc': '최근 5분 거래량 / 당일 분당 평균', 'dip': '체결 뒤 최저 (체결가 대비)'}
rows = []
for i, j, pe in E:
    Oi, Hi, Li, Ci = OL[i], HL[i], LL[i], CL[i]; stop = pe * SM
    if Li[j] <= stop: continue
    k = None
    for m in range(j + 1, LAST + 1):
        if isn(Hi[m]): continue
        if Li[m] <= stop: break
        if Hi[m] > pe * TP: k = m; break
    if k is None: continue
    px = max(Oi[k], pe * TP) if not isn(Oi[k]) else pe * TP; ra = netp(pe, [(1, px, 'tp')])
    hi = Hi[k]; st = max(pe * 1.0001, hi * (1 - TRAIL)); out = (Ci[LAST], 'cl')
    for m in range(k + 1, LAST + 1):
        if isn(Hi[m]): continue
        if Li[m] <= st: out = (min(Oi[m], st) if not isn(Oi[m]) else st, 'st'); break
        hi = max(hi, Hi[m]); st = max(st, hi * (1 - TRAIL))
    rb = netp(pe, [(1, out[0], out[1])])
    v, c = V[i], C[i]; vk = v[OPEN:k]
    f = dict(gap=o[i] / pc[i] - 1, tmin=k - OPEN, speed=k - j, px=pe,
             hod=pe * TP / np.nanmax(H[i, OPEN:k]) - 1,
             dv=np.log10(np.nansum(vk * c[OPEN:k]) + 1), pmdv=np.log10(np.nansum(v[:OPEN] * c[:OPEN]) + 1),
             vacc=np.nanmean(v[max(OPEN, k - 5):k]) / max(np.nanmean(vk), 1e-9), dip=np.nanmin(L[i, j:k]) / pe - 1)
    rows.append(dict(d=d[i], diff=rb - ra, mx=np.nanmax(H[i, k:LAST + 1]) / pe - 1, **f))
PER = [('찾기', lambda x: x < '2025-11-01'), ('확인', lambda x: '2025-11-01' <= x < '2026-05-01'), ('최종', lambda x: x >= '2026-05-01')]
def stat(rs):
    if len(rs) < 5: return np.nan, np.nan, len(rs)
    x = np.array([r['diff'] for r in rs]); return x.mean(), x.mean() / (x.std(ddof=1) / np.sqrt(len(x))), len(x)
find = [r for r in rows if PER[0][1](r['d'])]
print(f"+10%에 닿은 거래 {len(rows)}건 (찾기 {len(find)}, 확인 {sum(PER[1][1](r['d']) for r in rows)}, 최종 {sum(PER[2][1](r['d']) for r in rows)})")
print(f"그중 그날 +50% 이상 더 간 것 {sum(r['mx'] >= .5 for r in rows)}건, +100% 이상 {sum(r['mx'] >= 1 for r in rows)}건")
a = [stat([r for r in rows if fn(r['d'])]) for _, fn in PER]
print(f"전부 남기면 (B-A) 거래당: " + ', '.join(f"{n} {m*100:+.2f}% (t={t:+.1f}, {c}건)" for (n, _), (m, t, c) in zip(PER, a)) + f" — 남겨서 나은 비율 {np.mean([r['diff'] > 0 for r in rows])*100:.0f}%\n")
print(f"{'특징 (찾기 기간 3등분)':44} {'칸':>18} | " + ' '.join(f"{n:>17}" for n, _ in PER))
cuts = {}
for fk, nm in F_NAMES.items():
    q = np.nanquantile([r[fk] for r in find], [1 / 3, 2 / 3]); cuts[fk] = q
    for b, (lo, hi) in enumerate([(-np.inf, q[0]), (q[0], q[1]), (q[1], np.inf)]):
        sel = lambda r: lo <= r[fk] < hi; ps = [stat([r for r in rows if fn(r['d']) and sel(r)]) for _, fn in PER]
        mark = ' ◀ 세 기간 모두 +' if all(m > 0 for m, _, _ in ps) else ''
        print(f"{nm if b == 0 else '':44} {f'{lo:.3g} ~ {hi:.3g}':>18} | " + ' '.join(f"{m*100:+6.2f}% t{t:+4.1f} {c:3d}" for m, t, c in ps) + mark)
# 2개 조합: 각 특징의 아래 1/3 또는 위 1/3 칸 두 개를 AND. 찾기에서 t>2 & 20건 이상만 확인·최종에서 봄
cells = [(fk, side) for fk in F_NAMES for side in ('lo', 'hi')]
def cell(r, fk, side): return r[fk] < cuts[fk][0] if side == 'lo' else r[fk] >= cuts[fk][1]
picked = []
for (f1, s1), (f2, s2) in itertools.combinations(cells, 2):
    if f1 == f2: continue
    m, t, c = stat([r for r in find if cell(r, f1, s1) and cell(r, f2, s2)])
    if c >= 20 and t > 2: picked.append(((f1, s1), (f2, s2), m, t, c))
print(f"\n2개 조합 {len(cells) * (len(cells) - 2) // 2}개 중 찾기 기간 t>2·20건 이상: {len(picked)}개")
ok = 0
for (f1, s1), (f2, s2), m, t, c in sorted(picked, key=lambda x: -x[3]):
    ps = [stat([r for r in rows if fn(r['d']) and cell(r, f1, s1) and cell(r, f2, s2)]) for _, fn in PER[1:]]
    good = all(x > 0 for x, _, _ in ps); ok += good
    nm = lambda f, s: f"{F_NAMES[f]} {'아래' if s == 'lo' else '위'}1/3"
    print(f"  {nm(f1, s1)} & {nm(f2, s2):40} 찾기 {m*100:+6.2f}% t{t:+4.1f} {c:3d} | " + ' '.join(f"{n} {x*100:+6.2f}% t{tt:+4.1f} {cc:3d}" for (n, _), (x, tt, cc) in zip(PER[1:], ps)) + (' ◀ 확인·최종도 +' if good else ''))
print(f"→ 확인·최종 둘 다 플러스: {ok}/{len(picked)}개 (아무 힘 없으면 대략 1/4이 우연히 통과)")
