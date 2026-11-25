# ※ 예전 스크립트 — 지금은 python history/analyze.py 를 쓰세요 (f 명령이 이걸 대신해요)
# 분봉이 많을 때: 날짜를 나눠 여러 번에 걸쳐 백테스트하고 결과를 history/results/에 쌓아요 (이어서 실행 가능).
#   python3 history/run_chunks.py 0/2 160   → 2개로 나눈 날짜 중 첫째 몫을, 160초 동안만
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backtest as B
VARIANTS = {
    'F': {},
    'F_낙관': {'amb': 'tp', 'stopSlip': 0.003, 'tpMid': True},
    'T16_8_180': {'tp': 0.16, 'sl': 0.08, 'hold': 180},
}
k, m = map(int, sys.argv[1].split('/')); budget = float(sys.argv[2]) if len(sys.argv) > 2 else 160
OUT = os.path.join(B.HERE, 'results'); os.makedirs(OUT, exist_ok=True)
doneF = os.path.join(OUT, f'done_{k}.txt'); resF = os.path.join(OUT, f'trades_{k}.jsonl')
done = set(open(doneF).read().split()) if os.path.exists(doneF) else set()
t0 = time.time(); days = [d for i, d in enumerate(B.days_massive()) if i % m == k and d not in done]
n = 0
for d in days:
    if time.time() - t0 > budget: break
    data = B.load_massive(d)
    with open(resF, 'a') as f:
        for v, kw in VARIANTS.items():
            P = dict(B.BASE); P.update(kw)
            for x in B.run_day(data, d, P): x['v'] = v; x['nsym'] = len(data); f.write(json.dumps(x, ensure_ascii=False) + '\n')
    with open(doneF, 'a') as f: f.write(d + '\n')
    n += 1
print(f'[{k}/{m}] 이번에 {n}일, 남은 {len(days) - n}일, {time.time() - t0:.0f}초')
