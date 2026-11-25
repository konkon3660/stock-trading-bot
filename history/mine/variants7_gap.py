# 갭상승 눌림 — 지금 규칙(시가 -5% 지정가, +10% / -20%) 기준으로 부분 익절·부분 손절·물타기 다시 보기 (2026-11-26 사용자 질문)
# variants2(물타기)·variants3(부분 청산)는 손절 -5%/-10% 시절 기준이라 지금 규칙과 비교한 적이 없음.
# 변형 8개를 미리 정하고 한 번만 돌림. 두 가지로 봄:
#   ① 거래당: 후보 전부 따로 (다른 variants와 같은 방식)
#   ② 계좌: 갭 큰 5개에 현금을 나눠 동시에 걸고(bot_policy_gap.py에서 제일 나았던 방식), $22 계좌의 토스 최소 수수료 반영
#      주문마다 수수료 최소 $0.01, 매도 주문마다 세금 $0.01 → 부분 청산·물타기는 주문 수가 늘어서 소액이면 비용이 커짐
# 결과: results/mine/variants7_gap.txt
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
CASH, TOP = 22.0, 5
byday = collections.defaultdict(list)
for i in cand: byday[d[i]].append(i)
entry = {i: (j, pe) for i, j, pe in E}

def via_tr(spec):  # 부분 청산: spec = [(비중, 손절배수, 목표배수, 추적)] — 한 번에 사고 나눠 팜
    def f(i):
        if i not in entry: return None
        j, pe = entry[i]; parts = [(w,) + tr(i, j, pe, *a) for w, *a in spec]
        return netp(pe, parts), 1, len({(px, t) for _, px, t in parts}), 1.0
    return f

def via_sim(legs):  # 물타기: legs = [(비중, 시가 대비 지정가)] — 평균가 +10% 목표, 평균가 -20% 손절
    def f(i):
        r = sim(i, legs, 'T10', ('pct', .80), 'low')
        if not r: return None
        got, outs = r; fw = sum(w for (w, _), g in zip(legs, got) if g is not None)
        return net(legs, r), sum(g is not None for g in got), len(outs), fw
    return f

V = [
    ('지금: 전부 +10% / -20%', via_tr([(1, .80, 1.10)])),
    ('— 부분 익절 (손절 전부 -20%)', None),
    ('반 +5%, 반 +10%', via_tr([(.5, .80, 1.05), (.5, .80, 1.10)])),
    ('반 +10%, 반 +20%', via_tr([(.5, .80, 1.10), (.5, .80, 1.20)])),
    ('반 +10%, 반 추적(+10% 뒤 고점-10%)', via_tr([(.5, .80, 1.10), (.5, .80, None, (1.10, .10))])),
    ('— 부분 손절 (목표 전부 +10%)', None),
    ('반 -10%, 반 -20%', via_tr([(.5, .90, 1.10), (.5, .80, 1.10)])),
    ('반 -15%, 반 -25%', via_tr([(.5, .85, 1.10), (.5, .75, 1.10)])),
    ('— 물타기 (평균가 +10% / -20%)', None),
    ('시가 -5%·-10% 반반', via_sim([(.5, .95), (.5, .90)])),
    ('시가 -5%·-15% 반반', via_sim([(.5, .95), (.5, .85)])),
    ('시가 -5%·-10%·-15% 1/3씩', via_sim([(1/3, .95), (1/3, .90), (1/3, .85)])),
]
PER = [lambda x: x < '2025-11-01', lambda x: '2025-11-01' <= x < '2026-05-01', lambda x: x >= '2026-05-01']
days = sorted(byday)
print(f"후보(시가 $1~3, 갭 +15%↑) {len(cand)}건 / {len(days)}일. 수익률은 '그 종목에 배정한 돈' 대비 (물타기는 안 채워진 몫 = 0)")
print(f"{'':36} {'① 거래당 (후보 전부 따로)':^38} | {'② 계좌: 갭 큰 5개 나눠 동시에, $22 최소 수수료':^44}")
print(f"{'방식':36} {'거래':>5} {'2년':>7} {'t':>5} {'찾기':>7} {'확인':>7} {'최종':>7} | {'하루평균':>8} {'t':>5} {'최종':>7} {'최대낙폭':>8} {'최악하루':>8}")
for name, fn in V:
    if fn is None: print(name); continue
    res = {i: fn(i) for i in cand}
    by = collections.defaultdict(list)
    for i, r in res.items():
        if r: by[d[i]].append(r[0])
    m = {k: np.mean(v) for k, v in by.items()}; mk = sorted(m); mv = np.array([m[k] for k in mk])
    per = [np.mean([m[k] for k in mk if f(k)]) for f in PER]; t = mv.mean() / (mv.std(ddof=1) / np.sqrt(len(mv)))
    daily = []
    for k in days:
        ids = sorted(byday[k], key=lambda i: -(o[i] / pc[i]))[:TOP]; N = CASH / len(ids); s = 0.0
        for i in ids:
            r = res[i]
            if r: ret, nb, ns, fw = r; s += ret - max(0.0, (0.01 * nb + 0.02 * ns) / N - 0.0033 * fw)
        daily.append(s / len(ids))
    x = np.array(daily); tx = x.mean() / (x.std(ddof=1) / np.sqrt(len(x))); eq = np.cumprod(1 + x)
    fin = np.mean([v for k, v in zip(days, daily) if PER[2](k)]); dd = (eq / np.maximum.accumulate(eq) - 1).min()
    print(f"{name:36} {sum(len(v) for v in by.values()):5d} {mv.mean()*100:+6.2f}% {t:+5.1f} " + ' '.join(f'{q*100:+6.2f}%' for q in per)
          + f" | {x.mean()*100:+7.2f}% {tx:+5.1f} {fin*100:+6.2f}% {dd*100:+7.1f}% {x.min()*100:+7.1f}%")
print("\n주의: 이 데이터로 지금까지 시험한 규칙이 수십 개라, 여기서 '제일 나은 것'도 운일 수 있음 — 지금 규칙보다 t가 확실히(+1 이상) 높지 않으면 바꿀 이유 없음")
