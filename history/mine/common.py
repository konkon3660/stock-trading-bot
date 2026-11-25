import numpy as np
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from paths import OUT as W, DATA
ENTRY_KIND = {'orb5': 'brk', 'orb15': 'brk', 'orb30': 'brk', 'orb60': 'brk', 'at5': 'mkt', 'at15': 'mkt', 'at30': 'mkt', 'at60': 'mkt',
              'vwapx': 'mkt', 'dip25': 'lmt', 'dip50': 'lmt', 'dip100': 'lmt', 'at360': 'mkt'}
EXITS = ['close', 'st10', 'st25', 'st50', 'st100', 'tp50s25', 'tp100s50', 'tp100s100', 'tp200s100', 't30', 't60', 't120', 'stlow', 'tr50', 'tr100']
def load():
    Z = np.load(W + '/intra.npz', allow_pickle=False); return {k: Z[k] for k in Z.files}
def spread(px, mode='px'):
    # 전체 스프레드 비율: 기본은 2센트 또는 0.1% 중 큰 값 / flat은 예전 가정 0.2%
    return np.full_like(px, 0.002) if mode == 'flat' else np.maximum(0.001, 0.02 / px)
def net(Z, en, ex, k=1.0, mode='px'):
    pe = Z[f'{en}__pe']; px = Z[f'{en}__x_{ex}']; kx = Z[f'{en}__k_{ex}']; kind = ENTRY_KIND[en]
    s = spread(pe, mode) * k
    buy = pe * (1 + (0 if kind == 'lmt' else s / 2) + (0.001 * k if kind == 'brk' else 0)) * 1.001
    sell = px * (1 - np.where(kx == 2, 0, s / 2)) * (1 - np.where(kx == 1, 0.003 * k, 0)) * (1 - 0.0013)
    return sell / buy - 1
def gross(Z, en, ex):
    return Z[f'{en}__x_{ex}'] / Z[f'{en}__pe'] - 1
def daystat(r, d):
    # 하루 평균으로 묶은 뒤 날짜 간 평균·t값 (같은 날 거래끼리 상관이 있어서)
    u, inv = np.unique(d, return_inverse=True); s = np.bincount(inv, r); c = np.bincount(inv)
    m = s / c; n = len(m)
    if n < 3: return np.nan, np.nan, n
    return m.mean(), m.mean() / (m.std(ddof=1) / np.sqrt(n)), n
