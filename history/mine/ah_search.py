# 애프터장 전용 규칙 찾기 2단계 (2026-11-24, 사용자: "본장과는 다른 알고리즘으로") — results/mine/ah_events.pkl 사용
# 미리 정한 절차: 매수 5 × 매도 6 × 조건(상승폭 4 × 가격 3 × 종가 위치 3 × 마지막 30분 3) = 3,240개
#   찾기 기간(2024-12~2025-10)에서 거래 80건↑인 것 중 상위 30 → 확인 기간(2025-11~2026-04) 평균 플러스·t>2인 것만 → 최종 기간(2026-05~11) 한 번
# 비용: 수수료 0.1%씩 + 매도 0.03%, 애프터장 스프레드 max(1.62%, 1센트)(토스 녹화 급등주 중간값; 75% 지점 4.11%로도 따로 봄), 손절 미끄러짐 0.5%
#   지정가 매수·목표 매도는 스프레드 없음, 시장가 매수·손절·19:50 정리는 스프레드 절반. 애프터장 거래 없으면 다음 날 시가(정규장 스프레드 0.8%)
# 진입 1분 안 손절은 실전식(그 분 저가). 목표는 다음 분부터.
import os, sys, pickle, itertools, collections, numpy as np
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); OUT = os.path.join(H, 'results', 'mine')
rows = pickle.load(open(os.path.join(OUT, 'ah_events.pkl'), 'rb'))
SP = float(os.environ.get('AH_SPREAD', 0.0162)); LASTX = 230; LASTIN = 180
ENTRIES = ['LOC', 'M5', 'D3', 'D5', 'D10']; EXITS = [('H', None, None), ('5/5', .05, .05), ('5/10', .05, .10), ('10/10', .10, .10), ('10/20', .10, .20), ('20/20', .20, .20)]
def sim(r, en, tp, sl):
    c = r['close']; ah = [b for b in r['ah'] if b[0] <= LASTX]; s_ah = max(SP, 0.01 / c)
    if en == 'LOC': j, pe, mkt = -1, c, False
    elif en == 'M5':
        k = next((i for i, b in enumerate(ah) if b[0] <= 5), None)
        if k is None: return None
        j, pe, mkt = k, ah[k][1], True
    else:
        lv = c * (1 - int(en[1:]) / 100); k = next((i for i, b in enumerate(ah) if b[0] <= LASTIN and b[3] < lv), None)
        if k is None: return None
        j, pe, mkt = k, min(ah[k][1], lv), False
    buy = pe * (1 + (s_ah / 2 if mkt else 0)) * 1.001
    def out(px, kind, ah_exit=True):
        sp = s_ah if ah_exit else max(0.008, 0.01 / px)
        return px * (1 - (0 if kind == 'tp' else sp / 2)) * (1 - (0.005 if kind == 'st' else 0)) * (1 - 0.0013) / buy - 1
    if tp is not None:
        stop, tgt = pe * (1 - sl), pe * (1 + tp)
        if j >= 0 and ah[j][3] <= stop: return out(stop, 'st')
        for b in ah[j + 1:]:
            _, o, h, l, cl, v = b
            if l <= stop: return out(min(o, stop), 'st')
            if h > tgt: return out(max(o, tgt), 'tp')
    after = ah[j + 1:] if j >= 0 else ah
    if after: return out(after[-1][4], 'cl')
    if j >= 0: return out(ah[j][4], 'cl')
    nx = r.get('nxo')
    if nx and 1 / 3 < nx / c < 3: return out(nx, 'cl', ah_exit=False)
    return None
combos = [(en, *ex) for en in ENTRIES for ex in EXITS]
R = np.full((len(rows), len(combos)), np.nan)
for i, r in enumerate(rows):
    for k, (en, nm, tp, sl) in enumerate(combos):
        v = sim(r, en, tp, sl)
        if v is not None: R[i, k] = v
np.save(os.path.join(OUT, f'ah_R_{SP}.npy'), R)
d = np.array([r['d'] for r in rows]); gain = np.array([r['close'] / r['pc'] - 1 for r in rows]); px = np.array([r['close'] for r in rows])
chi = np.array([r['close'] / r['hi'] for r in rows]); m30 = np.array([r['close'] / r['p1530'] - 1 for r in rows]); full = np.array([r.get('full', False) for r in rows])
P = {'찾기': d < '2025-11-01', '확인': (d >= '2025-11-01') & (d < '2026-05-01'), '최종': d >= '2026-05-01'}
F = {'상승': {'15%↑': gain >= .15, '30%↑': gain >= .30, '50%↑': gain >= .50, '100%↑': gain >= 1.0},
     '가격': {'$1~20': px > 0, '$1~3': px < 3, '$3~20': px >= 3},
     '종가위치': {'아무나': chi > 0, '고가 근처(≥0.9)': chi >= .9, '많이 밀림(<0.75)': chi < .75},
     '마지막30분': {'아무나': m30 > -9, '오름': m30 > 0, '내림': m30 < 0}}
_days, DI = np.unique(d, return_inverse=True)
def stat(mask, k):
    v = R[:, k]; m = mask & ~np.isnan(v)
    if m.sum() < 2: return 0, np.nan, np.nan
    cnt = np.bincount(DI[m], minlength=len(_days)); sm = np.bincount(DI[m], weights=v[m], minlength=len(_days))
    dm = sm[cnt > 0] / cnt[cnt > 0]
    t = dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))) if len(dm) > 2 and dm.std(ddof=1) > 0 else np.nan
    return int(m.sum()), dm.mean(), t
def name(k, f): en, nm, _, _ = combos[k]; return f"{en}·{nm}·" + '·'.join(f)
print(f"후보 {len(rows)}건 ({len(set(d))}일), 빠짐없이 받은 날 {full.sum()}건, 스프레드 {SP*100:.2f}%")
print("— 기준: 조건 없이 (상승 15%↑, $1~20 전부)")
for k, (en, nm, _, _) in enumerate(combos):
    s = [stat(P[p], k) for p in P]; a = stat(np.ones(len(rows), bool), k)
    print(f"  {en:4}·{nm:5} {a[0]:6d}건 전체 {a[1]*100:+6.2f}% (t={a[2]:+5.1f}) | " + ' '.join(f"{p} {x[1]*100:+6.2f}%" for p, x in zip(P, s)))
cands = []
for fs in itertools.product(*[list(v.items()) for v in F.values()]):
    mask = np.logical_and.reduce([m for _, m in fs]); lab = [l for l, _ in fs]
    for k in range(len(combos)):
        n, mu, t = stat(mask & P['찾기'], k)
        if n >= 80: cands.append((mu, t, n, k, lab, mask))
cands.sort(key=lambda x: -x[0])
print(f"\n— 찾기 기간 상위 30 (조합 {len(cands)}개 중, 거래 80건↑)")
passed = []
for mu, t, n, k, lab, mask in cands[:30]:
    n2, mu2, t2 = stat(mask & P['확인'], k)
    ok = n2 >= 20 and mu2 > 0 and t2 > 2
    print(f"  {name(k, lab):60} 찾기 {mu*100:+6.2f}% (t={t:+4.1f}, {n}건) | 확인 {mu2*100:+6.2f}% (t={t2:+4.1f}, {n2}건){'  ← 통과' if ok else ''}")
    if ok: passed.append((mu2, k, lab, mask))
pos = sum(1 for mu, t, n, k, lab, mask in cands if stat(mask & P['확인'], k)[1] > 0)
print(f"\n찾기 상위 30 중 확인 통과 {len(passed)}개 / 전체 {len(cands)}개 중 확인 기간 플러스 {pos}개 ({pos/len(cands)*100:.0f}%)")
for mu2, k, lab, mask in sorted(passed, key=lambda x: -x[0])[:5]:
    n3, mu3, t3 = stat(mask & P['최종'], k); nf, muf, tf = stat(mask & full, k)
    print(f"  최종 {name(k, lab):60} {mu3*100:+6.2f}% (t={t3:+4.1f}, {n3}건) | 빠짐없는 날만(전체 기간) {muf*100:+6.2f}% ({nf}건)")
