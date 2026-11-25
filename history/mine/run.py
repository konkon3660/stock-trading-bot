# 규칙 찾기 한 번에 돌리기 (먼저 history/pack_sip.py 로 분봉을 data/pack 에 묶어 둬야 함)
#   python3 history/mine/run.py            → 전부
#   python3 history/mine/run.py search_intra val_intra   → 원하는 단계만
#   python3 history/mine/run.py gap      → 갭상승 급등주(프리장 정보) 묶음만 (먼저 history/pack_gap.py 로 분봉을 묶어 둬야 함)
# 단계: panel(일봉 배열) → build_intra(당일매매 표) → search_intra(조건 1~2개 규칙 탐색) → val_intra(확인 기간) → ml_intra(기계학습)
#       → build_daily(며칠 보유 표) → search_daily → val_daily → excess_daily(다 사기 대비) → ml_daily → hold_daily(최종 기간 1회 시험)
# 기간: 찾기 ~2025-10, 확인 2025-11~2026-04, 최종 2026-05~ (며칠 보유는 사이 2주 비움). 결과·중간 파일은 history/results/mine
import os, sys, subprocess, time
HERE = os.path.dirname(os.path.abspath(__file__))
STEPS = ['panel', 'build_intra', 'search_intra', 'val_intra', 'ml_intra', 'build_daily', 'search_daily', 'val_daily', 'excess_daily', 'ml_daily', 'hold_daily', 'hatta']
GROUPS = {'gap': ['build_gap', 'search_gap', 'val_gap', 'hold_gap', 'ml_gap']}
args = sum((GROUPS.get(a, [a]) for a in sys.argv[1:]), [])
for s in (args or STEPS):
    t = time.time(); print(f'===== {s} =====', flush=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, s + '.py')], env={**os.environ, 'PYTHONWARNINGS': 'ignore'})
    if r.returncode: sys.exit(f'{s} 실패')
    print(f'({time.time() - t:.0f}초)', flush=True)
