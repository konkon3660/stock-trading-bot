# SIP 분봉(정규장)을 월별 npz로 묶음 → 다른 곳(분석 컨테이너)에서 빠르게 계산하려고
#   python3 history/pack_sip.py 2025-06 2025-07 ...   (이미 있는 달은 건너뜀)
# 파일: data/pack/sip_YYYY-MM.npz  — d(날짜) T(종목) bars(N,390,6: 시고저종,거래량,VWAP; 빈 분은 NaN)
import os, sys, json, glob, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import et
D = os.path.join(HERE, 'data'); OUT = os.path.join(D, 'pack'); MIN = 60_000
def one_day(d):
    o_ts, c_ts = et.session(d); Ts, B = [], []
    for f in sorted(glob.glob(os.path.join(D, 'minute_sip', d, '*.json'))):
        a = np.full((390, 6), np.nan, np.float32)
        for r in json.load(open(f)):
            i = (r[0] - o_ts) // MIN
            if 0 <= i < 390: a[i] = r[1:7]
        Ts.append(os.path.basename(f)[:-5]); B.append(a)
    return Ts, B
if __name__ == '__main__':
    from multiprocessing import Pool
    days = sorted(os.listdir(os.path.join(D, 'minute_sip')))
    for m in sys.argv[1:]:
        fn = os.path.join(OUT, f'sip_{m}.npz')
        if os.path.exists(fn): continue
        ds = [d for d in days if d.startswith(m)]
        with Pool(8) as p: R = p.map(one_day, ds)
        dd, TT, BB = [], [], []
        for d, (Ts, B) in zip(ds, R): dd += [d] * len(Ts); TT += Ts; BB += B
        np.savez_compressed(fn + '.tmp.npz', d=np.array(dd), T=np.array(TT), bars=np.stack(BB))
        os.replace(fn + '.tmp.npz', fn); print(m, len(ds), '일', len(TT), '건', os.path.getsize(fn) // 2**20, 'MB', flush=True)
