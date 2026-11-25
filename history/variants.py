# ※ 예전 스크립트 — 지금은 python history/analyze.py 를 쓰세요 (f 명령이 이걸 대신해요)
# 받은 분봉 전체로 F와 변형들을 비교해요.  실행: python3 history/variants.py
# 날짜를 홀수·짝수 번째로 반 나눠서 두 쪽 모두 좋은지도 봐요 (한쪽에서만 좋으면 우연일 가능성이 큼).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backtest as B

V = {
  'F 지금 그대로':            {},
  '보유 90분':                {'hold': 90},
  '보유 30분':                {'hold': 30},
  '익절16 손절8 3시간':       {'tp': 0.16, 'sl': 0.08, 'hold': 180},
  '익절8 손절5':              {'tp': 0.08},
  '본전손절 +4%':             {'be': 0.04},
  '추적손절 +10%부터 4%':     {'trailStart': 0.10, 'trail': 0.04},
  '5분 낙폭 2% 이상만':       {'minDrop5': 0.02},
  'VWAP 아래 8% 이상만':      {'minBelow': 0.08},
  '5분 -8% 넘는 폭락 제외':   {'maxDrop5': 0.08},
  '양봉 확인 후 매수':        {'upbar': True},
  '당일 +30% 이상만':         {'minGain': 0.30},
  '$1 이상만':                {'minPx': 1.0},
  '비용 1.5배(스프레드 넓게)': {'sprMult': 1.5},
  '손절 미끄러짐 0.3%':        {'stopSlip': 0.003},
  '(참고) 비용 0':             {'sprMult': 0, 'fee': 0, 'sellExtra': 0, 'stopSlip': 0},
}
# python3 history/variants.py 0/2  → 변형 목록을 2개로 나눈 것 중 첫째만 (코어 여러 개로 나눠 돌릴 때)
if len(sys.argv) > 1 and '/' in sys.argv[1]:
    k, m = map(int, sys.argv[1].split('/')); V = {n: v for i, (n, v) in enumerate(V.items()) if i % m == k}

days = B.days_massive()
if not days: sys.exit('분봉이 아직 없어요. fetch.mjs 2단계가 시작된 뒤에 실행해 주세요.')
data = {d: B.load_massive(d) for d in days}
n_ev = sum(len(x) for x in data.values())
print(f'분봉 {n_ev}건, {len(days)}거래일 ({days[0]} ~ {days[-1]})')
half = {d: i % 2 for i, d in enumerate(days)}
print(f"{'':26} {'전체 (신호 전부)':>58} | {'반쪽 A':>14} {'반쪽 B':>14} | 봇처럼 제한")
for name, kw in V.items():
    P = dict(B.BASE); P.update(kw)
    T = []
    for d in days: T += B.run_day(data[d], d, P)
    s = B.summary(T, P['size'])
    if not s.get('n'): print(f'{name:26} 거래 없음'); continue
    hs = [B.summary([x for x in T if half[x['d']] == h], P['size']) for h in (0, 1)]
    pf = B.summary(B.portfolio(T, P), P['size'])
    hstr = ' '.join(f"{h['mean']*100:+6.2f}%({h['n']:4d})" if h.get('n') else '      -      ' for h in hs)
    print(f"{name:26} {s['n']:5d}건 평균 {s['mean']*100:+5.2f}% ±{s['se']*196:.2f} 중간 {s['med']*100:+5.1f}% 승률 {s['win']*100:4.1f}% | {hstr} | 하루 ${pf.get('usd_day', 0):+5.2f}")
