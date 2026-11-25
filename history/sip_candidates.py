# 논문(Zarattini·Barbon·Aziz 2024)의 'Stocks in Play' 후보를 일봉에서 골라 data/sip_events.csv로 저장
# 조건: 시가 $5~30, 14일 평균 거래량 100만 주 이상, 14일 ATR $0.5 이상, 그리고 (시가 갭 ±2% 이상 또는 하루 거래량이 평균의 2배 이상)
# → 첫 5분 거래량이 크게 터진 종목을 거의 다 포함하는 넓은 후보. 실제 순위(첫 5분 상대거래량 상위 20)는 분봉으로 다시 계산
import json, glob, os, collections, csv
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data')
hist = collections.defaultdict(lambda: collections.deque(maxlen=14)); lastc = {}; out = []
for f in sorted(glob.glob(os.path.join(D, 'daily', '*.json'))):
    d = os.path.basename(f)[:10]; rows = json.load(open(f))
    if not rows: continue
    for T, o, h, l, c, v, vw in rows:
        H = hist[T]; pc = lastc.get(T)
        if len(H) == 14 and pc and 5 <= o <= 30:
            adv = sum(x[0] for x in H) / 14; atr = sum(x[1] for x in H) / 14
            if adv >= 1e6 and atr >= 0.5 and (abs(o / pc - 1) >= 0.02 or v >= 2 * adv):
                out.append([d, T, pc, o, round(adv), round(atr, 4)])
        H.append((v, max(h - l, abs(h - pc), abs(l - pc)) if pc else h - l)); lastc[T] = c
with open(os.path.join(D, 'sip_events.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['날짜', '종목', '전일종가', '시가', '평균거래량14', 'ATR14']); w.writerows(out)
print('후보', len(out), '건 → data/sip_events.csv')
