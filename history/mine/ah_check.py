# 애프터장 기본 규칙 검증 (2026-11-24): '종가 -X% 지정가 → 목표/손절' 이 애프터장 이상한 체결(드문 거래·튀는 가격) 때문에 좋아 보이는지
import os, pickle, collections, numpy as np
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); OUT = os.path.join(H, 'results', 'mine')
rows = pickle.load(open(os.path.join(OUT, 'ah_events.pkl'), 'rb')); LASTX, LASTIN = 230, 180
def sim(r, dip, tp, sl, sp=0.0162, minvol=0, mindv=0, after=0):
    c = r['close']; ah = [b for b in r['ah'] if b[0] <= LASTX]; s_ah = max(sp, 0.01 / c); lv = c * (1 - dip)
    k = next((i for i, b in enumerate(ah) if after <= b[0] <= LASTIN and b[3] < lv and b[5] >= minvol and b[5] * b[4] >= mindv), None)
    if k is None: return None
    pe = min(ah[k][1], lv); buy = pe * 1.001; stop, tgt = pe * (1 - sl), pe * (1 + tp)
    o = lambda px, kd: px * (1 - (0 if kd == 'tp' else s_ah / 2)) * (1 - (0.005 if kd == 'st' else 0)) * (1 - 0.0013) / buy - 1
    if ah[k][3] <= stop: return o(stop, 'st'), 'st', ah[k][0], 0, ah[k][5]
    for b in ah[k + 1:]:
        if b[3] <= stop: return o(min(b[1], stop), 'st'), 'st', ah[k][0], b[0] - ah[k][0], ah[k][5]
        if b[2] > tgt: return o(max(b[1], tgt), 'tp'), 'tp', ah[k][0], b[0] - ah[k][0], ah[k][5]
    last = ah[k + 1:][-1] if ah[k + 1:] else ah[k]
    return o(last[4], 'cl'), 'cl', ah[k][0], last[0] - ah[k][0], ah[k][5]
d = np.array([r['d'] for r in rows]); px = np.array([r['close'] for r in rows]); full = np.array([r['full'] for r in rows])
P = [('찾기', d < '2025-11-01'), ('확인', (d >= '2025-11-01') & (d < '2026-05-01')), ('최종', d >= '2026-05-01')]
def show(lab, res, sel=None):
    m = np.array([x is not None for x in res]) & (sel if sel is not None else True)
    if m.sum() < 10: print(f"  {lab:40} {m.sum()}건"); return
    v = np.array([x[0] if x is not None else np.nan for x in res])
    def dmean(mm):
        by = collections.defaultdict(list)
        for dd, x in zip(d[mm], v[mm]): by[dd].append(x)
        a = np.array([np.mean(x) for x in by.values()]); return a.mean(), (a.mean() / (a.std(ddof=1) / np.sqrt(len(a))) if len(a) > 2 else np.nan), mm.sum()
    a = dmean(m); ps = [dmean(m & pm) for _, pm in P]
    kinds = collections.Counter(res[i][1] for i in np.where(m)[0])
    print(f"  {lab:40} {a[2]:5d}건 {a[0]*100:+6.2f}% (t={a[1]:+4.1f}) | " + ' '.join(f"{n} {x[0]*100:+6.2f}%({x[2]})" for (n, _), x in zip(P, ps)) + f" | 목표 {kinds['tp']/a[2]*100:.0f}% 손절 {kinds['st']/a[2]*100:.0f}% 정리 {kinds['cl']/a[2]*100:.0f}%")
for dip, tp, sl in ((.10, .10, .20), (.10, .10, .10), (.05, .05, .10)):
    print(f"— 종가 -{int(dip*100)}% 지정가 → 목표 +{int(tp*100)}% / 손절 -{int(sl*100)}% / 19:50 정리")
    base = [sim(r, dip, tp, sl) for r in rows]
    show('기본 (스프레드 1.62%)', base)
    show('스프레드 4.11% (75% 지점)', [sim(r, dip, tp, sl, sp=0.0411) for r in rows])
    show('체결 분 거래량 1,000주↑', [sim(r, dip, tp, sl, minvol=1000) for r in rows])
    show('체결 분 거래대금 $5,000↑', [sim(r, dip, tp, sl, mindv=5000) for r in rows])
    show('17:00 이후 체결만', [sim(r, dip, tp, sl, after=60) for r in rows])
    show('빠짐없이 받은 날만', base, full)
    show('$1~3만', base, px < 3)
    q = np.array([x is not None and x[1] == 'tp' and x[3] <= 3 for x in base])
    show('[진단] 3분 안에 목표 닿은 거래 빼면', base, ~q)
    tq = [x for x in base if x is not None]
    print(f"    체결 뒤 목표까지 걸린 시간 중간값 {np.median([x[3] for x in tq if x[1]=='tp']):.0f}분, 체결 분 거래량 중간값 {np.median([x[4] for x in tq]):.0f}주, 체결 시각 중간값 16:{int(np.median([x[2] for x in tq])):02d}+")
