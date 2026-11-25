# 갭상승 급등주(시가 +15%↑, 시가 $1~10) 규칙 탐색용 표 — 프리장 정보 포함
# 후보: events.csv 중 시가 갭 +15% 이상·시가 $1~10, 그날 이 조건 종목 분봉을 '빠짐없이' 받은 날만 (받은 순서 때문에 생기는 편향 제거), ETF·ETN 제외
# 분봉 0번 = 4:00 ET, 330번 = 9:30, 720번 = 16:00
import os, sys, glob, csv, json, collections, datetime as dt, numpy as np, warnings; warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT, DATA, PACK
OPEN, LAST = 330, 718
ev = {}; byday = collections.defaultdict(list)
for r in csv.DictReader(open(DATA + '/events.csv', encoding='utf-8-sig')):
    pc, o = float(r['전일종가']), float(r['시가'])
    if pc <= 0 or o / pc - 1 < 0.15 or not (1 <= o < 10): continue
    ev[(r['날짜'], r['종목'])] = dict(pc=pc, o=o, h=float(r['고가']), l=float(r['저가']), c=float(r['종가'])); byday[r['날짜']].append(r['종목'])
types = json.load(open(DATA + '/stock_types.json'))
risky = lambda T: (types.get(T) if isinstance(types.get(T), str) else (types.get(T) or {}).get('type')) in ('ETF', 'ETN')
# 분봉
D_, T_, B_ = [], [], []
for f in sorted(glob.glob(PACK + '/gap15_*.npz')):
    z = np.load(f); D_ += list(z['d']); T_ += list(z['T']); B_.append(z['bars'])
B = np.concatenate(B_).astype(np.float64); have = {(d, t): i for i, (d, t) in enumerate(zip(D_, T_))}
complete = {d for d, ts in byday.items() if all((d, t) in have for t in ts)}
# 편향 점검: 다 받은 날 vs 전체(안 받은 것 포함, 일봉으로) 종가/시가
allr = np.mean([v['c'] / v['o'] - 1 for v in ev.values()]); comr = np.mean([v['c'] / v['o'] - 1 for (d, t), v in ev.items() if d in complete])
print(f'후보 {len(ev)}건, 다 받은 날 {len(complete)}/{len(byday)}일 — 종가/시가 평균: 전체 {allr*100:+.2f}%, 다 받은 날 {comr*100:+.2f}%')
keys = sorted(k for k in ev if k[0] in complete and not risky(k[1]))
idx = np.array([have[k] for k in keys]); B = B[idx]; n = len(keys)
O, H, L, C, V, VW = [B[:, :, k] for k in range(6)]
d = np.array([k[0] for k in keys]); T = np.array([k[1] for k in keys])
pc = np.array([ev[k]['pc'] for k in keys]); o_off = np.array([ev[k]['o'] for k in keys]); c_off = np.array([ev[k]['c'] for k in keys])
o = np.where(np.isnan(O[:, OPEN]), o_off, O[:, OPEN])
Cf = C.copy()
for j in range(1, 960): Cf[:, j] = np.where(np.isnan(Cf[:, j]), Cf[:, j - 1], Cf[:, j])
Hn = np.where(np.isnan(H), -np.inf, H); Ln = np.where(np.isnan(L), np.inf, L)
# 일봉 (전날까지)
Z = np.load(OUT + '/panel.npz'); days = list(Z['days']); tick = list(Z['tick']); dpos = {x: i for i, x in enumerate(days)}; tpos = {x: i for i, x in enumerate(tick)}
PC_, PH_, PO_, PV_ = [Z[k].astype(np.float64) for k in 'chov']
F = {k: np.full(n, np.nan) for k in ('ret1', 'ret5', 'ret20', 'hi20', 'adv20', 'pvol', 'mkt_gap')}; nxt_o = np.full(n, np.nan); nxt_c = np.full(n, np.nan)
js = tpos['SCHB']
for a in range(n):
    i = dpos.get(d[a]); j = tpos.get(T[a])
    if i is None: continue
    if i >= 1: F['mkt_gap'][a] = PO_[i, js] / PC_[i - 1, js] - 1
    if j is None or i < 22: continue
    c_ = PC_[:i, j]; F['ret1'][a] = c_[-1] / c_[-2] - 1; F['ret5'][a] = c_[-1] / c_[-6] - 1; F['ret20'][a] = c_[-1] / c_[-21] - 1
    F['hi20'][a] = c_[-1] / np.nanmax(PH_[i - 20:i, j]) - 1; dv = (PC_[i - 20:i, j] * PV_[i - 20:i, j]); F['adv20'][a] = np.nanmean(dv)
    F['pvol'][a] = PV_[i - 1, j] / np.nanmean(PV_[i - 21:i - 1, j])
    # 일봉은 분할 보정값이라 그대로 쓰면 안 됨 → 당일 종가 대비 비율 × 실제 당일 종가
    if i + 1 < len(days) and PC_[i, j] > 0: nxt_o[a] = c_off[a] * PO_[i + 1, j] / PC_[i, j]; nxt_c[a] = c_off[a] * PC_[i + 1, j] / PC_[i, j]
# 프리장 특징 (9:30 전에 다 알 수 있음)
pm = slice(0, OPEN); dvm = np.nan_to_num(VW[:, pm]) * np.nan_to_num(V[:, pm])
F['pm_dv'] = dvm.sum(1); F['pm_rv'] = F['pm_dv'] / F['adv20']
pmh = np.nanmax(H[:, pm], 1); pml = np.nanmin(L[:, pm], 1)
F['o_pmh'] = o / pmh - 1; F['pm_pos'] = np.where(pmh > pml, (o - pml) / np.maximum(pmh - pml, 1e-9), np.nan); F['pm_rng'] = pmh / pml - 1
F['pm_mom30'] = Cf[:, OPEN - 1] / Cf[:, OPEN - 31] - 1; F['pm_gap8'] = Cf[:, 240] / pc - 1
cum = np.cumsum(dvm, 1); F['pm_start'] = np.where(cum[:, -1] >= 5e4, (cum >= 5e4).argmax(1), np.nan)
F['pm_active'] = (~np.isnan(V[:, pm])).sum(1).astype(float)
F['gap'] = o_off / pc - 1; F['px'] = o_off; F['dow'] = np.array([dt.date.fromisoformat(x).weekday() for x in d], float)
cnt = collections.Counter(k[0] for k in ev); F['n_day'] = np.array([cnt[x] for x in d], float)
# 개장 뒤 특징 (진입 시각에 맞춰 나중에 가림)
F['r1'] = Cf[:, OPEN] / o - 1; F['r5'] = Cf[:, OPEN + 4] / o - 1; F['r15'] = Cf[:, OPEN + 14] / o - 1; F['r30'] = Cf[:, OPEN + 29] / o - 1
h5 = np.nanmax(H[:, OPEN:OPEN + 5], 1); l5 = np.nanmin(L[:, OPEN:OPEN + 5], 1)
F['loc5'] = np.where(h5 > l5, (Cf[:, OPEN + 4] - l5) / np.maximum(h5 - l5, 1e-9), .5)
F['v5_pm'] = np.nansum(V[:, OPEN:OPEN + 5], 1) / np.maximum(np.nansum(V[:, pm], 1), 1)
GATE = {'r1': 1, 'r5': 5, 'loc5': 5, 'v5_pm': 5, 'r15': 15, 'r30': 30}
ar = np.arange(960)[None, :]
pv = np.nancumsum(np.nan_to_num(VW) * np.nan_to_num(V) * (ar >= OPEN), 1); cv = np.nancumsum(np.nan_to_num(V) * (ar >= OPEN), 1); vwc = pv / np.maximum(cv, 1)
# ---------- 진입 ----------
EN = {}
def put(name, kind, je, pe): EN[name] = (je, pe, kind)
for k in (0, 1, 5, 15, 30, 60, 360):
    oo = O[:, OPEN + k]; ok = ~np.isnan(oo); je = np.where(ok, OPEN + k, -1); put(f'at{k}', 'mkt', je, np.where(ok, oo, np.nan))
for k in (1, 5, 15, 30):
    lvl = np.nanmax(H[:, OPEN:OPEN + k], 1); hit = (ar >= OPEN + k) & (ar <= OPEN + 300) & (Hn > lvl[:, None]); ok = hit.any(1); j = hit.argmax(1)
    put(f'orb{k}', 'brk', np.where(ok, j, -1), np.where(ok, np.maximum(O[np.arange(n), j], lvl), np.nan))
hit = (ar >= OPEN) & (ar <= OPEN + 300) & (Hn > pmh[:, None]); ok = hit.any(1); j = hit.argmax(1)
put('pmh', 'brk', np.where(ok, j, -1), np.where(ok, np.maximum(O[np.arange(n), j], pmh), np.nan))
above = C > vwc; bp = np.zeros_like(above); bp[:, 1:] = C[:, :-1] <= vwc[:, :-1]
hit = (ar >= OPEN + 15) & (ar <= OPEN + 300) & above & bp & ~np.isnan(np.roll(O, -1, 1)); ok = hit.any(1); j = hit.argmax(1) + 1
put('vwapx', 'mkt', np.where(ok, j, -1), np.where(ok, O[np.arange(n), np.minimum(j, 959)], np.nan))
for nm, lvl in (('dip5', o * 0.95), ('dip10', o * 0.90), ('dip15', o * 0.85), ('gf50', pc + 0.5 * (o - pc))):
    hit = (ar >= OPEN) & (ar <= OPEN + 300) & (Ln < lvl[:, None]); ok = hit.any(1); j = hit.argmax(1)
    put(nm, 'lmt', np.where(ok, j, -1), np.where(ok, np.minimum(O[np.arange(n), j], lvl), np.nan))
# ---------- 청산 ----------
rows = np.arange(n)
def exits(je, pe, kind):
    jj = np.where(je >= 0, je, OPEN); after = ar > jj[:, None]; upto = ar <= LAST; R = {}; big = np.full(n, 10**6)
    def first(m): a = m.any(1); return np.where(a, m.argmax(1), 10**6)
    def stop_idx(s):
        m = after & upto & (Ln <= s[:, None])
        if kind == 'mkt': m |= (ar == jj[:, None]) & (Ln <= s[:, None])
        j = first(m)
        if kind != 'mkt': j = np.where(Cf[rows, jj] <= s, jj, j)
        return j
    def px_at(j, lvl, f):
        jc = np.minimum(j, 959); op = O[rows, jc]; return np.where(j == jj, lvl, np.where(np.isnan(op), lvl, f(op, lvl)))
    def comb(js_, jt_, s, t, jend=None):
        jend = np.full(n, LAST) if jend is None else np.minimum(jend, LAST); px = Cf[rows, jend]; k = np.zeros(n, np.int8)
        if t is not None:
            mt = (jt_ < js_) & (jt_ <= jend); px = np.where(mt, px_at(jt_, t, np.maximum), px); k = np.where(mt, 2, k)
        ms = (js_ <= jend) & ((js_ <= jt_) if t is not None else True); px = np.where(ms, px_at(js_, s, np.minimum), px); k = np.where(ms, 1, k)
        return px, k
    R['close'] = (Cf[:, LAST], np.zeros(n, np.int8))
    for nm, a in (('st3', .03), ('st5', .05), ('st10', .10)): s = pe * (1 - a); R[nm] = comb(stop_idx(s), big, s, None)
    for nm, (m, a) in (('tp5s3', (.05, .03)), ('tp10s5', (.10, .05)), ('tp20s10', (.20, .10))):
        s = pe * (1 - a); t = pe * (1 + m); R[nm] = comb(stop_idx(s), first(after & upto & (Hn > t[:, None])), s, t)
    for nm, h in (('t15', 15), ('t30', 30), ('t60', 60), ('t120', 120)): R[nm] = comb(big, big, pe, None, jend=jj + h)
    lowsofar = np.minimum.accumulate(np.where(ar >= OPEN, Ln, np.inf), 1)
    s = np.minimum(np.where(jj > OPEN, lowsofar[rows, np.maximum(jj - 1, 0)], pe * 0.97), pe * 0.9999); R['stlow'] = comb(stop_idx(s), big, s, None)
    for nm, a in (('tr5', .05), ('tr10', .10)):
        hh = np.where(ar >= jj[:, None], Hn, -np.inf); hh[rows, jj] = np.maximum(hh[rows, jj], pe)
        cm = np.maximum.accumulate(hh, 1); tr = np.full_like(cm, -np.inf); tr[:, 1:] = cm[:, :-1] * (1 - a)
        j = first(after & upto & (Ln <= tr)); jc = np.minimum(j, 959); lv = tr[rows, jc]; op = O[rows, jc]
        ms = j <= LAST; R[nm] = (np.where(ms, np.where(np.isnan(op), lv, np.minimum(op, lv)), Cf[:, LAST]), np.where(ms, 1, 0).astype(np.int8))
    R['on'] = (nxt_o, np.zeros(n, np.int8)); R['nd'] = (nxt_c, np.zeros(n, np.int8))
    return R
out = dict(d=d, T=T, pc=pc, o=o, **{'F_' + k: v for k, v in F.items()})
for name, (je, pe, kind) in EN.items():
    X = exits(je, pe, kind); jj = np.where(je >= 0, je, OPEN)
    out[f'{name}__je'] = je - OPEN * (je >= 0); out[f'{name}__pe'] = pe
    out[f'{name}__ret_open'] = pe / o - 1; out[f'{name}__vwd'] = np.where(jj > OPEN, pe / vwc[rows, np.maximum(jj - 1, 0)] - 1, 0)
    for k, (px, kk) in X.items(): out[f'{name}__x_{k}'] = px; out[f'{name}__k_{k}'] = kk
np.savez_compressed(OUT + '/gap.npz', **out)
json.dump(dict(entries={k: v[2] for k, v in EN.items()}, exits=list(X), gate=GATE), open(OUT + '/gap_meta.json', 'w'))
print('저장', n, '건', '진입', len(EN), '청산', len(X))
