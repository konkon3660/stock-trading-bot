# 프리장 눌림 매수 (orb/gap_dip.mjs --pre와 같은 규칙) 과거 데이터 시험 — ⚠ 낙관적 상한 (2026-11-27)
# 데이터(events.csv)는 '정규장 장중 고가가 전일 종가 +15%↑'인 날만 있음 → 프리장에 올랐다가 꺼지고 정규장에서도 +15%를 못 간 종목
#   (= 프리장 눌림 매수가 크게 잃는 종목)이 빠져 있음. 그래서 여기 숫자는 실제보다 좋게 나옴.
#   이게 마이너스면 프리장 규칙은 접어도 되고, 플러스면 편향 없는 기록(토스 녹화·연습 봇 rec/)으로 다시 확인해야 함.
# 규칙: 4:15~8:30 ET 5분마다 그때까지의 마지막 거래가가 전일 종가 +15%↑·$1~20이 '처음'이면 그 가격 -dip에 지정가
#   → 9:00 전에 그보다 낮은 거래(분봉 저가 < 지정가)가 있으면 체결 → 다음 분봉부터 목표(고가 > 목표면 목표가) / 손절(저가 <= 손절, 시가가 더 낮으면 시가)
#   / 9:25 종가 정리. 같은 분봉에 목표·손절 둘 다면 손절로 봄. 손절·정리는 매수호가에 팖 = 가격 × (1 - 스프레드/2). 수수료 왕복 0.2%.
# 실행: py history/mine/pre_gap.py [--all]      (numpy 필요, 1~3분)
import os, sys, csv, json, collections, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE)); import et
D = os.path.join(os.path.dirname(HERE), 'data'); MIN = 60_000; NB = 330  # 4:00~9:30 = 330분
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)
SPLIT = '2026-02-01'; FEE = 0.002

def load(a):
    d, T, pc = a; f = os.path.join(D, 'minute', d, safe(T) + '.json')
    if not os.path.exists(f): return None
    t0 = et.session(d)[0] - NB * MIN; b = np.full((NB, 4), np.nan)
    for r in json.load(open(f)):
        i = (r[0] - t0) // MIN
        if 0 <= i < NB: b[i] = r[1:5]  # 시고저종 (Massive 분봉 시각 = 봉 시작)
    return b

def main():
    ev = [(r['날짜'], r['종목'], float(r['전일종가'])) for r in csv.DictReader(open(os.path.join(D, 'events.csv'), encoding='utf-8-sig')) if float(r['전일종가']) > 0]
    types = json.load(open(os.path.join(D, 'stock_types.json')))
    risky = lambda T: (types.get(T) if isinstance(types.get(T), str) else (types.get(T) or {}).get('type')) in ('ETF', 'ETN')
    from multiprocessing import Pool
    with Pool(8) as p: B = p.map(load, ev, chunksize=50)
    byday = collections.defaultdict(list)
    for e, b in zip(ev, B): byday[e[0]].append(b is not None)
    complete = {d for d, xs in byday.items() if all(xs)}  # 그날 급등 종목 분봉을 다 받은 날만 (받은 순서 편향 제거, build_gap.py와 같음)
    ALL = '--all' in sys.argv  # 분봉 받은 날 전부 (덜 받은 날은 그날 덜 오른 종목이 빠져서 더 부풀려짐 — 상한의 상한)
    keep = [i for i, (e, b) in enumerate(zip(ev, B)) if b is not None and (ALL or e[0] in complete) and not risky(e[1])]
    print(f'급등일 {len(ev)}건 중 분봉 다 받은 날 {len(complete)}/{len(byday)}일 — 이번에 쓰는 것: {"분봉 받은 날 전부" if ALL else "다 받은 날만"}, 종목 {len(keep)}건 (ETF·ETN 제외)')
    d = np.array([ev[i][0] for i in keep]); pc = np.array([ev[i][2] for i in keep]); X = np.stack([B[i] for i in keep])
    O, H, L, C = (X[:, :, k] for k in range(4)); n = len(keep)
    Cf = C.copy()
    for j in range(1, NB): Cf[:, j] = np.where(np.isnan(Cf[:, j]), Cf[:, j - 1], Cf[:, j])
    # 신호: 5분마다(15, 20, ..., 270분) 그때까지 마지막 거래가(분봉 m-1의 채운 종가)
    sig = np.full(n, -1); ref = np.full(n, np.nan)
    for m in range(15, 271, 5):
        p = Cf[:, m - 1]; ok = (sig < 0) & (p / pc - 1 >= 0.15) & (p >= 1) & (p < 20)
        sig[ok] = m; ref[ok] = p[ok]
    has = sig >= 0; print(f'프리장 신호 {has.sum()}건 ({has.sum() / n * 100:.0f}%), 날짜 {len(set(d[has]))}일')
    idx = np.arange(NB)
    Hn = np.where(np.isnan(H), -np.inf, H); Ln = np.where(np.isnan(L), np.inf, L)

    def run(dip, tp, sl, hs):
        lvl = ref * (1 - dip)
        fillm = (idx[None, :] >= sig[:, None]) & (idx[None, :] < 300) & (Ln < lvl[:, None]) & has[:, None]
        f = np.where(fillm.any(1), fillm.argmax(1), -1); got = f >= 0
        tgt, stp = lvl * (1 + tp), lvl * (1 - sl)
        after = (idx[None, :] > f[:, None]) & (idx[None, :] < 325)
        hitS = after & (Ln <= stp[:, None]); hitT = after & (Hn > tgt[:, None])
        jS = np.where(hitS.any(1), hitS.argmax(1), 999); jT = np.where(hitT.any(1), hitT.argmax(1), 999)
        r = np.full(n, np.nan)
        stopped = got & (jS < 999) & (jS <= jT); won = got & (jT < jS)
        rows = np.arange(n); oS = O[rows, np.minimum(jS, NB - 1)]
        sp = np.where(np.isnan(oS), stp, np.minimum(stp, oS))
        r[stopped] = (sp[stopped] * (1 - hs)) / lvl[stopped] - 1
        r[won] = tp
        rest = got & ~stopped & ~won; r[rest] = Cf[rest, 324] * (1 - hs) / lvl[rest] - 1
        return r - FEE, got, stopped, won

    def show(name, r, got, mask=None):
        m = got if mask is None else got & mask; x = r[m]
        if not len(x): return f'{name}: 없음'
        cut = np.sort(x)[:max(1, int(len(x) * 0.98))]
        se = x.std() / np.sqrt(len(x))
        return f'{name}: 체결 {len(x)}건, 거래당 {x.mean()*100:+.2f}% (t={x.mean()/se:.1f}), 이긴 비율 {np.mean(x > 0)*100:.0f}%, 상위 2% 빼면 {cut.mean()*100:+.2f}%'

    early, late = d < SPLIT, d >= SPLIT
    print('\n== 연습 봇과 같은 규칙: 지정가 -5%, 목표 +10%, 손절 -20%, 9:25 정리 ==')
    for hs in (0.01, 0.02, 0.04):
        r, got, st, wn = run(0.05, 0.10, 0.20, hs)
        print(f'[스프레드 {hs*200:.0f}% 가정] 체결률 {got.sum()/has.sum()*100:.0f}%, 목표 {wn.sum()} / 손절 {st.sum()} / 9:25 정리 {(got & ~st & ~wn).sum()}')
        print('   ' + show('전체', r, got)); print('   ' + show(f'앞({SPLIT} 전)', r, got, early)); print('   ' + show('뒤', r, got, late))
    print(f'\n== 평균 수익률 큰 설정 찾기 (스프레드 4% 가정, 앞 기간에서 고르고 뒤 기간에서 확인) ==')
    res = []
    for dip in (0.03, 0.05, 0.08, 0.12):
        for tp in (0.05, 0.10, 0.15, 0.25):
            for sl in (0.10, 0.20, 0.30):
                r, got, _, _ = run(dip, tp, sl, 0.02)
                a, b = r[got & early], r[got & late]
                if len(a) >= 30: res.append((a.mean(), dip, tp, sl, len(a), b.mean() if len(b) else np.nan, len(b)))
    if not res: return print('  앞 기간 체결이 30건 안 돼서 못 고름')
    res.sort(reverse=True)
    for a, dip, tp, sl, na, b, nb in res[:8]:
        print(f'  지정가 -{dip*100:.0f}% · 목표 +{tp*100:.0f}% · 손절 -{sl*100:.0f}%: 앞 {a*100:+.2f}% ({na}건) → 뒤 {b*100:+.2f}% ({nb}건)')
    print(f'  (시험한 조합 {len(res)}개. 가장 나쁜 것: 앞 {res[-1][0]*100:+.2f}%)')

if __name__ == '__main__': main()
