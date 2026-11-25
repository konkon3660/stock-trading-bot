# 급등일마다 그 전 14거래일 기준 ATR(평균 하루 변동폭)과 평균 거래량을 일봉에서 계산해 data/event_stats.json에 저장
import json, glob, os, csv, collections
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data')
ev = list(csv.DictReader(open(os.path.join(D, 'events.csv'), encoding='utf-8-sig')))
need = collections.defaultdict(set)
for r in ev: need[r['종목']].add(r['날짜'])
files = sorted(glob.glob(os.path.join(D, 'daily', '*.json')))
hist = collections.defaultdict(lambda: collections.deque(maxlen=20))  # 종목별 최근 20거래일 (h, l, c, v, prevc)
last_c = {}; out = {}
for f in files:
    d = os.path.basename(f)[:10]; rows = json.load(open(f))
    if not rows: continue
    for T, o, h, l, c, v, vw in rows:
        if T in need and d in need[T]:
            H = [x for x in hist[T]][-14:]
            if len(H) >= 10:
                tr = [max(x[0] - x[1], abs(x[0] - x[4]), abs(x[1] - x[4])) if x[4] else x[0] - x[1] for x in H]
                out[f'{d}|{T}'] = dict(atr=sum(tr) / len(tr), adv=sum(x[3] for x in H) / len(H), advd=sum(x[3] * x[2] for x in H) / len(H))
        hist[T].append((h, l, c, v, last_c.get(T)))
        last_c[T] = c
json.dump(out, open(os.path.join(D, 'event_stats.json'), 'w'))
print('급등일', len(ev), '중 ATR·평균거래량 계산됨', len(out))
