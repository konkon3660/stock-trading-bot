"""세션별(데이마켓·프리·정규·애프터) 시장 상태 비교: 스프레드, 최우선 호가 잔량, 거래대금.

사용: python research/sessions.py                (data/recordings/ 아래 모든 날짜)
      python research/sessions.py 2026-11-17     (특정 날짜만)
      python research/sessions.py --dir=data-mock/recordings   (다른 녹화 폴더)
필요: numpy

프리·애프터·데이마켓에서 단타가 말이 되는지 보는 첫 단계예요.
스프레드가 정규장(약 0.9%)보다 훨씬 넓으면, 거기서는 신호가 좋아도 비용에 다 먹혀요.
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
H = 3600000
NAMES = {'day': '데이마켓', 'pre': '프리장', 'regular': '정규장', 'after': '애프터장'}


def phases(meta):
    o, c = meta['open'], meta['close']; p = meta.get('phases') or {}
    return {'day': p.get('day') or {'s': o - 13.5 * H, 'e': o - 5.5 * H - 600000}, 'pre': p.get('pre') or {'s': o - 5.5 * H, 'e': o},
            'regular': {'s': o, 'e': c}, 'after': p.get('after') or {'s': c, 'e': c + 4 * H - 600000}}


def phase_of(P, t):
    for k in ['regular', 'pre', 'after', 'day']:
        if P[k]['s'] <= t < P[k]['e']: return k
    return None


def report(d):
    meta = json.load(open(os.path.join(d, '_meta.json'))); P = phases(meta)
    sp, dep, books_n = {k: [] for k in P}, {k: [] for k in P}, {k: 0 for k in P}
    bp = os.path.join(d, '_books.jsonl')
    for l in (open(bp) if os.path.exists(bp) else []):
        b = json.loads(l); ph = phase_of(P, b['t'])
        if not ph or not b['a'] or not b['b']: continue
        a, bb = b['a'][0], b['b'][0]; mid = (a['p'] + bb['p']) / 2
        sp[ph].append((a['p'] - bb['p']) / mid); dep[ph].append(min(a['q'] * a['p'], bb['q'] * bb['p'])); books_n[ph] += 1
    dv, syms, mins = {k: 0.0 for k in P}, {k: set() for k in P}, {k: 0 for k in P}
    for f in os.listdir(d):
        if not f.endswith('.json') or f.startswith('_'): continue
        for x in json.load(open(os.path.join(d, f))):
            ph = phase_of(P, x['t'])
            if ph and x['v'] > 0: dv[ph] += x['c'] * x['v']; syms[ph].add(f[:-5]); mins[ph] += 1
    print(f"\n=== {meta['date']} ===")
    print(f"{'세션':8} | {'호가 표본':>8} | {'스프레드 중앙값':>12} | {'상위 25%':>8} | {'최우선 잔량(작은 쪽) 중앙값':>18} | {'거래대금':>10} | 종목")
    for k in ['day', 'pre', 'regular', 'after']:
        s = np.array(sp[k]); q = np.array(dep[k])
        med = f'{np.median(s) * 100:.2f}%' if len(s) else '-'; p75 = f'{np.percentile(s, 75) * 100:.2f}%' if len(s) else '-'
        dq = f'${np.median(q):,.0f}' if len(q) else '-'
        print(f"{NAMES[k]:8} | {books_n[k]:>8} | {med:>12} | {p75:>8} | {dq:>18} | ${dv[k] / 1e6:>8.1f}M | {len(syms[k])}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    base = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--dir=')), os.path.join(ROOT, 'data', 'recordings'))
    if not os.path.isabs(base): base = os.path.join(ROOT, base)
    days = args or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, '_meta.json')))
    for day in days: report(os.path.join(base, day))
    print('\n읽는 법: 스프레드는 한 번 사고팔 때 내는 비용과 거의 같아요(+수수료 0.27%). 최우선 잔량이 $30보다 작으면 한 번에 다 체결되기도 어려워요.')


if __name__ == '__main__':
    main()
