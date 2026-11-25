# 갭상승 눌림(시가 $1~3, 시가 -5% 지정가, 목표 +10%·손절 -20%, 실전식) — '전날도 급등했던 종목' 따로 보기 (2026-11-24 사용자 질문)
# 실전: MEDS 11/20 손절 뒤 그날 +84%로 마감 → 11/23 갭 +41%로 다시 후보 → 다시 사서 마감 정리 -8.1%. 이런 '연속 급등 종목'은 성적이 다른가?
# 전날 급등 = events.csv(장중 급등일 목록)의 직전 거래일에 같은 종목이 있음. 결과: results/mine/variants5_gap.txt
import os, csv, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
ev = {}; days = set()
for r in csv.DictReader(open(DATA + '/events.csv', encoding='utf-8-sig')):
    days.add(r['날짜']); ev[(r['날짜'], r['종목'])] = float(r['종가상승률'] or 'nan')
days = sorted(days); prev = {d0: days[k - 1] for k, d0 in enumerate(days) if k}
def prevret(i): return ev.get((prev.get(d[i]), T[i]))
spec = [(1, .80, 1.10)]
R = []
for i, j, pe in E:
    parts = [(w,) + tr(i, j, pe, *a) for w, *a in spec]; R.append((d[i], netp(pe, parts), prevret(i), parts[0][2]))
def show(name, sel):
    rr = [x for x in R if sel(x)]
    if len(rr) < 5: print(f"{name:34} {len(rr):5d}건"); return
    by = collections.defaultdict(list)
    for x in rr: by[x[0]].append(x[1])
    m = np.array([np.mean(v) for v in by.values()]); t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m))) if len(m) > 1 else float('nan')
    per = []
    for f in PERS:
        v = [x[1] for x in rr if f(x[0])]; per.append(f"{np.mean(v)*100:+6.2f}%({len(v)})" if v else '   -   ')
    r = np.array([x[1] for x in rr]); k = collections.Counter(x[3] for x in rr)
    print(f"{name:34} {len(rr):5d}건 거래당 {r.mean()*100:+6.2f}% (t={t:+.1f}) 승률 {np.mean(r>0)*100:3.0f}% | 찾기 {per[0]} 확인 {per[1]} 최종 {per[2]} | 목표 {k['tp']/len(rr)*100:3.0f}% 손절 {k['st']/len(rr)*100:3.0f}% 마감 {k['cl']/len(rr)*100:3.0f}%")
print(f"체결 {len(R)}건 — 지금 규칙(목표 +10%, 손절 -20%)")
show('전체', lambda x: True)
show('전날 급등 목록에 없음', lambda x: x[2] is None)
show('전날 급등 목록에 있음', lambda x: x[2] is not None)
show('  └ 전날 종가 +30% 미만', lambda x: x[2] is not None and x[2] < 0.30)
show('  └ 전날 종가 +30% 이상', lambda x: x[2] is not None and x[2] >= 0.30)
show('  └ 전날 종가 +50% 이상 (MEDS 같은 경우)', lambda x: x[2] is not None and x[2] >= 0.50)
