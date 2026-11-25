# 당일매매 규칙 탐색용 표: 'Stocks in Play' 분봉(정규장) → 사건별 특징값 + 진입·청산 방식별 결과
# 후보: sip_events.csv 중 시가 갭 ±2% 이상만 (거래량 조건은 하루 전체 거래량을 써서 미래 정보라 제외), ETF·ETN 제외
import os, sys, glob, csv, json, numpy as np, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT as W, PACK as U, DATA
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)

# ---------- 사건 정보 ----------
ev = {}
for r in csv.DictReader(open(DATA + '/sip_events.csv', encoding='utf-8')):
    ev[(r['날짜'], safe(r['종목']))] = (r['종목'], float(r['전일종가']), float(r['시가']), float(r['평균거래량14']), float(r['ATR14']))
types = json.load(open(DATA + '/stock_types.json'))
def risky(T):
    t = types.get(T)
    if isinstance(t, dict): return t.get('type') in ('ETF', 'ETN')
    return t in ('ETF', 'ETN')

# ---------- 일봉 (전 종목) ----------
Z = np.load(W + '/panel.npz'); days = list(Z['days']); tick = list(Z['tick']); dpos = {d: i for i, d in enumerate(days)}; tpos = {t: i for i, t in enumerate(tick)}
PC, PH, PL, PO, PV = Z['c'].astype(np.float64), Z['h'].astype(np.float64), Z['l'].astype(np.float64), Z['o'].astype(np.float64), Z['v'].astype(np.float64)
def mkt(sym):
    j = tpos[sym]; return PO[:, j], PC[:, j]
def daily_feats(d, T):
    i = dpos.get(d); j = tpos.get(T)
    out = dict(ret1=np.nan, ret5=np.nan, ret20=np.nan, sma20=np.nan, hi20=np.nan, pclose_loc=np.nan, prng_atr=np.nan, pvol=np.nan)
    if i is None or j is None or i < 22: return out
    c = PC[:i, j]; h = PH[:i, j]; l = PL[:i, j]; v = PV[:i, j]
    out['ret1'] = c[-1] / c[-2] - 1; out['ret5'] = c[-1] / c[-6] - 1; out['ret20'] = c[-1] / c[-21] - 1
    out['sma20'] = c[-1] / np.nanmean(c[-20:]) - 1; out['hi20'] = c[-1] / np.nanmax(h[-20:]) - 1
    rg = h[-1] - l[-1]; out['pclose_loc'] = (c[-1] - l[-1]) / rg if rg > 0 else 0.5
    tr = np.nanmean(np.maximum(h[-14:], c[-15:-1]) - np.minimum(l[-14:], c[-15:-1]))
    out['prng_atr'] = rg / tr if tr > 0 else np.nan
    out['pvol'] = v[-1] / np.nanmean(v[-15:-1])
    return out
SPY_O, SPY_C = mkt('SCHB')  # SPY는 일봉 파일에 없음(저가 $30 이하만 저장) → 전체 시장 ETF SCHB로 대신
def mkt_feats(d):
    i = dpos.get(d)
    if i is None or i < 22: return dict(spy_gap=np.nan, spy_ret1=np.nan, spy_ret5=np.nan, spy_sma20=np.nan)
    return dict(spy_gap=SPY_O[i] / SPY_C[i - 1] - 1, spy_ret1=SPY_C[i - 1] / SPY_C[i - 2] - 1, spy_ret5=SPY_C[i - 1] / SPY_C[i - 6] - 1,
                spy_sma20=SPY_C[i - 1] / np.nanmean(SPY_C[i - 20:i]) - 1)

# ---------- 진입 방식 ----------
# 각 진입: (이름, 종류) 종류 brk=돌파(미끄러짐), mkt=시장가, lmt=지정가
ENTRIES = [('orb5', 'brk'), ('orb15', 'brk'), ('orb30', 'brk'), ('orb60', 'brk'),
           ('at5', 'mkt'), ('at15', 'mkt'), ('at30', 'mkt'), ('at60', 'mkt'),
           ('vwapx', 'mkt'), ('dip25', 'lmt'), ('dip50', 'lmt'), ('dip100', 'lmt'), ('at360', 'mkt')]
EXITS = ['close', 'st10', 'st25', 'st50', 'st100', 'tp50s25', 'tp100s50', 'tp100s100', 'tp200s100', 't30', 't60', 't120', 'stlow', 'tr50', 'tr100']
LAST = 388  # 15:58 봉 종가에 청산 (마감 2분 전)

def ffill_close(C):
    C = C.copy(); n, m = C.shape
    idx = np.where(np.isnan(C), 0, np.arange(m)[None, :]); np.maximum.accumulate(idx, axis=1, out=idx)
    out = C[np.arange(n)[:, None], idx]
    return out

def entries(O, H, L, C, V, VW, o, atr):
    n = O.shape[0]; ar = np.arange(390)[None, :]; R = {}
    Hn = np.where(np.isnan(H), -np.inf, H); Ln = np.where(np.isnan(L), np.inf, L)
    for name, kind in ENTRIES:
        je = np.full(n, -1); pe = np.full(n, np.nan)
        if name.startswith('orb'):
            k = int(name[3:]); lvl = Hn[:, :k].max(1)
            hit = (ar >= k) & (ar <= 300) & (Hn > lvl[:, None]); ok = hit.any(1); j = hit.argmax(1)
            je[ok] = j[ok]; pe[ok] = np.maximum(O[ok, j[ok]], lvl[ok])
        elif name.startswith('at'):
            k = int(name[2:]); oo = O[:, k]; ok = ~np.isnan(oo); je[ok] = k; pe[ok] = oo[ok]
        elif name == 'vwapx':
            # 누적 VWAP(분봉 vwap×거래량) 아래에 있다가 위로 마감한 첫 봉(15분 이후~14:30) → 다음 봉 시가 매수
            pv = np.nancumsum(np.nan_to_num(VW) * np.nan_to_num(V), 1); cv = np.nancumsum(np.nan_to_num(V), 1)
            vw = pv / np.maximum(cv, 1); above = C > vw; below_prev = np.zeros_like(above); below_prev[:, 1:] = (C[:, :-1] <= vw[:, :-1])
            hit = (ar >= 15) & (ar <= 300) & above & below_prev & ~np.isnan(np.roll(O, -1, 1))
            ok = hit.any(1); j = hit.argmax(1) + 1; je[ok] = j[ok]; pe[ok] = O[ok, j[ok]]
        elif name.startswith('dip'):
            x = int(name[3:]) / 100; lvl = o - x * atr
            hit = (ar >= 5) & (ar <= 300) & (Ln < lvl[:, None]); ok = hit.any(1); j = hit.argmax(1)
            je[ok] = j[ok]; pe[ok] = np.minimum(O[ok, j[ok]], lvl[ok])
        R[name] = (je, pe, kind)
    return R

def exits(je, pe, kind, O, H, L, Cf, atr, dlow):
    # 돌려줌: {청산이름: (청산가, 청산종류)}  청산종류 0=시장가 1=손절 2=목표가(지정가)
    n = O.shape[0]; ar = np.arange(390)[None, :]; ok = je >= 0; R = {}
    jj = np.where(ok, je, 0); rows = np.arange(n)
    px_close = Cf[:, LAST]
    after = ar > jj[:, None]; upto = ar <= LAST
    same_inc = kind == 'mkt'  # 시가 매수면 진입봉 저가도 진입 뒤에 나온 것
    Hn = np.where(np.isnan(H), -np.inf, H); Ln = np.where(np.isnan(L), np.inf, L); On = O
    def first(mask):
        a = mask.any(1); j = np.where(a, mask.argmax(1), 10**6); return j
    def stop_idx(s):
        m = (after & upto & (Ln <= s[:, None]))
        if same_inc: m |= (ar == jj[:, None]) & (Ln <= s[:, None])
        j = first(m)
        if not same_inc:  # 돌파·지정가 진입봉: 종가가 손절선 아래면 진입봉에서 손절
            e0 = Cf[rows, jj] <= s; j = np.where(e0, jj, j)
        return j
    def stop_px(j, s):
        jc = np.minimum(j, 389); op = On[rows, jc]
        return np.where(j == jj, s, np.where(np.isnan(op), s, np.minimum(op, s)))
    def tgt_idx(t):
        return first(after & upto & (Hn > t[:, None]))
    def tgt_px(j, t):
        jc = np.minimum(j, 389); op = On[rows, jc]; return np.where(np.isnan(op), t, np.maximum(op, t))
    def combine(js, jt, s, t, jtime=None):
        # 같은 봉이면 손절 먼저 (보수적)
        jend = np.full(n, LAST) if jtime is None else np.minimum(jtime, LAST)
        px = Cf[rows, jend]; k = np.zeros(n, np.int8)
        if t is not None:
            mt = (jt < js) & (jt <= jend); px = np.where(mt, tgt_px(jt, t), px); k = np.where(mt, 2, k)
            ms = (js <= jt) & (js <= jend)
        else:
            ms = js <= jend
        px = np.where(ms, stop_px(js, s), px); k = np.where(ms, 1, k)
        return px, k
    big = np.full(n, 10**6)
    R['close'] = (px_close, np.zeros(n, np.int8))
    for nm, a in [('st10', .10), ('st25', .25), ('st50', .5), ('st100', 1.0)]:
        s = pe - a * atr; R[nm] = combine(stop_idx(s), big, s, None)
    for nm, (m, a) in [('tp50s25', (.5, .25)), ('tp100s50', (1, .5)), ('tp100s100', (1, 1)), ('tp200s100', (2, 1))]:
        s = pe - a * atr; t = pe + m * atr; R[nm] = combine(stop_idx(s), tgt_idx(t), s, t)
    for nm, h in [('t30', 30), ('t60', 60), ('t120', 120)]:
        R[nm] = combine(big, big, pe, None, jtime=jj + h)
    s = np.minimum(dlow, pe * 0.9999); R['stlow'] = combine(stop_idx(s), big, s, None)
    for nm, a in [('tr50', .5), ('tr100', 1.0)]:
        hh = np.where(ar >= jj[:, None], Hn, -np.inf); hh = np.maximum(hh, np.where(ar == jj[:, None], pe[:, None], -np.inf))
        cm = np.maximum.accumulate(hh, 1); trail = np.empty_like(cm); trail[:, 1:] = cm[:, :-1] - a * atr[:, None]; trail[:, 0] = -np.inf
        m = after & upto & (Ln <= trail); j = first(m); jc = np.minimum(j, 389)
        lv = trail[rows, jc]; op = On[rows, jc]; spx = np.where(np.isnan(op), lv, np.minimum(op, lv))
        ms = j <= LAST; R[nm] = (np.where(ms, spx, px_close), np.where(ms, 1, 0).astype(np.int8))
    return R

def main():
    out = []; feats_rows = []
    for f in sorted(glob.glob(U + '/sip_*.npz')):
        z = np.load(f); D_, T_, B = z['d'], z['T'], z['bars'].astype(np.float64)
        keep = []; meta = []
        for i, (d, ts) in enumerate(zip(D_, T_)):
            e = ev.get((d, ts))
            if not e: continue
            T, pc, o, adv, atr = e
            if abs(o / pc - 1) < 0.02 or risky(T) or np.isnan(B[i, 0, 0]): continue
            keep.append(i); meta.append((d, T, pc, o, adv, atr))
        if not keep: continue
        B = B[keep]; O, H, L, C, V, VW = [B[:, :, k] for k in range(6)]
        Cf = ffill_close(C); n = len(keep)
        pc = np.array([m[2] for m in meta]); o = O[:, 0]; adv = np.array([m[4] for m in meta]); atr = np.array([m[5] for m in meta])
        v5 = np.nansum(V[:, :5], 1); h5 = np.nanmax(H[:, :5], 1); l5 = np.nanmin(L[:, :5], 1); c5 = Cf[:, 4]
        v30 = np.nansum(V[:, :30], 1); c30 = Cf[:, 29]; h30 = np.nanmax(H[:, :30], 1); l30 = np.nanmin(L[:, :30], 1)
        F = dict(gap=o / pc - 1, px=o, atrp=atr / pc, advusd=adv * pc, rv5=v5 / adv, or5=(h5 - l5) / atr, r5=c5 / o - 1,
                 loc5=np.where(h5 > l5, (c5 - l5) / np.maximum(h5 - l5, 1e-9), .5), rv30=v30 / adv, r30=c30 / o - 1,
                 or30=(h30 - l30) / atr, gap_atr=(o - pc) / atr)
        dd = np.array([m[0] for m in meta])
        F['dow'] = np.array([dt.date.fromisoformat(x).weekday() for x in dd], float)
        # 같은 날 후보 안에서 rv5 순위, 9:35 평균 수익률(시장 분위기), 갭업 비율
        F['rank_rv5'] = np.zeros(n); F['xs_r5'] = np.zeros(n); F['xs_up'] = np.zeros(n); F['n_day'] = np.zeros(n)
        for d in np.unique(dd):
            m = dd == d; r = F['rv5'][m]; F['rank_rv5'][m] = (-r).argsort().argsort() + 1
            F['xs_r5'][m] = np.nanmean(F['r5'][m]); F['xs_up'][m] = np.mean(F['gap'][m] > 0); F['n_day'][m] = m.sum()
        dfe = [daily_feats(m[0], m[1]) for m in meta]
        for k in dfe[0]: F[k] = np.array([x[k] for x in dfe])
        mfe = {d: mkt_feats(d) for d in np.unique(dd)}
        for k in next(iter(mfe.values())): F[k] = np.array([mfe[d][k] for d in dd])
        EN = entries(O, H, L, C, V, VW, o, atr)
        res = {}
        pv = np.nancumsum(np.nan_to_num(VW) * np.nan_to_num(V), 1); cv = np.nancumsum(np.nan_to_num(V), 1); vwc = pv / np.maximum(cv, 1)
        Lc = np.minimum.accumulate(np.where(np.isnan(L), np.inf, L), 1)
        for name, (je, pe, kind) in EN.items():
            okk = je >= 0; jj = np.where(okk, je, 0); rows = np.arange(n)
            jprev = np.maximum(jj - 1, 0)
            dlow = np.where(jj > 0, Lc[rows, jprev], pe * 0.99)
            X = exits(je, pe, kind, O, H, L, Cf, atr, dlow)
            res[name] = dict(je=je, pe=pe, ret_open=pe / o - 1, vwd=pe / vwc[rows, jprev] - 1, cvol=cv[rows, jprev] / adv,
                             **{f'x_{k}': v[0] for k, v in X.items()}, **{f'k_{k}': v[1] for k, v in X.items()})
        out.append(dict(d=dd, T=np.array([m[1] for m in meta]), F=F, res=res))
        print(os.path.basename(f), n, flush=True)
    # 합치기
    d = np.concatenate([x['d'] for x in out]); T = np.concatenate([x['T'] for x in out])
    Fk = out[0]['F'].keys(); F = {k: np.concatenate([x['F'][k] for x in out]) for k in Fk}
    S = {}
    for name, _ in ENTRIES:
        for k in out[0]['res'][name]: S[f'{name}__{k}'] = np.concatenate([x['res'][name][k] for x in out])
    np.savez_compressed(W + '/intra.npz', d=d, T=T, **{'F_' + k: v for k, v in F.items()}, **S)
    print('저장', len(d))

if __name__ == '__main__':
    main()
