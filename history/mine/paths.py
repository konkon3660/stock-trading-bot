# 경로: history/data (원자료), history/data/pack (pack_sip.py로 묶은 분봉), history/results/mine (중간 파일·결과)
import os
HERE = os.path.dirname(os.path.abspath(__file__)); HIST = os.path.dirname(HERE)
DATA = os.path.join(HIST, 'data'); PACK = os.path.join(DATA, 'pack'); OUT = os.path.join(HIST, 'results', 'mine'); os.makedirs(OUT, exist_ok=True)
