# 갭 봇이 '실제로 사는 방식' 그대로 백테스트 (2026-11-26)
# variants2~6은 후보를 전부 따로 샀다고 계산함. 실제 봇(orb/gap_dip.mjs)은:
#   현금 전부로 한 번에 한 종목, 갭 큰 순서로 지정가 주문을 하나씩 걸고, 주문이 걸린 동안 다른 후보는 안 봄.
#   이미 지정가에 닿았던 후보는 건너뜀 (닿은 지 2분 안이고 지금도 지정가 이하면 삼). 14:30 뒤 새 주문 없음. 하루 체결 5회.
# 비교: '현금을 후보 수로 나눠 전부 동시에 걸기' (백테스트 평균에 가까움)
# 근사: 분봉 단위라 같은 분 안의 순서는 모름 → 청산한 그 분에 닿은 후보는 '이미 닿음'으로 봄 (보수적). 후보는 9:30에 다 보인다고 봄.
# 실행: python history/mine/bot_policy_gap.py → 결과 results/mine/bot_policy_gap.txt
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants6_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("rows = []")[0], p, 'exec'))
SM, TM, MAXN = .80, 1.10, 5
first = {i: (j, pe) for i, j, pe in E}  # 지정가에 처음 닿은 분, 체결가 (14:30까지)
byday = collections.defaultdict(list)
for i in cand: byday[d[i]].append(i)

def trade(i, j, pe):
    px, t, k = tr2(i, j, pe, SM, TM, LAST); return net2(pe, px, t, k), k

def bot_day(ids, daylim=None):  # daylim: 하루 손실이 계좌의 이 비율 이상이면 그날 새로 안 삼 (live.json 하루 한도)
    ids = sorted(ids, key=lambda i: -(o[i] / pc[i])); lv = {i: fl(o[i] * 0.95) for i in ids}
    done, out, f, start = set(), [], OPEN, True
    while f <= LASTIN and len(out) < MAXN and not (daylim and np.prod([1 + r for r in out]) - 1 <= -daylim):
        nxt = None
        for i in ids:
            if i in done: continue
            done.add(i); jt = first.get(i)
            if jt is None: nxt = ('block', i); break                      # 14:30까지 안 닿음 → 주문이 그때까지 묶임
            j, pe = jt
            if j > f or (start and j == f): nxt = ('fill', i, j, pe); break  # 아직 안 닿음 → 주문 걸고 닿을 때 체결
            c = CL[i][f]
            if f - j <= 2 and not isn(c) and c <= lv[i]: nxt = ('fill', i, f, min(c, lv[i])); break  # 방금 닿았고 아직 지정가 아래
        if nxt is None or nxt[0] == 'block': break
        r, k = trade(*nxt[1:]); out.append(r); f, start = k, False
    return out

def split_day(ids, top=None, cash=None):  # 현금을 후보 수로 나눠 동시에 지정가 — 안 닿은 몫은 수익 0. top: 갭 큰 몇 개만
    ids = sorted(ids, key=lambda i: -(o[i] / pc[i]))[:top]
    # cash: 그 돈을 나눌 때 토스 최소 수수료($0.01×2 + 세금 $0.01)가 모형 비용(0.1%×2 + 0.13%)보다 큰 만큼 더 뺌
    extra = max(0.0, 0.03 / (cash / len(ids)) - 0.0033) if cash else 0.0
    return sum(trade(i, *first[i])[0] - extra for i in ids if i in first) / len(ids)

days = sorted(byday)
CASH, DAY_USD, TOT_USD = 22.0, 3.0, 10.0  # 2026-11-26 계좌·live.json 한도
allr = {k: [trade(i, *first[i])[0] for i in byday[k] if i in first] for k in days}
PER = [('찾기', lambda x: x < '2025-11-01'), ('확인', lambda x: '2025-11-01' <= x < '2026-05-01'), ('최종', lambda x: x >= '2026-05-01')]

def per_trade(R):  # 날마다 평균 → 날짜 평균 (다른 variants와 같은 방식)
    m = np.array([np.mean(R[k]) for k in days if R[k]]); return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))

n_cand = sum(len(v) for v in byday.values())
print(f"후보(시가 $1~3, 갭 +15%↑) {n_cand}건 / {len(days)}일 (후보 있는 날만), 그중 14:30까지 지정가 닿음 {len(first)}건")
a, t = per_trade(allr)
print(f"백테스트식(후보 전부 따로 산다고 침): {len(first)}건, 거래당 {a*100:+.2f}% (t={t:+.1f}) — variants6의 '지금: 15:58 정리'와 같아야 함\n")
print("계좌로 보면 (현금 전부를 굴림, 후보 있는 날 기준):")
print(f"{'방식':30} {'거래':>5} {'거래당':>7} | {'하루평균':>8} {'t':>5} | " + ' '.join(f'{n:>7}' for n, _ in PER) + f" | {'2년 복리':>9} {'최대낙폭':>8} {'최악하루':>8}")
def row(name, daily, trades=None):
    x = np.array(daily); t = x.mean() / (x.std(ddof=1) / np.sqrt(len(x))); ps = [np.mean([v for k, v in zip(days, daily) if f(k)]) for _, f in PER]
    eq = np.cumprod(1 + x); dd = (eq / np.maximum.accumulate(eq) - 1).min()
    tr = f"{len(trades):5d} {np.mean(trades)*100:+6.2f}%" if trades is not None else f"{'':5} {'':7}"
    print(f"{name:30} {tr} | {x.mean()*100:+7.2f}% {t:+5.1f} | " + ' '.join(f'{q*100:+6.2f}%' for q in ps) + f" | {(eq[-1]-1)*100:+8.0f}% {dd*100:+7.1f}% {x.min()*100:+7.1f}%")
    return eq
dprod = lambda R: [float(np.prod([1 + r for r in R[k]]) - 1) for k in days]
bot = {k: bot_day(byday[k]) for k in days}
botL = {k: bot_day(byday[k], DAY_USD / CASH) for k in days}
row('실제 봇: 현금 전부·한 종목씩', dprod(bot), [r for k in days for r in bot[k]])
eqL = row(f'  + 하루 손실 한도 ${DAY_USD:g}/${CASH:g}', dprod(botL), [r for k in days for r in botL[k]])
row('현금을 후보 수로 나눠 동시에', [split_day(byday[k]) for k in days])
row('  갭 큰 5개만', [split_day(byday[k], 5) for k in days])
row(f'  갭 큰 5개만, ${CASH:g} 최소 수수료', [split_day(byday[k], 5, CASH) for k in days])
row(f'  갭 큰 3개만, ${CASH:g} 최소 수수료', [split_day(byday[k], 3, CASH) for k in days])
hit = next((k for k, e in zip(days, eqL) if (e - 1) * CASH <= -TOT_USD), None)
print(f"\n누적 손실 한도 ${TOT_USD:g} (계좌 ${CASH:g}): 하루 한도 넣은 봇이 {'처음 걸리는 날 ' + hit + f' (후보 있는 날 {days.index(hit)+1}일째)' if hit else '2년 동안 안 걸림'}")
b1 = [bot[k][0] for k in days if bot[k]]; skipped = sum(1 for k in days if not bot[k] and allr[k])
print(f"실제 봇: 거래 있는 날 {sum(1 for k in days if bot[k])}일, 후보는 닿았는데 봇은 못 산 날 {skipped}일 (먼저 건 주문이 안 닿아 묶이거나 이미 닿고 튐)")
print(f"하루 첫 거래 평균 {np.mean(b1)*100:+.2f}% ({len(b1)}건, 갭 제일 큰 후보 위주), 둘째 이후 평균 {np.mean([r for k in days for r in bot[k][1:]])*100:+.2f}% (첫 거래가 일찍 끝난 날)")
