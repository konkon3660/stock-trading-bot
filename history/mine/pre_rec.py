# 프리장 눌림 매수 규칙(pre_gap.py·gap_dip.mjs --pre와 같음)을 토스 녹화(data/recordings, 프리장 4일)로 시험 (2026-11-27)
# 녹화는 그때 순위로 고른 종목이라 과거 데이터(events.csv)의 편향이 없음: '프리장에 올랐다가 정규장에서 +15%를 못 간 종목'도 들어 있음.
# 그래서 (1) 편향 없는 결과, (2) 과거 데이터에 들어갔을 종목(정규장 고가 +15%↑)과 빠졌을 종목을 나눠서 편향 크기를 봄.
# 가격: 5초마다 녹화한 현재가. 손절·정리는 그 종목 프리장 녹화 호가의 스프레드 중앙값 절반만큼 싸게 팖(호가 없으면 스프레드 4%). 수수료 왕복 0.2%.
# 실행: py history/mine/pre_rec.py
import os, sys, json, glob, numpy as np
R = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'data', 'recordings')
MIN = 60_000; FEE = 0.002
jl = lambda f: [json.loads(l) for l in open(f, encoding='utf-8') if l.strip()]

def load(d):
    meta = json.load(open(f'{R}/{d}/_meta.json')); pre = meta.get('phases', {}).get('pre')
    if not pre: return None
    T0 = pre['s']; end = T0 + 330 * MIN
    ranks = [r for r in jl(f'{R}/{d}/_rankings.jsonl') if r.get('ph') == 'pre']
    px = {}  # 종목 → [(t, 가격)]
    for x in jl(f'{R}/{d}/_prices.jsonl'):
        if T0 <= x['t'] <= end:
            for s, p in x['p'].items():
                if p: px.setdefault(s, []).append((x['t'], p))
    spr = {}
    for b in jl(f'{R}/{d}/_books.jsonl'):
        if T0 <= b['t'] <= end and b.get('a') and b.get('b'):
            a, bb = b['a'][0]['p'], b['b'][0]['p']
            if a > 0 and bb > 0: spr.setdefault(b['s'], []).append((a - bb) / ((a + bb) / 2))
    return dict(d=d, T0=T0, open=meta['open'], close=meta['close'], ranks=ranks, px=px, spr={s: float(np.median(v)) for s, v in spr.items()})

def signals(D):
    sig, seen = [], set()
    for m in range(15, 271, 5):
        t = D['T0'] + m * MIN; r = [x for x in D['ranks'] if t - 2 * MIN <= x['t'] <= t]
        if not r: continue
        for s, p, ch, _ in r[-1]['gainers']:
            if s in seen or not (ch >= 0.15 and 1 <= p < 20): continue
            seen.add(s); sig.append(dict(s=s, t=t, ref=p, pc=p / (1 + ch)))
    return sig

def regular_high(d, s, o, c):
    f = f'{R}/{d}/{s}.json'
    if not os.path.exists(f): return np.nan
    hs = [b['h'] for b in json.load(open(f)) if o < b['t'] <= c + MIN]
    return max(hs) if hs else np.nan

def trade(D, g, dip, tp, sl):
    lvl = g['ref'] * (1 - dip); tgt, stp = lvl * (1 + tp), lvl * (1 - sl); hs = D['spr'].get(g['s'], 0.04) / 2
    seq = [(t, p) for t, p in D['px'].get(g['s'], []) if t > g['t']]
    if not seq: return None  # 녹화 안 된 종목
    fill = next((t for t, p in seq if p < lvl and t < D['T0'] + 300 * MIN), None)
    if fill is None: return np.nan  # 안 닿음
    last = lvl
    for t, p in seq:
        if t <= fill: continue
        if t >= D['T0'] + 325 * MIN: break
        if p <= stp: return p * (1 - hs) / lvl - 1 - FEE
        if p > tgt: return tp - FEE
        last = p
    return last * (1 - hs) / lvl - 1 - FEE

def main():
    days = [x for x in (load(os.path.basename(p)) for p in sorted(glob.glob(R + '/2026-*'))) if x]
    rows = []
    for D in days:
        for g in signals(D):
            g['d'] = D['d']; g['in_hist'] = regular_high(D['d'], g['s'], D['open'], D['close']) / g['pc'] - 1 >= 0.15; g['D'] = D; rows.append(g)
    print(f"프리장 녹화 {len(days)}일 ({', '.join(D['d'] for D in days)}), 신호 {len(rows)}개 — 과거 데이터에 들어갔을 종목(정규장 고가 +15%↑) {sum(g['in_hist'] for g in rows)}개")
    med = np.median([v for D in days for v in D['spr'].values()]); print(f'프리장 스프레드 중앙값(신호 종목 녹화 호가): {med*100:.1f}%')
    def show(dip, tp, sl):
        r = [(trade(g['D'], g, dip, tp, sl), g['in_hist']) for g in rows]; r = [(x, h) for x, h in r if x is not None]
        filled = [(x, h) for x, h in r if not np.isnan(x)]
        out = [f'지정가 -{dip*100:.0f}% · 목표 +{tp*100:.0f}% · 손절 -{sl*100:.0f}%: 녹화된 신호 {len(r)}개 중 체결 {len(filled)}개']
        for name, sel in (('전체(편향 없음)', lambda h: True), ('과거 데이터에 있었을 종목', lambda h: h), ('과거 데이터에서 빠졌을 종목', lambda h: not h)):
            x = np.array([v for v, h in filled if sel(h)])
            out.append(f'   {name}: {len(x)}건, 거래당 {x.mean()*100:+.2f}%, 이긴 비율 {np.mean(x > 0)*100:.0f}%' if len(x) else f'   {name}: 없음')
        print('\n'.join(out))
    show(0.05, 0.10, 0.20)          # 연습 봇 규칙
    show(0.12, 0.25, 0.30)          # 과거 데이터(--all)에서 앞 기간 1등
    show(0.08, 0.15, 0.30)

if __name__ == '__main__': main()
