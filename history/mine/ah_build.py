# 애프터장 전용 규칙 찾기 1단계 (2026-11-24): 16:00에 알 수 있는 정보 + 애프터장 분봉만 뽑아 results/mine/ah_events.pkl 로 저장
# 후보: 16:00 종가가 전일 종가 +15% 이상, 종가 $1~20, ETF·ETN 제외 (ext.py와 같은 조건 — 정규장 고가도 +15% 이상이라 급등일 목록에서 빠지는 종목이 없음)
# 분봉 있는 후보는 다 씀(빠진 15%는 상승 폭이 작고 비싼 쪽이지만 다음 날 시가 수익은 비슷: -0.12% vs -0.24%). full=그날 빠짐없이 받은 날인지
import os, sys, csv, json, pickle, collections
HERE = os.path.dirname(os.path.abspath(__file__)); H = os.path.dirname(HERE); sys.path.insert(0, H)
import et, ext
D = os.path.join(H, 'data'); OUT = os.path.join(H, 'results', 'mine')
types = json.load(open(os.path.join(D, 'stock_types.json')))
ev = collections.defaultdict(list)
for r in csv.DictReader(open(os.path.join(D, 'events.csv'), encoding='utf-8-sig')):
    try: pc, c = float(r['전일종가']), float(r['종가'])
    except ValueError: continue
    if pc > 0 and 1 <= c <= 20 and c / pc - 1 >= 0.15 and types.get(r['종목']) not in ('ETF', 'ETN'): ev[r['날짜']].append((r['종목'], pc, c))
days = sorted(x for x in os.listdir(os.path.join(D, 'minute')) if x[:2] == '20')
K, PARTS = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (0, 1)  # 오래 걸려서 날짜를 나눠 처리: python mine/ah_build.py k K
n0 = len(days); days = days[K * n0 // PARTS:(K + 1) * n0 // PARTS]
rows, ndays, nfull, miss = [], 0, 0, 0
for d in days:
    cand = ev.get(d, []);
    if not cand: continue
    ndays += 1; have = set(f[:-5] for f in os.listdir(os.path.join(D, 'minute', d)) if f.endswith('.json'))
    full = all(s in have for s, _, _ in cand); nfull += full; miss += not full; o_ts, c_ts = et.session(d)
    for s, pc, c_off in cand:
        if s not in have: continue
        bars = sorted(json.load(open(os.path.join(D, 'minute', d, s + '.json'))))
        reg = [b for b in bars if o_ts <= b[0] < c_ts]
        if not reg: continue
        close = reg[-1][4]; hi = max(b[2] for b in reg); lo = min(b[3] for b in reg)
        p1530 = next((b[4] for b in reversed(reg) if b[0] <= c_ts - 30 * 60_000), reg[0][1])
        dv = sum(b[4] * b[5] for b in reg)
        ah = [(int((b[0] - c_ts) // 60_000), b[1], b[2], b[3], b[4], b[5]) for b in bars if c_ts <= b[0] < c_ts + 4 * 3600_000]
        rows.append(dict(d=d, s=s, pc=pc, close=close, hi=hi, lo=lo, p1530=p1530, dv=dv, ah=ah, nxo=ext.next_open(d, s), full=full))
pickle.dump(rows, open(os.path.join(OUT, f'ah_events_{K}of{PARTS}.pkl' if PARTS > 1 else 'ah_events.pkl'), 'wb'))
print(f"후보 있는 날 {ndays}일 중 빠짐없이 받은 날 {nfull}일 (빠진 날 {miss}일), 후보 {len(rows)}건 → results/mine/ah_events.pkl")
