# 시가 갭 +15% 이상 급등일 분봉(프리 4:00 ~ 애프터 20:00)을 달마다 npz로 묶음 → data/pack/gap15_YYYY-MM.npz (이미 있는 달은 건너뜀)
#   python3 history/pack_gap.py [최대 몇 달]   (한 번에 다 하면 오래 걸려서 나눠 실행)
#   d(날짜) T(종목) bars(N,960,6: 시고저종,거래량,VWAP; 0번 = 4:00 ET, 330번 = 9:30, 720번 = 16:00)
import os, sys, csv, json, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import et
D = os.path.join(HERE, 'data'); MIN = 60_000
safe = lambda T: ''.join(c if (c.isalnum() or c in '.-') else '_' for c in T)
def one(a):
    d, T = a; f = os.path.join(D, 'minute', d, safe(T) + '.json')
    if not os.path.exists(f): return None
    o_ts, _ = et.session(d); b = np.full((960, 6), np.nan, np.float32)
    for r in json.load(open(f)):
        i = (r[0] - o_ts) // MIN + 330
        if 0 <= i < 960: b[i] = r[1:7]
    return b
if __name__ == '__main__':
    from multiprocessing import Pool
    ev = [(r['날짜'], r['종목']) for r in csv.DictReader(open(os.path.join(D, 'events.csv'), encoding='utf-8-sig'))
          if float(r['전일종가']) > 0 and float(r['시가']) / float(r['전일종가']) - 1 >= 0.15]
    months = sorted({d[:7] for d, _ in ev}); lim = int(sys.argv[1]) if len(sys.argv) > 1 else 99; done = 0
    for m in months:
        fn = os.path.join(D, 'pack', f'gap15_{m}.npz')
        if os.path.exists(fn): continue
        if done >= lim: break
        em = [x for x in ev if x[0][:7] == m]
        with Pool(8) as p: B = p.map(one, em, chunksize=20)
        keep = [i for i, b in enumerate(B) if b is not None]
        np.savez_compressed(fn + '.tmp.npz', d=np.array([em[i][0] for i in keep]), T=np.array([em[i][1] for i in keep]), bars=np.stack([B[i] for i in keep]))
        os.replace(fn + '.tmp.npz', fn); done += 1
        print(m, len(keep), '/', len(em), os.path.getsize(fn) // 2**20, 'MB', flush=True)
