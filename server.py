"""
갈래말래 로컬 서버 (파이썬 표준 라이브러리만 사용)

- 정적 파일(index.html 등) 제공
- /api/status     : 실시간 조회 가능 여부
- /api/schedules  : 국토교통부 TAGO(공공데이터포털) 기차·고속/시외버스·국내선 시간표와 요금 조회
- /tiles/z/x/y.png: OpenStreetMap 지도 타일 프록시 (앱 식별 정보를 붙여 받아 오고 .cache/tiles에 저장)

인증키 설정 (둘 중 하나):
  1) server_config.json 의 "DATA_GO_KR_KEY"
  2) 환경변수 DATA_GO_KR_KEY
공공데이터포털에서 아래 API를 '활용신청'한 뒤 발급된 일반 인증키(Decoding)를 넣으세요.
  - 국토교통부_(TAGO)_열차정보
  - 국토교통부_(TAGO)_고속버스정보
  - 국토교통부_(TAGO)_시외버스정보
  - 국토교통부_(TAGO)_국내항공운항정보

실행: python server.py  →  http://localhost:8000
"""
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, ".cache")
PORT = int(os.environ.get("PORT", "8000"))
BASE = "https://apis.data.go.kr/1613000"

# TAGO 오퍼레이션 경로 (2026-09 기준 apis.data.go.kr에서 존재 확인)
EP = {
    "train_city": "TrainInfo/GetCtyCodeList",
    "train_station": "TrainInfo/GetCtyAcctoTrainSttnList",
    "train": "TrainInfo/GetStrtpntAlocFndTrainInfo",
    "exp_terminal": "ExpBusInfo/GetExpBusTrminlList",
    "exp": "ExpBusInfo/GetStrtpntAlocFndExpbusInfo",
    "sub_terminal": "SuburbsBusInfo/GetSuberbsBusTrminlList",
    "sub": "SuburbsBusInfo/GetStrtpntAlocFndSuberbsBusInfo",
    "flight": "DmstcFlightNvgInfo/GetFlightOpratInfoList",
}

API_ERRORS = {
    "SERVICE_KEY_IS_NOT_REGISTERED": "인증키가 등록되지 않았거나 해당 API 활용신청이 안 되어 있어요 (승인 직후엔 1~2시간 걸릴 수 있어요)",
    "LIMITED_NUMBER_OF_SERVICE_REQUESTS": "일일 호출 한도를 초과했어요",
    "SERVICE_ACCESS_DENIED": "서비스 접근이 거부됐어요 (활용신청 상태를 확인해 주세요)",
    "NO_OPENAPI_SERVICE": "해당 오픈API 서비스가 없어요",
}

# 검증된 TAGO 역 코드 (나머지는 도시별 역 목록을 받아 이름으로 찾는다)
# ---------- 지도 타일 프록시 ----------
# OpenStreetMap 타일 서버는 앱 식별 정보(User-Agent) 없이 오는 요청에 'Access blocked' 이미지를 돌려준다.
# 서버가 대신 받아 오면서 식별 정보를 붙이고, 받은 타일은 .cache/tiles에 저장해 재사용한다.
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
TILE_UA = "GallaeMallae-TravelPlanner/1.0 (local personal trip planner)"
TILE_DIR = os.path.join(CACHE_DIR, "tiles")
TILE_TTL = 14 * 86400
BLOCKED_TILE_SHA1 = {"0cfb5f443183efc5921f61005aaa7f341fcfd143"}  # OSM 'Access blocked' 안내 이미지
_tile_slots = threading.BoundedSemaphore(4)  # 동시 다운로드 제한 (OSM 이용 정책)


def get_tile(z, x, y):
    """(PNG 바이트, 캐시 여부) 반환. 실패하면 TagoError."""
    path = os.path.join(TILE_DIR, str(z), str(x), f"{y}.png")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < TILE_TTL:
        with open(path, "rb") as f:
            return f.read(), True
    req = urllib.request.Request(TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": TILE_UA})
    with _tile_slots:
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                data = res.read()
        except (urllib.error.URLError, OSError) as e:
            if os.path.exists(path):  # 오래된 캐시라도 있으면 사용
                with open(path, "rb") as f:
                    return f.read(), True
            raise TagoError(f"타일 다운로드 실패: {e}")
    if hashlib.sha1(data).hexdigest() in BLOCKED_TILE_SHA1:
        raise TagoError("OpenStreetMap이 타일 요청을 차단했어요")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return data, False


KNOWN_STATIONS = {
    "서울": "NAT010000", "광명": "NATH10219", "오송": "NAT050044",
    "대전": "NAT011668", "동대구": "NAT013271", "부산": "NAT014445",
}


def load_key():
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    path = os.path.join(ROOT, "server_config.json")
    if not key and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                key = str(json.load(f).get("DATA_GO_KR_KEY", "")).strip()
        except (OSError, ValueError):
            key = ""
    # 'Encoding' 키를 붙여 넣은 경우도 처리
    return urllib.parse.unquote(key) if key else ""


SERVICE_KEY = load_key()


class TagoError(Exception):
    pass


def call(name, **params):
    """TAGO API 호출 → item 리스트 (키는 소문자로 통일)"""
    q = {"serviceKey": SERVICE_KEY, "_type": "json", "pageNo": 1, "numOfRows": 1000, **params}
    url = f"{BASE}/{EP[name]}?{urllib.parse.urlencode(q)}"
    try:
        with urllib.request.urlopen(url, timeout=15) as res:
            text = res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # 인증 오류 등은 HTTP 4xx + 오류 본문으로 온다
        text = e.read().decode("utf-8", "replace")
        for code, msg in API_ERRORS.items():
            if code in text:
                raise TagoError(msg)
        raise TagoError(f"HTTP {e.code}")
    except urllib.error.URLError as e:
        raise TagoError(f"네트워크 오류: {e.reason}")
    for code, msg in API_ERRORS.items():
        if code in text:
            raise TagoError(msg)
    try:
        data = json.loads(text)
    except ValueError:
        raise TagoError("응답 형식 오류")
    resp = data.get("response", {})
    code = str(resp.get("header", {}).get("resultCode", ""))
    if code not in ("00", "0000", ""):
        raise TagoError(resp.get("header", {}).get("resultMsg", f"오류 코드 {code}"))
    items = (resp.get("body") or {}).get("items") or {}
    items = items.get("item", []) if isinstance(items, dict) else []
    if isinstance(items, dict):
        items = [items]
    return [{str(k).lower(): v for k, v in it.items()} for it in items]


# ---------- 역·터미널 코드 (파일 캐시) ----------
_lock = threading.Lock()


def cached(name, builder):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{name}.json")
    with _lock:
        if os.path.exists(path) and time.time() - os.path.getmtime(path) < 30 * 86400:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        data = builder()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        return data


def call_many(jobs):
    """여러 TAGO 호출을 동시에 실행 → 결과 리스트 (실패한 호출은 TagoError 객체)"""
    def run(job):
        name, params = job
        try:
            return call(name, **params)
        except TagoError as e:
            return e
    if not jobs:
        return []
    with ThreadPoolExecutor(max_workers=min(6, len(jobs))) as ex:
        return list(ex.map(run, jobs))


def train_stations():
    def build():
        cities = call("train_city")
        out = {}
        for res in call_many([("train_station", {"cityCode": c.get("citycode")}) for c in cities]):
            if isinstance(res, TagoError):
                continue
            for s in res:
                out[str(s.get("nodename"))] = s.get("nodeid")
        return out
    return cached("train_stations", build)


def terminals(kind):
    def build():
        return {str(t.get("terminalnm")): t.get("terminalid") for t in call(f"{kind}_terminal")}
    return cached(f"{kind}_terminals", build)


def find_id(table, name):
    if name in table:
        return table[name]
    for k, v in table.items():
        if k.replace(" ", "").startswith(name) or name in k:
            return v
    return None


def station_id(name):
    return KNOWN_STATIONS.get(name) or find_id(train_stations(), name)


# ---------- 시간표 조회 ----------
def hhmm(v):
    s = str(v)
    return f"{s[8:10]}:{s[10:12]}" if len(s) >= 12 else ""


def to_int(v):
    try:
        return int(float(str(v).replace(",", "")))
    except (TypeError, ValueError):
        return 0


def first_error(results):
    errs = [r for r in results if isinstance(r, TagoError)]
    return errs[0] if errs and len(errs) == len(results) else None


def train_no(v):
    """코레일 표기와 같은 열차번호 (1 → '001', 1201 → '1201')"""
    s = str(v if v is not None else "").strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s.zfill(3) if s.isdigit() else s


def rail(frm_names, to_names, date):
    """도시마다 여러 역(예: 서울·용산·청량리)을 함께 조회해 코레일 열차번호 기준으로 합친다."""
    pairs = []
    for fn in frm_names:
        a = station_id(fn)
        for tn in to_names:
            b = station_id(tn)
            if a and b and a != b:
                pairs.append((fn, tn, a, b))
    if not pairs:
        raise TagoError(f"역 코드를 찾지 못했어요 ({'·'.join(frm_names)} → {'·'.join(to_names)})")
    results = call_many([("train", {"depPlaceId": a, "arrPlaceId": b, "depPlandTime": date}) for _, _, a, b in pairs])
    err = first_error(results)
    if err:
        raise err
    out, seen = [], set()
    for (fn, tn, _, _), items in zip(pairs, results):
        if isinstance(items, TagoError):
            continue
        for it in items:
            grade = str(it.get("traingradename") or "열차").strip()
            if "SRT" in grade.upper():  # SRT는 운행하지 않으므로 제외
                continue
            no = train_no(it.get("trainno"))
            dep = hhmm(it.get("depplandtime"))
            key = no or (grade, dep)
            if key in seen:  # 같은 열차가 여러 역 조합에서 중복으로 나오면 앞(대표역)의 것만 사용
                continue
            seen.add(key)
            out.append({
                "grade": grade,
                "name": f"{grade} {no}".strip(),
                "dep": dep, "arr": hhmm(it.get("arrplandtime")),
                "fare": to_int(it.get("adultcharge")),
                "depSt": str(it.get("depplacename") or fn), "arrSt": str(it.get("arrplacename") or tn),
            })
    return out


def bus(frm_names, to_names, date):
    """고속버스·시외버스를 모두 조회해 합친다 (티머니GO에서 파는 두 종류)."""
    jobs, meta = [], []
    for kind in ("exp", "sub"):
        try:
            table = terminals(kind)
        except TagoError:
            if kind == "exp":
                raise  # 고속버스 목록조차 안 되면 키·신청 문제이므로 그대로 알림
            continue  # 시외버스 API는 활용신청을 안 했을 수 있음
        names = {v: k for k, v in table.items()}
        seen_pairs = set()
        for fn in frm_names:
            a = find_id(table, fn)
            for tn in to_names:
                b = find_id(table, tn)
                if not a or not b or a == b or (a, b) in seen_pairs:
                    continue
                seen_pairs.add((a, b))
                jobs.append((kind, {"depTerminalId": a, "arrTerminalId": b, "depPlandTime": date}))
                meta.append((kind, names.get(a, fn), names.get(b, tn)))
    results = call_many(jobs)
    err = first_error(results)
    if err:
        raise err
    out, seen = [], set()
    for (kind, dep_nm, arr_nm), items in zip(meta, results):
        if isinstance(items, TagoError):
            continue
        label = "고속버스" if kind == "exp" else "시외버스"
        for it in items:
            grade = str(it.get("gradenm") or "").strip()
            dep_st = str(it.get("depplacenm") or dep_nm)
            arr_st = str(it.get("arrplacenm") or arr_nm)
            dep = hhmm(it.get("depplandtime"))
            key = (kind, dep_st, arr_st, dep, grade)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "grade": grade or label,
                "name": f"{label} {grade}".strip(),
                "dep": dep, "arr": hhmm(it.get("arrplandtime")),
                "fare": to_int(it.get("charge")),
                "depSt": dep_st, "arrSt": arr_st,
            })
    return out


def air(frm, to, date):
    items = call("flight", depAirportId=f"NAAR{frm}", arrAirportId=f"NAAR{to}", depPlandTime=date)
    return [{
        "grade": it.get("airlinenm", "항공"),
        "name": str(it.get("vihicleid", "")),
        "dep": hhmm(it.get("depplandtime")), "arr": hhmm(it.get("arrplandtime")),
        "fare": to_int(it.get("economycharge")) or to_int(it.get("prestigecharge")),
    } for it in items]


# 같은 노선·날짜를 다시 열 때 공공데이터포털 일일 호출 한도를 아끼기 위한 조회 결과 캐시 (10분)
_sched_cache = {}
SCHED_TTL = 600


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        # 정적 파일 로그는 생략하고 API 요청만 출력
        if args and "/api/" in str(args[0]):
            sys.stderr.write("[api] " + fmt % args + "\n")

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_tile(self, path):
        parts = path.split("/")  # ['', 'tiles', z, x, 'y.png']
        try:
            z, x, y = int(parts[2]), int(parts[3]), int(parts[4].split(".")[0])
            if not (0 <= z <= 19 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
                raise ValueError
        except (IndexError, ValueError):
            self.send_error(400)
            return
        try:
            data, _ = get_tile(z, x, y)
        except TagoError as e:
            sys.stderr.write(f"[tile] {z}/{x}/{y}: {e}\n")
            self.send_error(502)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/tiles/"):
            return self.send_tile(u.path)
        if u.path == "/api/status":
            return self.send_json({"live": bool(SERVICE_KEY), "tiles": True})
        if u.path == "/api/schedules":
            q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
            if not SERVICE_KEY:
                return self.send_json({"ok": False, "error": "인증키 없음"})
            mode, frm, to, date = q.get("mode"), q.get("from", ""), q.get("to", ""), q.get("date", "")
            ckey = (mode, frm, to, date)
            hit = _sched_cache.get(ckey)
            if hit and time.time() - hit[0] < SCHED_TTL:
                return self.send_json({"ok": True, "items": hit[1]})
            try:
                if mode == "rail":
                    items = rail(frm.split("|"), to.split("|"), date)
                elif mode == "bus":
                    items = bus(frm.split("|"), to.split("|"), date)
                elif mode == "air":
                    items = air(frm, to, date)
                else:
                    return self.send_json({"ok": False, "error": "알 수 없는 교통수단"})
                items = [i for i in items if i["dep"]]
                _sched_cache[ckey] = (time.time(), items)
                return self.send_json({"ok": True, "items": items})
            except TagoError as e:
                return self.send_json({"ok": False, "error": str(e)})
            except Exception as e:  # 예상 못 한 응답 형식 등
                return self.send_json({"ok": False, "error": f"서버 오류: {e}"})
        return super().do_GET()


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"갈래말래 서버 실행 중 → {url}")
    print("실시간 시간표:", "사용 (공공데이터포털 키 확인됨)" if SERVICE_KEY else "미사용 (server_config.json에 DATA_GO_KR_KEY를 넣으면 활성화)")
    print("종료하려면 Ctrl+C")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")


if __name__ == "__main__":
    main()
