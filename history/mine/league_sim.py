# 봇 성격 리그 (2026-11-27): 성격이 다른 가상 봇 5마리가 같은 갭 후보로 2년 동안 매매한 결과를 만듦.
# 결과 → orb/league/league.json (토스 봇 화면 '봇 리그' 탭이 읽음). 실행: py -3 history/mine/league_sim.py
# 규칙: 매일 갭 후보(시가 $1~3, 갭 +15%↑)에서 봇 성격이 고른 종목에 자금을 똑같이 나눠 지정가(시가 -5%)를 건다.
#       닿은 종목만 체결, 나머지 몫은 놀아서 0%. 체결 뒤 익절·손절·15:58(ET) 정리는 성격마다 다름.
#       갭 봇 실전 모형(variants6)과 같은 체결·수수료 계산을 씀 (bot_policy_gap.py와 같은 exec 방식).
import os, json, random, datetime, numpy as np
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants6_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("rows = []")[0], p, 'exec'))
first = {i: (j, pe) for i, j, pe in E}  # 지정가에 처음 닿은 분, 체결가 (14:30까지)
byday = collections.defaultdict(list)
for i in cand: byday[d[i]].append(i)
days = sorted(byday)
CASH = 22.0  # 2026-11-26 계좌 (live.json과 같은 돈)

# 성격 5종. gap: 최소 갭, pick: 한 날 고르는 종목 수(갭 큰 순), sm: 손절 배율(0.80 = -20%), tm: 익절 배율(1.10 = +10%)
PROFILES = [
    dict(key='coward', name='겁쟁이', gap=0.20, pick=5, sm=0.95, tm=1.05, desc='갭 20%↑만, 5% 먹고 5% 잃으면 바로 손 뗌'),
    dict(key='gambler', name='도박꾼', gap=0.15, pick=1, sm=0.80, tm=1.30, desc='갭 제일 큰 한 종목에 전부, +30% 아니면 -20%'),
    dict(key='scalper', name='칼손절', gap=0.15, pick=5, sm=0.92, tm=1.05, desc='자주 사고 +5% 익절, -8% 손절'),
    dict(key='holder', name='존버', gap=0.15, pick=5, sm=0.80, tm=1.30, desc='+30%까지 기다림, -20%만 끊음'),
    dict(key='random', name='랜덤', gap=0.15, pick=1, sm=0.80, tm=1.10, desc='후보 중 아무거나 한 종목, +10% / -20%'),
]

def gap_of(i): return o[i] / pc[i] - 1

def simulate(pr):
    rng = random.Random(7)  # 랜덤봇도 매번 같은 결과가 나오게
    eq, out, trades = CASH, [], []
    for k in days:
        ids = [i for i in byday[k] if gap_of(i) >= pr['gap']]
        ids = sorted(ids, key=lambda i: -gap_of(i))
        if pr['key'] == 'random': ids = rng.sample(ids, min(1, len(ids)))
        else: ids = ids[:pr['pick']]
        if not ids: out.append({'date': k, 'ret': 0.0, 'equity': round(eq, 2), 'trades': []}); continue
        day, day_tr = 0.0, []
        for i in ids:
            if i not in first: continue  # 14:30까지 지정가에 안 닿음 → 안 삼
            j, pe = first[i]
            px, why, kk = tr2(i, j, pe, pr['sm'], pr['tm'], LAST)
            r = net2(pe, px, why, kk)
            day += r / len(ids)
            day_tr.append({'sym': str(T[i]), 'gap': round(gap_of(i), 4), 'entry': round(pe, 4), 'exit': round(px, 4),
                           'reason': {'tp': '익절', 'st': '손절', 'cl': '정리'}[why], 'ret': round(r, 4)})
        eq *= 1 + day
        out.append({'date': k, 'ret': round(day, 5), 'equity': round(eq, 2), 'trades': day_tr})
        trades += day_tr
    return out, trades

def summary(daily, trades):
    eqs = np.array([CASH] + [x['equity'] for x in daily]); rets = np.array([x['ret'] for x in daily])
    dd = (eqs / np.maximum.accumulate(eqs) - 1).min()
    traded = [x for x in daily if x['trades']]
    return {
        'total': round(eqs[-1] / CASH - 1, 4), 'equity': round(eqs[-1], 2), 'days': len(daily), 'tradeDays': len(traded),
        'trades': len(trades), 'wins': sum(t['ret'] > 0 for t in trades), 'losses': sum(t['ret'] < 0 for t in trades),
        'winDays': sum(x['ret'] > 0 for x in traded), 'worstDay': round(float(rets.min()), 4), 'bestDay': round(float(rets.max()), 4),
        'maxDrawdown': round(float(dd), 4), 'last30': round(float(eqs[-1] / eqs[max(0, len(eqs) - 31)] - 1), 4),
    }

bots = []
for pr in PROFILES:
    daily, trades = simulate(pr)
    bots.append({'key': pr['key'], 'name': pr['name'], 'desc': pr['desc'], 'rule': {'gapMin': pr['gap'], 'pick': pr['pick'], 'stop': round(1 - pr['sm'], 2), 'target': round(pr['tm'] - 1, 2)},
                 'summary': summary(daily, trades), 'daily': daily})
    print(f"{pr['name']:4} 최종 ${bots[-1]['summary']['equity']:.2f} ({bots[-1]['summary']['total']*100:+.0f}%), 거래 {len(trades)}건, 최대낙폭 {bots[-1]['summary']['maxDrawdown']*100:+.1f}%")

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'orb', 'league')
os.makedirs(out_dir, exist_ok=True)
doc = {'generatedAt': datetime.datetime.now().isoformat(timespec='seconds'), 'start': days[0], 'end': days[-1], 'cash': CASH,
       'note': '2년 백테스트 리플레이 (실제 주문 아님). 같은 후보·같은 체결 모형으로 성격만 바꿈.', 'bots': bots}
with open(os.path.join(out_dir, 'league.json'), 'w', encoding='utf-8') as f: json.dump(doc, f, ensure_ascii=False, indent=1, default=lambda x: x.item())  # numpy 숫자 → 파이썬 숫자
print('wrote', os.path.normpath(os.path.join(out_dir, 'league.json')))
