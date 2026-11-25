# 갭상승 눌림(시가 $1~3, 시가 -5% 지정가 매수) — '조금씩 잃고 한 번에 크게 먹기' 시험 (2026-11-21, 사용자 질문)
# ① 체결 뒤 그날 얼마나 더 오르는지(최대 상승) 분포 ② 좁은 손절 × 수익 끝까지 끌고 가기 20가지 (미리 정함)
# 실전식(진입 1분 안 손절은 그 분 저가). 데이터·비용은 variants3_gap.py와 같음. 결과: results/mine/variants4_gap.txt
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
print(f"체결 {len(E)}건")
print('— ① 체결 뒤 마감 전까지 최고가 (체결가 대비, 그 전에 손절 여부는 안 따짐)')
mu = []; first = []
for i, j, pe in E:
    hs = [h for h in HL[i][j + 1:LAST + 1] if not isn(h)]; mx = max(hs) / pe - 1 if hs else 0; mu.append(mx)
    s5 = None
    for k in range(j, LAST + 1):
        h, l = HL[i][k], LL[i][k]
        if isn(h): continue
        if l <= pe * 0.95: s5 = 'st'; break
        if k > j and h >= pe * 1.20: s5 = 'up'; break
    first.append(s5)
mu = np.array(mu)
for x in (.1, .2, .3, .5, 1.0): print(f"  +{int(x*100)}% 이상 간 거래: {np.mean(mu >= x)*100:5.1f}%")
big = [f for f, m in zip(first, mu) if m >= .2]
print(f"  +20% 이상 간 거래 중 그 전에 -5%를 먼저 찍은 비율: {np.mean([f == 'st' for f in big])*100:.0f}%")
print('— ② 좁은 손절 × 끝까지 끌고 가기')
print(f"{'손절 / 청산':26} {'찾기':>7} {'확인':>7} {'최종':>7} | {'2년':>7} {'t':>5} {'승률':>4} {'평균 이익':>7} {'평균 손실':>7} {'손익비':>5} {'+20%↑':>5}")
def rep4(name, spec):
    R = []
    for i, j, pe in E:
        parts = [(w,) + tr(i, j, pe, *a) for w, *a in spec]; R.append((d[i], netp(pe, parts)))
    by = collections.defaultdict(list)
    for x in R: by[x[0]].append(x[1])
    days = sorted(by); m = np.array([np.mean(by[k]) for k in days])
    per = [m[[f(k) for k in days]].mean() for f in PERS]; t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    r = np.array([x[1] for x in R]); w, l = r[r > 0], r[r <= 0]
    print(f"{name:26} " + ' '.join(f'{q*100:+6.2f}%' for q in per) + f" | {m.mean()*100:+6.2f}% {t:+5.1f} {len(w)/len(r)*100:4.0f}% {w.mean()*100:+6.1f}% {l.mean()*100:+6.1f}% {w.mean()/-l.mean():5.2f} {np.mean(r>=.195)*100:4.1f}%")
for sm in (.97, .95, .93, .90):
    for nm, a in (('마감까지', (None,)), ('추적 고점-15%', (None, (0, .15))), ('추적 고점-20%', (None, (0, .20))), ('목표 +30%', (1.30,)), ('목표 +50%', (1.50,))):
        rep4(f"-{round((1-sm)*100)}% / {nm}", [(1, sm) + a])
print('— 비교: 목표 +10%')
for sm in (.95, .90): rep4(f"-{round((1-sm)*100)}% / 목표 +10%", [(1, sm, 1.10)])
