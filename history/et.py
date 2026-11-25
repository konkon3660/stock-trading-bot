# 미국 동부시간 계산 (zoneinfo 없이 — 윈도우 파이썬엔 시간대 데이터가 없을 수 있어서)
# 3월 둘째 일요일 2시 ~ 11월 첫째 일요일 2시는 UTC-4(서머타임), 그 외 UTC-5
import datetime as _dt
_UTC = _dt.timezone.utc

def _nth_sunday(y, m, n):
    first = _dt.date(y, m, 1)
    return 1 + (6 - first.weekday()) % 7 + 7 * (n - 1)

def offset_hours(ms):
    y = _dt.datetime.fromtimestamp(ms / 1000, _UTC).year
    s = _dt.datetime(y, 3, _nth_sunday(y, 3, 2), 7, tzinfo=_UTC).timestamp() * 1000
    e = _dt.datetime(y, 11, _nth_sunday(y, 11, 1), 6, tzinfo=_UTC).timestamp() * 1000
    return -4 if s <= ms < e else -5

def to_ms(d, h, m):
    """'YYYY-MM-DD' 날짜의 동부시간 h:m → epoch ms"""
    y, mo, dd = map(int, d.split('-'))
    naive = _dt.datetime(y, mo, dd, h, m, tzinfo=_UTC).timestamp() * 1000
    return int(naive - offset_hours(naive + 5 * 3600e3) * 3600e3)

def session(d):
    """정규장 (9:30, 16:00 동부시간) → (시작 ms, 끝 ms)"""
    return to_ms(d, 9, 30), to_ms(d, 16, 0)

def parts(ms):
    """epoch ms → ('YYYY-MM-DD', 동부시간 자정부터 분)"""
    t = _dt.datetime.fromtimestamp(ms / 1000 + offset_hours(ms) * 3600, _UTC)
    return t.date().isoformat(), t.hour * 60 + t.minute
