# 정규장 밖 전략 (2026-11-20). 지금 데이터로 공정하게 시험할 수 있는 것만:
#   A1  급등주 종가 매수 → 애프터장 19:50 매도
#       조건: 16:00 종가가 전일 종가 +15% 이상, 주가 $1~20 (정규장 고가도 +15% 이상이라 급등일 목록에서 빠지는 종목이 없음)
#       매수: 종가 지정가(LOC)로 16:00 종가 → 스프레드 없음 / 매도: 19:50 직전 애프터장 마지막 체결가에서 매수호가로(스프레드 절반)
#       애프터장 거래가 없으면 다음 날 정규장 시가에 매도
# 프리장 전략은 시험하지 않음: Massive 일봉 고가가 정규장 기준이라 급등일 목록엔 '정규장에서도 +15% 오른 날'만 있음
#   → 프리장에 올랐다가 개장 전에 꺼진 종목이 빠져서 결과가 부풀려짐
# 비용: 수수료 0.1%씩 + 매도 0.03%, 애프터장 스프레드 = 토스 녹화 실측(급등주 $1~20) 중간값 1.62% / 75% 지점 4.11%
import os, json, bisect, glob
import et
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.environ.get('HIST_DATA') or os.path.join(HERE, 'data')
AH_SPREAD = {'중간값': 0.0162, '75%': 0.0411}
_dd = None
def _daily_dates():
    global _dd
    if _dd is None: _dd = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(D, 'daily', '*.json')) if os.path.getsize(f) > 2)
    return _dd
def next_open(d, T, cache={}):
    ds = _daily_dates(); i = bisect.bisect_right(ds, d)
    if i >= len(ds): return None
    nd = ds[i]
    if nd not in cache: cache.clear(); cache[nd] = {r[0]: r[1] for r in json.load(open(os.path.join(D, 'daily', nd + '.json')))}
    return cache[nd].get(T)

def run_day(d, data, ev):
    o_ts, c_ts = et.session(d); exit_ts = c_ts + (3 * 60 + 50) * 60_000  # 19:50 ET
    out = []
    for fn, bars in data.items():
        e = ev.get(fn)
        if not e: continue
        pc = float(e['전일종가']); bars = sorted(bars)
        reg = [b for b in bars if o_ts <= b[0] < c_ts]
        if not reg: continue
        close = reg[-1][4]
        if not (1 <= close <= 20) or close / pc - 1 < 0.15: continue
        ah = [b for b in bars if c_ts <= b[0] < exit_ts]
        if ah: x_raw, where = ah[-1][4], '애프터장'
        else:
            x_raw = next_open(d, e['종목'])
            if not x_raw or not (1 / 3 < x_raw / close < 3): continue
            where = '다음 날 시가'
        g = x_raw / close - 1
        rec = dict(d=d, sym=e['종목'], t=c_ts, px=close, x=x_raw, g=g, why=where, gain=close / pc - 1, ah_vol=sum(b[5] for b in ah))
        for lab, s in AH_SPREAD.items():
            sp = s if where == '애프터장' else 0.008   # 다음 날 시가는 정규장 스프레드
            rec['r' if lab == '중간값' else 'r75'] = x_raw * (1 - sp / 2) * (1 - 0.0013) / (close * 1.001) - 1
        out.append(rec)
    return out
