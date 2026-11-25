# 갭상승 눌림 — '크게 가는 종목(+100% 이상)을 더 먹을 수 있나' (2026-11-26 사용자 질문)
# 지금 규칙(시가 -5% 지정가, +10% 전부 매도 / -20% 손절 / 15:58 정리)과, 일부를 남겨 더 끌고 가는 방식 비교. 변형은 미리 정함.
# 그리고 '남긴 부분'이 체결 뒤 그날 최고 상승폭 구간별로 지금 규칙보다 얼마나 벌고/잃었는지 나눠 봄.
# 결과: results/mine/variants8_gap.txt
import os, numpy as np, collections
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'variants3_gap.py')
exec(compile(open(p, encoding='utf-8').read().split("print(f\"체결 {len(E)}")[0], p, 'exec'))
BASE = [(1, .80, 1.10)]
V = [  # (이름, [(비중, 손절배수, 목표배수, 추적(시작, 고점 대비), 본전 손절 시작)])
    ('지금: 전부 +10%', BASE),
    ('반 +10%, 반 +50%', [(.5, .80, 1.10), (.5, .80, 1.50)]),
    ('반 +10%, 반 +100%', [(.5, .80, 1.10), (.5, .80, 2.00)]),
    ('반 +10%, 반 마감까지', [(.5, .80, 1.10), (.5, .80, None)]),
    ('반 +10%, 반 +10% 뒤 본전 손절·마감까지', [(.5, .80, 1.10), (.5, .80, None, None, 1.10)]),
    ('반 +10%, 반 +10% 뒤 고점 -20% 추적', [(.5, .80, 1.10), (.5, .80, None, (1.10, .20))]),
    ('3/4 +10%, 1/4 +10% 뒤 본전 손절·마감까지', [(.75, .80, 1.10), (.25, .80, None, None, 1.10)]),
    ('전부 목표 없이 마감까지', [(1, .80, None)]),
]
PER = [lambda x: x < '2025-11-01', lambda x: '2025-11-01' <= x < '2026-05-01', lambda x: x >= '2026-05-01']
run = lambda spec, i, j, pe: netp(pe, [(w,) + tr(i, j, pe, *a) for w, *a in spec])
mx = {i: max(h for h in HL[i][j:LAST + 1] if not isn(h)) / pe - 1 for i, j, pe in E}  # 체결 뒤 그날(15:58까지) 최고가
base = {i: run(BASE, i, j, pe) for i, j, pe in E}
B = [(-1, .10, '+10% 못 감'), (.10, .30, '+10~30%'), (.30, .50, '+30~50%'), (.50, 1.0, '+50~100%'), (1.0, 99, '+100% 이상')]
print(f"체결 {len(E)}건. 체결 뒤 그날 최고 상승폭: " + ', '.join(f"{nm} {sum(lo <= mx[i] < hi for i in mx)}건" for lo, hi, nm in B))
print(f"{'방식':40} {'2년':>7} {'t':>5} {'찾기':>7} {'확인':>7} {'최종':>7} | 지금 규칙 대비 차이 합계 (거래당 % 합, 구간별)")
print(f"{'':40} {'':>7} {'':>5} {'':>7} {'':>7} {'':>7} | " + ' '.join(f'{nm:>10}' for _, _, nm in B) + f" {'합계':>8}")
for name, spec in V:
    R = {i: run(spec, i, j, pe) for i, j, pe in E}
    by = collections.defaultdict(list)
    for i, r in R.items(): by[d[i]].append(r)
    ks = sorted(by); m = np.array([np.mean(by[k]) for k in ks]); t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
    per = [m[[f(k) for k in ks]].mean() for f in PER]
    diff = [sum(R[i] - base[i] for i in R if lo <= mx[i] < hi) for lo, hi, _ in B]
    print(f"{name:40} {m.mean()*100:+6.2f}% {t:+5.1f} " + ' '.join(f'{q*100:+6.2f}%' for q in per) + ' | ' + ' '.join(f'{x*100:+9.0f}%' for x in diff) + f" {sum(diff)*100:+7.0f}%")
print("\n읽는 법: 오른쪽은 그 방식이 지금 규칙보다 더 번(+)/잃은(-) 수익률을 그 구간 거래끼리 더한 것. '+100% 이상' 칸이 크게 플러스여도 '+10~30%' 칸에서 더 크게 잃으면 손해")
