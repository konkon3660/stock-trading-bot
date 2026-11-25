# analyze.py — 받은 빅데이터 분석 입구 (2026-11-20 정리). 파이썬 3.9 이상, 추가 패키지 없음.
# 프로젝트 폴더(C:\Projects\toss-bot)에서:
#   python history/analyze.py status                      데이터 현황 (받은 양, 기간, 빠진 날)
#   python history/analyze.py orb [옵션]                  5분 시가범위 돌파 — Stocks in Play 분봉 (data/minute_sip)
#        --stop 0.1,0.25,0.5,1.0   손절폭 (ATR 배수, 여러 개면 한 번에)
#   python history/analyze.py f [옵션] [--set tp=0.16 sl=0.08 hold=180]   F(VWAP 아래 눌림) — 급등일 분봉 (data/minute)
#   python history/analyze.py gainers [옵션]              조사한 6가지 전략 (갭 시가매수·15:30 모멘텀·갭앤고 등) — 급등일 분봉
#   python history/analyze.py hold [옵션]                 급등주를 며칠 들고 가면? — 일봉 (data/daily)
#   python history/analyze.py after [옵션]                급등주 종가 매수 → 애프터장 19:50 매도 — 급등일 분봉 (ext.py)
#   python history/analyze.py report <결과이름> [--split 2026-02-01] [--cost 0.5,1,2] [--by month|price|time] [--bot]
# 공통 옵션: --from YYYY-MM-DD --to YYYY-MM-DD --workers N(기본: 코어 수-1) --name 결과이름 --fresh(새로 계산)
# 결과는 history/results/<결과이름>/<날짜>.json 에 날짜별로 저장돼서, 중간에 꺼도 다시 돌리면 이어서 해요.
# 같은 이름으로 설정을 바꿔 돌리면 섞이지 않게 막아요 (--name을 바꾸거나 --fresh).
import os, sys, json, csv, glob, math, time, argparse, statistics as st, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import et
D = os.environ.get('HIST_DATA') or os.path.join(HERE, 'data')
RES = os.path.join(HERE, 'results')
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)

# ---------- 작업자 (병렬) ----------
_W = {}
def _init(job, params):
    _W['job'], _W['p'] = job, params
    if job == 'orb':
        import orb_sip as O; _W['O'] = O; _W['C'] = O.load_candidates()
    else:
        import backtest as B; _W['B'] = B
        if job == 'gainers': import research as R; _W['R'] = R
        if job == 'f': P = dict(B.BASE); P.update(params.get('set', {})); _W['P'] = P
        if job == 'after':
            import ext; _W['X'] = ext; E = {}
            for r in csv.DictReader(open(os.path.join(D, 'events.csv'), encoding='utf-8-sig')): E.setdefault(r['날짜'], {})[safe(r['종목'])] = r
            _W['E'] = E

def _work(d):
    job, p = _W['job'], _W['p']
    if job == 'orb':
        O = _W['O']; out = []
        for k, L in O.day_trades(d, _W['C'][d], stop_ks=tuple(p['stops'])).items():
            for x in L: x.update(v=f'ATR×{k}', g=x['x'] / x['e'] - 1, r=O.net(x), px=x['e']); out.append(x)
        return d, out
    B = _W['B']; data = B.load_massive(d)
    if job == 'f':
        out = B.run_day(data, d, _W['P'])
        for x in out:
            s = x['s']; x.update(v=p.get('label', 'F'), g=(x['xp'] / (1 - s / 2)) / (x['px'] / (1 + s / 2)) - 1)
        return d, out
    if job == 'after':
        out = _W['X'].run_day(d, data, _W['E'].get(d, {}))
        for x in out: x['v'] = '종가 매수 → 애프터 19:50'
        return d, out
    if job == 'gainers':
        out = _W['R'].run_day(d, data)
        for x in out: x['v'] = x.pop('s')
        return d, out

def run_job(job, a, params, days):
    name = a.name or job; out = os.path.join(RES, name); meta_f = os.path.join(out, '_meta.json')
    meta = dict(job=job, params=params)
    if a.fresh and os.path.isdir(out):
        for f in glob.glob(os.path.join(out, '*.json')): os.replace(f, f + '.old')   # 지우지 않고 .old로 (삭제 권한 없어도 됨)
    os.makedirs(out, exist_ok=True)
    if os.path.exists(meta_f):
        old = json.load(open(meta_f, encoding='utf-8'))
        if old != meta: sys.exit(f'results/{name} 는 다른 설정으로 계산돼 있어요: {old}\n  --name 다른이름 으로 새로 만들거나 --fresh 로 다시 계산하세요.')
    json.dump(meta, open(meta_f, 'w', encoding='utf-8'), ensure_ascii=False)
    todo = [d for d in days if not os.path.exists(os.path.join(out, d + '.json'))]
    print(f'{job}: {len(days)}일 중 {len(days) - len(todo)}일은 이미 있음, {len(todo)}일 계산 (작업자 {a.workers}개) → results/{name}')
    t0 = time.time(); n = 0
    def save(d, T):
        nonlocal n; n += 1
        with open(os.path.join(out, d + '.json.tmp'), 'w') as f: json.dump(T, f)
        os.replace(os.path.join(out, d + '.json.tmp'), os.path.join(out, d + '.json'))
        if n % 20 == 0 or n == len(todo):
            el = time.time() - t0; print(f'  {n}/{len(todo)}일 ({el:.0f}초, 남은 시간 약 {el / n * (len(todo) - n):.0f}초)', flush=True)
    if a.workers <= 1:
        _init(job, params)
        for d in todo: save(*_work(d))
    else:
        import multiprocessing as mp
        with mp.Pool(a.workers, initializer=_init, initargs=(job, params)) as pool:
            for d, T in pool.imap_unordered(_work, todo, chunksize=1): save(d, T)
    return name

# ---------- 날짜 목록 ----------
def rng(days, a): return [d for d in days if (not a.fr or d >= a.fr) and (not a.to or d <= a.to)]
def orb_days(a):
    import orb_sip as O; C = O.load_candidates(); root = os.path.join(D, 'minute_sip'); ok, miss = [], 0
    for d in rng(sorted(C), a):
        p = os.path.join(root, d)
        if os.path.isdir(p) and {safe(T) for T in C[d]} <= {f[:-5] for f in os.listdir(p)}: ok.append(d)
        else: miss += 1
    if miss: print(f'(빠진 종목이 있는 {miss}일은 건너뜀 — 결과가 부풀려지지 않게)')
    return ok
def minute_days(a):
    root = os.path.join(D, 'minute'); return rng(sorted(x for x in os.listdir(root) if os.path.isdir(os.path.join(root, x))), a) if os.path.isdir(root) else []

# ---------- 결과 요약 ----------
def tstat(v): return st.mean(v) / (st.pstdev(v) / math.sqrt(len(v))) if len(v) > 1 and st.pstdev(v) > 0 else float('nan')
def fmt(v): return f'{len(v):6d}건 {st.mean(v) * 100:+6.2f}% (t={tstat(v):+5.1f})' if v else '     0건'
def bucket(x, by):
    if by == 'month': return x['d'][:7]
    if by == 'price':
        p = x.get('px') or x.get('e') or 0
        return next(lab for lim, lab in [(1, '$1 미만'), (2, '$1~2'), (5, '$2~5'), (10, '$5~10'), (20, '$10~20'), (1e9, '$20 이상')] if p < lim)
    if by == 'time':
        m = et.parts(x['t'])[1] - 570 if 't' in x else -1
        return next(lab for lim, lab in [(0, '?'), (60, '개장~1시간'), (120, '1~2시간'), (240, '2~4시간'), (1e9, '4시간~')] if m < lim)
def report(name, a):
    out = os.path.join(RES, name); files = sorted(glob.glob(os.path.join(out, '????-??-??.json')))
    if not files: sys.exit(f'results/{name} 에 결과가 없어요')
    meta = json.load(open(os.path.join(out, '_meta.json'), encoding='utf-8'))
    T = [x for f in files if rng([os.path.basename(f)[:10]], a) for x in json.load(open(f))]
    days = sorted({os.path.basename(f)[:10] for f in files if rng([os.path.basename(f)[:10]], a)})
    print(f'\n=== {name} ({meta["job"]}) — {len(days)}일 ({days[0]} ~ {days[-1]}), 설정 {meta["params"]}')
    print('    비용: 스프레드·수수료·미끄러짐을 뺀 거래당 수익률. t가 ±2를 넘으면 우연으로 보기 어렵고, 새 규칙은 +3 이상이어야 믿을 만함')
    byv = collections.defaultdict(list)
    for x in T: byv[x['v']].append(x)
    costs = [float(c) for c in a.cost.split(',')] if a.cost else []
    for v, L in sorted(byv.items()):
        if a.bot and meta['job'] == 'f':
            import backtest as B; L = B.portfolio(L, dict(B.BASE)); v += ' (봇처럼 제한)'
        r = [x['r'] for x in L]; print(f'\n[{v}]  전체 {fmt(r)}  | 비용 전 {st.mean(x["g"] for x in L) * 100:+.2f}%  | 승률 {sum(y > 0 for y in r) / len(r) * 100:.0f}%')
        rs = sorted(r); print(f'    큰 수익 상위 2% 빼면 {st.mean(rs[:max(1, int(len(rs) * 0.98))]) * 100:+.2f}%')
        if a.split: print(f'    {a.split} 전 {fmt([x["r"] for x in L if x["d"] < a.split])}   |   이후 {fmt([x["r"] for x in L if x["d"] >= a.split])}')
        if 'r75' in L[0]:
            print(f'    애프터장 스프레드를 75% 지점(4.11%)으로 잡으면 {fmt([x["r75"] for x in L])}  | 애프터장에 판 비율 {sum(x["why"] == "애프터장" for x in L) / len(L) * 100:.0f}%')
        if costs and 'e' in L[0]:
            import orb_sip as O; print('    비용 배수(스프레드·미끄러짐): ' + '  '.join(f'×{k}: {st.mean(O.net(x, k) for x in L) * 100:+.2f}%' for k in costs))
        G = collections.defaultdict(list)
        for x in L: G[bucket(x, a.by)].append(x['r'])
        lab = {'month': '월별', 'price': '가격대별', 'time': '개장 후 시간대별'}[a.by]
        pos = sum(st.mean(g) > 0 for g in G.values())
        print(f'    {lab} (플러스 {pos}/{len(G)}): ' + '  '.join(f'{k}: {st.mean(g) * 100:+.1f}%({len(g)})' for k, g in sorted(G.items())))

# ---------- 일봉: 며칠 들고 가기 ----------
def hold(a):
    files = sorted(glob.glob(os.path.join(D, 'daily', '*.json'))); Dd = []
    for f in files:
        rows = json.load(open(f))
        if rows: Dd.append((os.path.basename(f)[:10], {r[0]: r for r in rows}))
    spr = lambda px: 0.006 if px < 1 else 0.008 if px < 2 else 0.005 if px < 5 else 0.003
    E = []
    for i in range(1, len(Dd) - 5):
        d, M = Dd[i]
        if not rng([d], a): continue
        P = Dd[i - 1][1]
        for T, r in M.items():
            p = P.get(T)
            if not p or p[4] <= 0: continue
            o, h, l, c, v, vw = r[1:7]; pc = p[4]
            if not (0.3 <= c <= 20) or c * v < 1e6 or not (0.15 <= h / pc - 1 <= 3): continue
            nx = [Dd[i + k][1].get(T) for k in (1, 2, 5)]
            if not nx[0] or not (1 / 3 < nx[0][1] / c < 3 and 1 / 3 < nx[0][4] / c < 3): continue
            cost = spr(c) + 0.0023; e = dict(gc=c / pc - 1, pos=(c - l) / (h - l) if h > l else 0.5)
            e['다음 날 시가'] = nx[0][1] / c - 1 - cost; e['다음 날 종가'] = nx[0][4] / c - 1 - cost
            e['2일 뒤 종가'] = nx[1][4] / c - 1 - cost if nx[1] and 1 / 3 < nx[1][4] / c < 3 else None
            e['5일 뒤 종가'] = nx[2][4] / c - 1 - cost if nx[2] and 1 / 3 < nx[2][4] / c < 3 else None
            E.append(e)
    print(f'급등일(장중 +15%↑, 종가 $0.3~20, 거래대금 $100만↑) {len(E)}건 — 그날 종가에 샀다면 (비용 뺀 뒤)')
    for k in ['다음 날 시가', '다음 날 종가', '2일 뒤 종가', '5일 뒤 종가']:
        v = [e[k] for e in E if e[k] is not None]
        print(f'  {k:8} 팔기: {fmt(v)}  중간값 {st.median(v) * 100:+.2f}%  오른 비율 {sum(x > 0 for x in v) / len(v) * 100:.0f}%')
        for lo, hi in [(0.15, 0.3), (0.3, 0.6), (0.6, 1.0), (1.0, 9)]:
            w = [e[k] for e in E if e[k] is not None and lo <= e['gc'] < hi]
            if w: print(f'      종가 상승률 {int(lo * 100)}~{int(hi * 100)}%: {fmt(w)}')

# ---------- 현황 ----------
def status():
    def cnt(sub):
        root = os.path.join(D, sub)
        if not os.path.isdir(root): return 0, []
        ds = sorted(x for x in os.listdir(root) if os.path.isdir(os.path.join(root, x)))
        return sum(len(os.listdir(os.path.join(root, x))) for x in ds), ds
    daily = sorted(os.path.basename(f)[:10] for f in glob.glob(os.path.join(D, 'daily', '*.json')))
    print(f'일봉: {len(daily)}일 ({daily[0] if daily else "-"} ~ {daily[-1] if daily else "-"}) — 저가 $30 이하 전 종목')
    for sub, ev, lab in [('minute', 'events.csv', '급등일 분봉 (장중 +15%↑, 프리·애프터 포함)'), ('minute_sip', 'sip_events.csv', 'Stocks in Play 분봉 ($5~30 거래 많은 종목, 정규장만)')]:
        n, ds = cnt(sub); tot = sum(1 for _ in open(os.path.join(D, ev), encoding='utf-8-sig')) - 1 if os.path.exists(os.path.join(D, ev)) else 0
        print(f'{lab}: {n:,}/{tot:,}건 ({n / tot * 100 if tot else 0:.0f}%), {len(ds)}일 ({ds[0] if ds else "-"} ~ {ds[-1] if ds else "-"})')
    for f, lab in [('event_stats.json', '급등일별 ATR·평균 거래량'), ('stock_types.json', '종목 종류·배율'), ('splits.json', '분할·병합 목록')]:
        print(f'{lab}: {"있음" if os.path.exists(os.path.join(D, f)) else "없음"} (data/{f})')
    if os.path.isdir(RES):
        for n in sorted(os.listdir(RES)):
            m = os.path.join(RES, n, '_meta.json')
            if os.path.exists(m): print(f'저장된 결과 results/{n}: {len(glob.glob(os.path.join(RES, n, "????-??-??.json")))}일, {json.load(open(m, encoding="utf-8"))}')

def main():
    ap = argparse.ArgumentParser(description='받은 데이터 분석 (자세한 건 history/README.md)')
    ap.add_argument('cmd', choices=['status', 'orb', 'f', 'gainers', 'after', 'hold', 'report'])
    ap.add_argument('name_arg', nargs='?', help='report 할 결과 이름')
    ap.add_argument('--from', dest='fr'); ap.add_argument('--to'); ap.add_argument('--name'); ap.add_argument('--fresh', action='store_true')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--stop', default='0.1'); ap.add_argument('--set', nargs='*', default=[])
    ap.add_argument('--split'); ap.add_argument('--cost', default=''); ap.add_argument('--by', default='month', choices=['month', 'price', 'time']); ap.add_argument('--bot', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'status': return status()
    if a.cmd == 'hold': return hold(a)
    if a.cmd == 'report': return report(a.name_arg or sys.exit('결과 이름을 주세요 (예: report orb)'), a)
    if a.cmd == 'orb':
        name = run_job('orb', a, {'stops': [float(x) for x in a.stop.split(',')]}, orb_days(a)); a.cost = a.cost or '0.5,1,2'
    elif a.cmd == 'f':
        sets = {k: (v.lower() == 'true' if v.lower() in ('true', 'false') else None if v == 'None' else float(v)) for k, v in (kv.split('=') for kv in a.set)}
        name = run_job('f', a, {'set': sets, 'label': 'F' + (' ' + ' '.join(a.set) if a.set else '')}, minute_days(a))
    elif a.cmd == 'after':
        name = run_job('after', a, {'spread': 'ah 1.62%/4.11%'}, minute_days(a))
    else:
        name = run_job('gainers', a, {}, minute_days(a))
    report(name, a)

if __name__ == '__main__':
    main()
