# 5분 시가범위 돌파(ORB) — Zarattini·Barbon·Aziz (2024) 규칙 그대로, 2024~2026 'Stocks in Play' 분봉으로 표본 밖 검증
#   python3 history/orb_sip.py                 → 빠진 종목 없는 날만, 기본 비용
#   python3 history/orb_sip.py --from 2026-09-05 --to 2026-11-13
# 규칙: 매일 후보(레버리지·인버스 ETF, ETN 제외) 중 (첫 5분 거래량 ÷ 14일 평균 하루 거래량) 상위 20 → 첫 5분봉이 양봉이면 그 고점을 넘을 때 매수(롱만)
#       손절 = 진입가 - ATR14 × 10%, 손절 안 걸리면 장 마감 청산
#   * 논문의 상대거래량은 '첫 5분 거래량 ÷ 지난 14일 첫 5분 평균'. 지난 날 분봉이 없어서 하루 평균 거래량으로 대신함(순위는 거의 같음).
#     논문의 '상대거래량 100% 이상' 조건은 첫 5분 거래량 ≥ 하루 평균의 4%로 근사.
# 비용(기본): 수수료 0.1%씩(+매도 규제수수료 0.03%), 스프레드 0.2%(사고팔 때 반씩), 돌파 매수 미끄러짐 0.1%, 손절 미끄러짐 0.3%
import os, sys, json, csv, glob, math, argparse, statistics as st, collections, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.environ.get('HIST_DATA') or os.path.join(HERE, 'data')
sys.path.insert(0, HERE); import et  # 동부시간 계산 (zoneinfo 없이)
MIN = 60_000
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)

def session(d):
    return et.session(d)

def load_candidates(stocks_only=True):
    # stock_types.json (orb_paper.mjs --types 로 받은 종류·배율)이 있으면 레버리지·인버스 ETF와 ETN은 뺌. 일반 ETF·ADR·토스에 없는 종목은 남김
    tf = os.path.join(D, 'stock_types.json'); types = json.load(open(tf)) if stocks_only and os.path.exists(tf) else {}
    by = collections.defaultdict(dict)
    for r in csv.DictReader(open(os.path.join(D, 'sip_events.csv'), encoding='utf-8')):
        t = types.get(r['종목'])
        if isinstance(t, dict) and (t.get('type') == 'ETN' or (t.get('type') == 'ETF' and t.get('lev') != 1)): continue  # 레버리지·인버스 ETF, ETN만 뺌
        if isinstance(t, str) and t in ('ETF', 'ETN'): continue   # 예전 형식(배율 없음)이면 ETF·ETN 전부 뺌
        by[r['날짜']][r['종목']] = dict(pc=float(r['전일종가']), adv=float(r['평균거래량14']), atr=float(r['ATR14']))
    return by

def day_trades(d, C, top=20, rv_min=0.04, stop_ks=None):  # stop_ks를 주면 {손절배수: 거래 목록}을 돌려줌 (파일은 한 번만 읽음)
    o_ts, c_ts = session(d); setups = []
    for T, c in C.items():
        f = os.path.join(D, 'minute_sip', d, safe(T) + '.json')
        bars = sorted(json.load(open(f)))
        orb = [b for b in bars if o_ts <= b[0] < o_ts + 5 * MIN]
        if not orb: continue
        v5 = sum(b[5] for b in orb)
        setups.append(dict(T=T, bars=bars, o=orb[0][1], c=orb[-1][4], h=max(b[2] for b in orb), rv=v5 / max(c['adv'], 1), atr=c['atr']))
    ks = stop_ks or (0.10,); outs = {k: [] for k in ks}
    for x in sorted([s for s in setups if s['rv'] >= rv_min], key=lambda s: -s['rv'])[:top]:
        if not (x['c'] > x['o']): continue                      # 첫 5분 양봉만 (음봉이면 논문은 공매도 → 우리는 안 함)
        after = [b for b in x['bars'] if o_ts + 5 * MIN <= b[0] < c_ts]
        for j, (t, o, h, l, c, v, *_ ) in enumerate(after):
            if h > x['h']:
                e = max(o, x['h'])
                for k in ks:
                    stop = e - k * x['atr']; why = '마감'; xp = after[-1][4]
                    if c <= stop: why, xp = '손절', stop                # 진입한 봉에서 바로 손절선 아래로 마감
                    else:
                        for t2, o2, h2, l2, c2, *_ in after[j + 1:]:
                            if o2 <= stop: why, xp = '손절', o2; break
                            if l2 <= stop: why, xp = '손절', stop; break
                    outs[k].append(dict(d=d, T=x['T'], e=e, x=xp, stop_pct=(e - stop) / e, why=why, rv=x['rv'], t=t))
                break
    return outs if stop_ks else outs[0.10]

def net(tr, k=1.0):  # k: 스프레드·미끄러짐 배수 (수수료는 고정)
    s, es, ss = 0.002 * k, 0.001 * k, 0.003 * k
    e = tr['e'] * (1 + s / 2) * (1 + es)
    x = tr['x'] * (1 - s / 2) * (1 - (ss if tr['why'] == '손절' else 0))
    return x * (1 - 0.001 - 0.0003) / (e * 1.001) - 1

def stat(v):
    if len(v) < 2: return f'{len(v)}건'
    m = st.mean(v); se = st.pstdev(v) / math.sqrt(len(v))
    return f'{len(v):5d}건 거래당 {m*100:+.2f}% (t={m/se:+.1f})'

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--from', dest='fr', default='0000'); ap.add_argument('--to', default='9999'); ap.add_argument('--count-only', action='store_true')
    a = ap.parse_args(); C = load_candidates()
    have = {d: {f[:-5] for f in os.listdir(os.path.join(D, 'minute_sip', d))} for d in os.listdir(os.path.join(D, 'minute_sip'))} if os.path.isdir(os.path.join(D, 'minute_sip')) else {}
    days = sorted(d for d in C if a.fr <= d <= a.to and d in have and all(safe(T) in have[d] for T in C[d]))
    T = []
    for d in days: T += day_trades(d, C[d])
    print(f'빠진 종목 없는 날 {len(days)}일 ({days[0] if days else "-"} ~ {days[-1] if days else "-"}), 거래 {len(T)}건, 손절 {sum(x["why"]=="손절" for x in T)}건')
    if a.count_only or not T: sys.exit()
    g = [x['x'] / x['e'] - 1 for x in T]
    print('비용 전              ', stat(g))
    for k, lab in [(1, '기본 비용'), (0.5, '비용 절반(스프레드·미끄러짐)'), (2, '비용 2배')]: print(f'{lab:20}', stat([net(x, k) for x in T]))
    R = [net(x) / x['stop_pct'] for x in T]; print(f'손절폭 대비(R) 평균 {st.mean(R):+.2f}R, 손절폭 중간값 {st.median(x["stop_pct"] for x in T)*100:.2f}%, 승률 {sum(net(x)>0 for x in T)/len(T)*100:.0f}%')
    M = collections.defaultdict(list)
    for x in T: M[x['d'][:7]].append(net(x))
    print('월별(기본 비용):', ' '.join(f"{m[2:]}:{len(v)}건 {st.mean(v)*100:+.2f}%" for m, v in sorted(M.items())))
    r = sorted(net(x) for x in T); print(f'상위 2% 거래 빼면 거래당 {st.mean(r[:max(1, int(len(r)*0.98))])*100:+.2f}%')
