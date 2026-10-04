/*
 * 여행 일정 엔진
 *  - 왕복/현지 교통비 계산, 예산 기반 여행지 필터링, 선호도 가지치기 점수
 *  - 관광지 선정 → 일자별 군집(k-means) → 일자별 방문 순서(최근접 이웃 + 2-opt) → 식사·카페 삽입 → 비용 합산
 */
(function (root) {
  'use strict';

  // ---------- 공통 유틸 ----------
  const toRad = d => d * Math.PI / 180;
  function hav(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(s));
  }
  const r100 = x => Math.round(x / 100) * 100;
  const sum = (arr, f = x => x) => arr.reduce((s, x) => s + f(x), 0);
  const avg = arr => (arr.length ? sum(arr) / arr.length : 0);
  const centroid = pts => ({ lat: avg(pts.map(p => p.lat)), lng: avg(pts.map(p => p.lng)) });
  const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const ROAD = 1.3; // 직선거리 → 실제 이동거리 보정 계수

  // ---------- 상수 ----------
  const TAG_LABEL = { N: '자연', U: '도심', C: '문화·역사', S: '쇼핑', E: '체험', R: '휴식', F: '먹거리', V: '야경', H: '숨은 명소' };

  const MODES = {
    walk: { icon: '🚶', label: '최대한 걸을래요', desc: '3km 이내는 걷고, 그보다 멀 때만 대중교통' },
    transit: { icon: '🚌', label: '대중교통 중심', desc: '1km 이내는 걷고, 나머지는 버스·지하철' },
    taxi: { icon: '🚕', label: '택시도 괜찮아요', desc: '800m 넘으면 택시 (4명당 1대로 계산)' },
    optimize: { icon: '⚡', label: '알아서 최적화', desc: '구간마다 비용과 시간을 함께 따져 도보·대중교통·택시를 조합' },
  };
  const LEG_KIND = {
    walk: { icon: '🚶', label: '도보' },
    transit: { icon: '🚌', label: '대중교통' },
    taxi: { icon: '🚕', label: '택시' },
  };

  const QUESTIONS = [
    {
      key: 'nature', short: '자연/도심', title: '어떤 풍경 속에 있고 싶나요?',
      options: [
        { v: 'nature', icon: '🌿', label: '자연 중심', desc: '바다·산·숲·호수' },
        { v: 'city', icon: '🏙️', label: '도심 중심', desc: '핫플·골목·야경' },
      ],
      reason: v => (v === 'nature' ? '자연 명소 비중이 낮아요' : '도심 명소 비중이 낮아요'),
    },
    {
      key: 'food', short: '관광/맛집', title: '여행의 중심은 무엇인가요?',
      options: [
        { v: 'sight', icon: '📸', label: '관광 중심', desc: '볼거리를 최대한 많이' },
        { v: 'food', icon: '🍜', label: '맛집 중심', desc: '먹으러 떠나는 여행' },
      ],
      reason: v => (v === 'food' ? '먹거리 매력이 상대적으로 약해요' : '대표 볼거리가 상대적으로 적어요'),
    },
    {
      key: 'themes', multi: true, short: '테마', title: '끌리는 테마를 모두 골라주세요',
      options: [
        { v: 'C', icon: '🏛️', label: '문화·역사', desc: '궁궐·유적·박물관' },
        { v: 'S', icon: '🛍️', label: '쇼핑', desc: '시장·거리·편집숍' },
        { v: 'E', icon: '🎢', label: '체험', desc: '케이블카·액티비티' },
        { v: 'R', icon: '🛋️', label: '휴식', desc: '해변·공원·카페' },
      ],
      reason: () => '선택한 테마의 명소가 적어요',
    },
    {
      key: 'hidden', short: '유명/숨은', title: '어떤 곳 위주로 다닐까요?',
      options: [
        { v: 'famous', icon: '⭐', label: '유명 관광지 중심', desc: '꼭 가봐야 할 대표 명소' },
        { v: 'hidden', icon: '🔍', label: '숨은 명소 중심', desc: '덜 붐비는 로컬 스팟' },
      ],
      reason: v => (v === 'hidden' ? '숨은 명소가 적어요' : '대표 명소 비중이 낮아요'),
    },
  ];

  const CATEGORIES = [
    { v: 'C', icon: '🏛️', label: '문화·역사' },
    { v: 'N', icon: '🌿', label: '자연·풍경' },
    { v: 'F', icon: '🍜', label: '시장·먹거리' },
    { v: 'S', icon: '🛍️', label: '쇼핑' },
    { v: 'E', icon: '🎢', label: '체험·액티비티' },
    { v: 'R', icon: '☕', label: '휴식·카페' },
    { v: 'V', icon: '🌃', label: '야경' },
    { v: 'U', icon: '🏙️', label: '도심 핫플' },
  ];

  const LUNCH = { from: 11 * 60 + 30, early: 11 * 60, late: 15 * 60, dur: 60 };
  const DINNER = { from: 17 * 60 + 30, early: 17 * 60, late: 21 * 60, dur: 70 };
  const CAFE_DUR = 40;
  const MIN_WINDOW = 150; // 현지에서 최소 이만큼(분)은 머물러야 여행으로 인정
  const BREAKFAST = 7000; // 둘째 날부터 1인 간편 아침
  const MISC = 5000;      // 1인 1일 간식·기타

  // ---------- 데이터 준비 ----------
  function prepare(dests, stations, airRoutes) {
    if (stations) STATIONS = stations;
    if (airRoutes) AIR_ROUTES = airRoutes;
    if (dests._prepared) return dests;
    dests.forEach(d => {
      d.attractions = d.attractions.map((a, i) => ({
        id: `${d.id}-a${i}`, name: a[0], lat: a[1], lng: a[2], fee: a[3], dur: a[4], pop: a[5], tags: a[6].split(''), type: 'spot',
      }));
      d.restaurants = d.restaurants.map((r, i) => ({
        id: `${d.id}-r${i}`, name: r[0], lat: r[1], lng: r[2], price: r[3], menu: r[4], type: 'meal',
      }));
      d.cafes = d.cafes.map((c, i) => ({
        id: `${d.id}-c${i}`, name: c[0], lat: c[1], lng: c[2], price: c[3], menu: '커피·디저트', type: 'cafe',
      }));
      if (!d.center) d.center = centroid(d.attractions);

      const A = d.attractions;
      const cnt = t => A.filter(a => a.tags.includes(t)).length;
      const n = cnt('N'), u = cnt('U');
      // 관광지 간 평균 최근접 거리 → 예상 구간 이동시간(분)
      const nn = avg(A.map(a => Math.min(...A.filter(b => b !== a).map(b => hav(a, b)))));
      d.legEst = Math.max(15, Math.min(45, Math.round(nn * ROAD / 25 * 60 + 12)));
      d.profile = {
        nature: n / Math.max(1, n + u),
        hidden: cnt('H') / A.length,
        food: d.food,
        sight: sum(A.map(a => a.pop).sort((x, y) => y - x).slice(0, 8)),
        C: cnt('C') / A.length, S: cnt('S') / A.length, E: cnt('E') / A.length, R: cnt('R') / A.length,
      };
    });
    // 전체 여행지 기준 min-max 정규화 (가지치기 점수에 사용)
    Object.keys(dests[0].profile).forEach(k => {
      const vals = dests.map(d => d.profile[k]);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      dests.forEach(d => { (d.norm = d.norm || {})[k] = hi > lo ? (d.profile[k] - lo) / (hi - lo) : 0.5; });
    });
    dests._prepared = true;
    return dests;
  }

  // ---------- 왕복 교통 ----------
  const MODE_INFO = {
    rail: { icon: '🚄', label: '기차' },
    bus: { icon: '🚌', label: '고속·시외버스' },
    air: { icon: '✈️', label: '항공' },
    metro: { icon: '🚇', label: '광역버스·전철' },
  };
  let STATIONS = {}, AIR_ROUTES = [];
  const pt = (name, lat, lng) => ({ name, lat, lng });

  // 도시의 수단별 거점 (역·터미널·공항)
  function station(city, mode) {
    const s = STATIONS[city.id] || {};
    if (mode === 'rail' && s.rail) return { ...pt(s.rail[0], s.rail[1], s.rail[2]), tago: s.rail[3] };
    if (mode === 'bus' && s.bus) return { ...pt(s.bus[0], s.bus[1], s.bus[2]), tago: s.bus[3] };
    if (mode === 'air' && s.air) return { ...pt(s.air[0], s.air[3], s.air[4]), iata: s.air[1], icao: s.air[2] };
    return null;
  }
  const cityPoint = city => (city.hub && typeof city.hub === 'object' ? pt(city.hub.name, city.hub.lat, city.hub.lng) : pt(city.hub || city.name, city.lat, city.lng));
  const hasAirRoute = (a, b) => AIR_ROUTES.includes(`${a}-${b}`) || AIR_ROUTES.includes(`${b}-${a}`);

  // 두 도시 사이에 이용 가능한 장거리 수단
  function availableModes(origin, dest) {
    const road = hav(cityPoint(origin), cityPoint(dest)) * 1.25;
    if (!origin.island && !dest.island && road < 60) return ['metro'];
    const modes = [];
    if (station(origin, 'rail') && station(dest, 'rail')) modes.push('rail');
    if (station(origin, 'bus') && station(dest, 'bus')) modes.push('bus');
    const oa = station(origin, 'air'), da = station(dest, 'air');
    if (oa && da && oa.iata !== da.iata && hasAirRoute(oa.iata, da.iata)) modes.push('air');
    return modes;
  }

  // 공항 ↔ 시내 연결 (12km 이상 떨어지면 리무진·버스 구간 추가)
  function transfer(from, to) {
    const km = hav(from, to);
    if (km < 12) return null;
    return { from, to, label: '공항 리무진·버스', fare: r100(1500 + 90 * km), min: Math.round(km * 1.3 / 40 * 60 + 15), km };
  }

  // 수단별 예상 요금·시간 (시간표를 고르기 전의 추정치)
  function estimateFare(mode, km) {
    if (mode === 'rail') return { fare: r100(Math.max(8400, 2000 + 130 * km * 1.2)), min: Math.round(km * 1.2 / 140 * 60 + 25) };
    if (mode === 'bus') return { fare: r100(4000 + 78 * km * 1.25), min: Math.round(km * 1.25 / 75 * 60 + 20) };
    // 항공 예상시간 = 비행시간 + 탑승 수속 40분
    if (mode === 'air') return { fare: r100(38000 + 50 * km), min: Math.round(km / 650 * 60 + 25 + 40), flightMin: Math.round(km / 650 * 60 + 25) };
    const road = km * 1.25;
    return { fare: r100(1500 + Math.max(0, Math.ceil((road - 10) / 5)) * 100), min: Math.round(road / 30 * 60 + 15) };
  }

  // 한 방향 장거리 구간. ticket이 있으면 실제 시간표(출발·도착 시각·역, 요금)를 사용
  function longLeg(dir, origin, dest, mode, ticket) {
    const [A, B] = dir === 'out' ? [origin, dest] : [dest, origin];
    let from, to, pre = null, post = null;
    if (mode === 'metro') { from = cityPoint(A); to = cityPoint(B); }
    else {
      // 고른 편이 대표역이 아닌 역(예: 용산·청량리)에서 출발·도착하면 그 역 기준
      from = (ticket && ticket.from) || station(A, mode);
      to = (ticket && ticket.to) || station(B, mode);
      if (mode === 'air') { pre = transfer(cityPoint(A), from); post = transfer(to, cityPoint(B)); }
    }
    const km = hav(from, to);
    const est = estimateFare(mode, km);
    const info = MODE_INFO[mode];
    const leg = {
      dir, mode, icon: info.icon, label: info.label, from, to, pre, post, km,
      fare: ticket ? ticket.fare : est.fare,
      min: ticket ? ticket.arr - ticket.dep : est.min,
      dep: ticket ? ticket.dep : null,
      arr: ticket ? ticket.arr : null,
      ticket: ticket || null,
    };
    leg.extraFare = (pre ? pre.fare : 0) + (post ? post.fare : 0);
    leg.preMin = pre ? pre.min : 0;
    leg.postMin = post ? post.min : 0;
    return leg;
  }

  // 시간표를 고르지 않았을 때 쓸 기본 수단: 섬 → 항공, 빠르게 → 기차, 저렴하게 → 버스
  function defaultMode(origin, dest, pref) {
    const modes = availableModes(origin, dest);
    if (modes.includes('metro')) return 'metro';
    if (origin.island || dest.island) return modes.includes('air') ? 'air' : modes[0];
    const order = pref === 'fast' ? ['rail', 'bus', 'air'] : ['bus', 'rail', 'air'];
    return order.find(m => modes.includes(m)) || 'bus';
  }

  function trip(inp) {
    const t = inp.tickets || {};
    const dm = defaultMode(inp.origin, inp.dest, inp.intercity);
    return {
      out: longLeg('out', inp.origin, inp.dest, t.out ? t.out.mode : dm, t.out),
      ret: longLeg('ret', inp.origin, inp.dest, t.ret ? t.ret.mode : dm, t.ret),
    };
  }

  // ---------- 현지 이동 (구간 단위) ----------
  function legOptions(km, ctx) {
    const d = ctx.dest, people = ctx.people;
    const busFare = 1500 + Math.max(0, Math.ceil((km - 10) / 5)) * 100;
    const taxiFare = r100(4800 + Math.max(0, km - 1.6) * 1000 / 131 * 100);
    return {
      walk: { kind: 'walk', min: km / 4.5 * 60, cost: 0 },
      transit: { kind: 'transit', min: km / d.transit.speed * 60 + d.transit.wait + 4, cost: busFare * people },
      taxi: { kind: 'taxi', min: km / d.taxiSpeed * 60 + 4, cost: taxiFare * Math.ceil(people / 4) },
    };
  }

  function leg(a, b, ctx) {
    const km = hav(a, b) * ROAD;
    if (km < 0.25) return { kind: 'walk', min: Math.max(2, Math.round(km / 4.5 * 60)), cost: 0, km };
    const o = legOptions(km, ctx);
    let pick;
    switch (ctx.mode) {
      case 'walk': pick = km <= 3 ? o.walk : o.transit; break;
      case 'transit': pick = km <= 1 ? o.walk : o.transit; break;
      case 'taxi': pick = km <= 0.8 ? o.walk : o.taxi; break;
      default: {
        // 일반화 비용 = 요금 + 시간가치(원/분/인). 도보는 피로도 가중치 1.3
        const g = x => x.cost + x.min * ctx.vot * ctx.people * (x.kind === 'walk' ? 1.3 : 1);
        const list = [o.transit, o.taxi];
        if (km <= 2.5) list.push(o.walk);
        pick = list.reduce((p, q) => (g(q) < g(p) ? q : p));
      }
    }
    return { ...pick, min: Math.max(1, Math.round(pick.min)), km };
  }

  // ---------- 선호도 ----------
  function questionScore(dest, key, val) {
    const n = dest.norm;
    switch (key) {
      case 'nature': return val === 'nature' ? n.nature : 1 - n.nature;
      case 'food': return val === 'food' ? n.food : n.sight;
      case 'themes': return avg(val.map(t => n[t]));
      case 'hidden': return val === 'hidden' ? n.hidden : (1 - n.hidden) * 0.5 + n.sight * 0.5;
      default: return 0.5;
    }
  }

  const answered = v => v != null && v !== 'any' && !(Array.isArray(v) && !v.length);

  // 질문 순서대로 후보를 가지치기. 질문마다 점수 0.3 미만은 제외하되 최소 2곳은 남긴다.
  function prune(cands, prefs) {
    let alive = cands.slice();
    const pruned = {}, scores = {};
    QUESTIONS.forEach((q, qi) => {
      const val = prefs[q.key];
      if (!answered(val)) return;
      const sc = new Map(alive.map(c => [c, questionScore(c.dest, q.key, val)]));
      sc.forEach((s, c) => (scores[c.dest.id] = scores[c.dest.id] || []).push(s));
      const keep = new Set([...sc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]));
      alive = alive.filter(c => {
        if (sc.get(c) >= 0.3 || keep.has(c)) return true;
        pruned[c.dest.id] = { qi, q: q.short, reason: q.reason(val) };
        return false;
      });
    });
    const match = id => (scores[id] ? Math.round(avg(scores[id]) * 100) : null);
    return { alive, pruned, match };
  }

  function scoreSpot(a, prefs, cats) {
    const has = t => a.tags.includes(t);
    let s = a.pop * 0.8;
    if (prefs.nature === 'nature') s += has('N') ? 1.5 : has('U') ? -0.8 : 0;
    if (prefs.nature === 'city') s += has('U') ? 1.5 : has('N') ? -0.8 : 0;
    if (prefs.food === 'food') s += has('F') ? 1.5 : 0;
    if (prefs.food === 'sight') s += a.pop >= 4 ? 0.8 : 0;
    (prefs.themes || []).forEach(t => { if (has(t)) s += 1.2; });
    if (prefs.hidden === 'hidden') s += has('H') ? 1.8 : -(a.pop - 3) * 0.4;
    if (prefs.hidden === 'famous') s += (a.pop - 3) * 0.6 - (has('H') ? 0.8 : 0);
    cats.forEach(c => { if (has(c)) s += 1.3; });
    return s;
  }

  // ---------- 동선 ----------
  // end가 null이면 끝점이 열린 경로 (숙박일: 마지막 장소에서 하루 마무리)
  const dist = (a, b) => (a && b ? hav(a, b) : 0);

  function pathKm(start, pts, end) {
    const seq = [start, ...pts, end];
    let km = 0;
    for (let i = 1; i < seq.length; i++) km += dist(seq[i - 1], seq[i]) * ROAD;
    return km;
  }

  // 시작(·끝) 고정 경로: 최근접 이웃으로 초기해 → 2-opt 개선
  function tsp(start, end, pts) {
    if (pts.length <= 1) return pts.slice();
    const rest = pts.slice(), route = [];
    let cur = start;
    while (rest.length) {
      let bi = 0;
      rest.forEach((p, i) => { if (hav(cur, p) < hav(cur, rest[bi])) bi = i; });
      cur = rest.splice(bi, 1)[0];
      route.push(cur);
    }
    const path = [start, ...route, end];
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < path.length - 2; i++) {
        for (let j = i + 1; j < path.length - 1; j++) {
          const delta = dist(path[i - 1], path[j]) + dist(path[i], path[j + 1]) - dist(path[i - 1], path[i]) - dist(path[j], path[j + 1]);
          if (delta < -1e-9) {
            path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
            improved = true;
          }
        }
      }
    }
    return path.slice(1, -1);
  }

  // 야경 명소(최대 2곳)는 저녁 시간대가 있는 날에만 마지막으로 배치
  function orderRoute(start, end, pts, win) {
    const night = win.end >= 19 * 60
      ? pts.filter(p => p.tags.includes('V')).sort((a, b) => b.score - a.score).slice(0, 2)
      : [];
    const dayPts = pts.filter(p => !night.includes(p));
    const r1 = tsp(start, night.length ? centroid(night) : end, dayPts);
    const r2 = tsp(r1.length ? r1[r1.length - 1] : start, end, night);
    return r1.concat(r2);
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    return arr.flatMap((x, i) => permutations(arr.filter((_, j) => j !== i)).map(p => [x, ...p]));
  }

  // 관광지를 일자별로 묶기: k-means → 일자 순서 결정 → 가용시간에 맞춰 재배치
  function clusterDays(points, caps, legEst, fallback, hub) {
    const k = caps.length;
    if (k === 1) return [points.slice()];
    if (!points.length) return caps.map(() => []);
    const load = g => sum(g, p => p.dur + legEst);

    const c0 = centroid(points);
    const centers = [points.reduce((a, b) => (hav(b, c0) > hav(a, c0) ? b : a))].map(p => ({ lat: p.lat, lng: p.lng }));
    while (centers.length < Math.min(k, points.length)) {
      let best = null, bd = -1;
      points.forEach(q => { const d = Math.min(...centers.map(c => hav(c, q))); if (d > bd) { bd = d; best = q; } });
      centers.push({ lat: best.lat, lng: best.lng });
    }
    let assign = [];
    for (let it = 0; it < 20; it++) {
      assign = points.map(p => centers.reduce((bi, c, i) => (hav(c, p) < hav(centers[bi], p) ? i : bi), 0));
      centers.forEach((c, ci) => {
        const m = points.filter((_, pi) => assign[pi] === ci);
        if (m.length) Object.assign(c, centroid(m));
      });
    }
    const groups = centers.map((_, ci) => points.filter((_, pi) => assign[pi] === ci));
    while (groups.length < k) groups.push([]);

    // 묶음의 방문 순서(일자) 결정: 도착지 → 1일차 → 2일차 … → 귀가 지점이 한 줄로 이어지도록,
    // 가용시간 초과는 벌점으로 반영하여 모든 순열 중 최소 비용을 고른다 (최대 3일 → 6가지)
    const cents = groups.map(g => (g.length ? centroid(g) : null));
    let best = null, bestCost = Infinity;
    permutations(groups.map((_, i) => i)).forEach(perm => {
      let cost = 0, prev = hub;
      perm.forEach((gi, day) => {
        if (cents[gi]) { cost += hav(prev, cents[gi]); prev = cents[gi]; }
        cost += Math.max(0, load(groups[gi]) - caps[day]) * 0.3;
      });
      cost += hav(prev, hub);
      if (cost < bestCost) { bestCost = cost; best = perm; }
    });
    const byDay = best.map(gi => groups[gi]);

    // 넘치는 날의 장소를 여유 있는 가장 가까운 날로 이동
    for (let guard = 0; guard < 60; guard++) {
      const loads = byDay.map(load);
      const over = loads.map((l, i) => l - caps[i]);
      const i = over.indexOf(Math.max(...over));
      if (over[i] <= 20) break;
      let move = null, bestScore = Infinity;
      byDay[i].forEach(p => {
        byDay.forEach((g, j) => {
          if (j === i || loads[j] + p.dur + legEst > caps[j]) return;
          const cj = g.length ? centroid(g) : fallback;
          const ci = centroid(byDay[i]);
          const s = hav(p, cj) - hav(p, ci);
          if (s < bestScore) { bestScore = s; move = { p, j }; }
        });
      });
      if (!move) break;
      byDay[i] = byDay[i].filter(p => p !== move.p);
      byDay[move.j] = byDay[move.j].concat(move.p);
    }
    return byDay;
  }

  // ---------- 하루 일정 타임라인 ----------
  function nearestList(list, anchor, n) {
    return list
      .map(p => ({ place: p, km: hav(anchor, p) * ROAD }))
      .sort((a, b) => a.km - b.km)
      .slice(0, n);
  }

  function schedule(dayIdx, stops, win, start, end, ctx, choices, usedR) {
    const items = [];
    let t = win.start, pos = start;
    const covers = (a, b) => win.start <= a && win.end >= b;
    let lunch = covers(12 * 60 + 30, 13 * 60 + 30) ? 'todo' : 'skip';
    let dinner = covers(18 * 60, 19 * 60) ? 'todo' : 'skip';
    let cafe = ctx.wantCafe && covers(14 * 60 + 30, 16 * 60) ? 'todo' : 'skip';

    const move = to => {
      const l = leg(pos, to, ctx);
      items.push({ ...l, via: l.kind, kind: 'leg', time: t, from: pos, to });
      t += l.min;
      pos = to;
    };
    // 식사·카페: 현재 위치와 다음 목적지 사이(동선 위)에서 가까운 후보 3곳을 제시
    const eat = (type, key, label, nextPt) => {
      const all = type === 'cafe' ? ctx.dest.cafes : ctx.dest.restaurants;
      const pool = all.filter(r => !usedR.has(r.id));
      const src = pool.length >= 3 ? pool : all;
      const anchor = nextPt ? { lat: (pos.lat + nextPt.lat) / 2, lng: (pos.lng + nextPt.lng) / 2 } : pos;
      const options = nearestList(src, anchor, 3);
      const chosenId = choices[`${dayIdx}-${key}`];
      let chosen = chosenId && all.find(p => p.id === chosenId);
      // 카페는 동선에서 크게 벗어나면 생략 (사용자가 직접 고른 경우는 유지)
      if (type === 'cafe' && !chosen && options[0].km > 6) return false;
      if (chosen && !options.some(o => o.place === chosen)) options.push({ place: chosen, km: hav(anchor, chosen) * ROAD });
      if (!chosen) {
        // 예산이 빠듯하면 '가까운 후보들' 중 가장 저렴한 곳, 아니면 가장 가까운 곳
        const near = options.filter(o => o.km <= options[0].km + 2);
        chosen = ctx.tight ? near.reduce((a, b) => (b.place.price < a.place.price ? b : a)).place : options[0].place;
      }
      move(chosen);
      const dur = type === 'cafe' ? CAFE_DUR : key === 'lunch' ? LUNCH.dur : DINNER.dur;
      items.push({ kind: type, key: `${dayIdx}-${key}`, label, time: t, dur, place: chosen, options, cost: chosen.price * ctx.people });
      if (type === 'meal') usedR.add(chosen.id);
      t += dur;
      return true;
    };
    const wait = until => {
      if (until - t >= 10) items.push({ kind: 'free', time: t, dur: until - t });
      t = Math.max(t, until);
    };

    let i = 0;
    while (i < stops.length) {
      const s = stops[i];
      const finish = t + leg(pos, s, ctx).min + s.dur;
      if (lunch === 'todo') {
        if (t >= LUNCH.late) lunch = 'missed';
        else if (t >= LUNCH.from || (t >= LUNCH.early && finish > 13 * 60 + 30)) { eat('meal', 'lunch', '점심', s); lunch = 'done'; continue; }
      }
      if (dinner === 'todo') {
        if (t >= DINNER.late) dinner = 'missed';
        else if (t >= DINNER.from || (t >= DINNER.early && finish > 19 * 60 + 30)) { eat('meal', 'dinner', '저녁', s); dinner = 'done'; continue; }
      }
      if (cafe === 'todo' && lunch !== 'todo' && t >= 14 * 60 + 30 && t <= 17 * 60) {
        cafe = eat('cafe', 'cafe', '카페', s) ? 'done' : 'skip';
        continue;
      }
      move(s);
      items.push({ kind: 'spot', time: t, dur: s.dur, place: s, cost: s.fee * ctx.people });
      t += s.dur;
      i++;
    }

    // 관광지를 다 돈 뒤 남은 식사·카페 처리
    const endLeg = () => (end ? leg(pos, end, ctx).min : 0);
    if (lunch === 'todo' && t < LUNCH.late && Math.max(t, LUNCH.from) + LUNCH.dur + endLeg() <= win.end) {
      wait(LUNCH.from); eat('meal', 'lunch', '점심', end); lunch = 'done';
    }
    if (cafe === 'todo' && t >= 14 * 60 && t <= 17 * 60 && t + CAFE_DUR + endLeg() <= win.end) {
      cafe = eat('cafe', 'cafe', '카페', end) ? 'done' : 'skip';
    }
    if (dinner === 'todo' && t < DINNER.late) {
      const at = Math.max(t, DINNER.from);
      if (at + DINNER.dur + endLeg() <= win.end) { wait(at); eat('meal', 'dinner', '저녁', end); dinner = 'done'; }
      else if (Math.max(t, DINNER.early) + DINNER.dur + endLeg() <= win.end) { wait(Math.max(t, DINNER.early)); eat('meal', 'dinner', '이른 저녁', end); dinner = 'done'; }
    }
    const lastPos = pos;
    if (end) move(end);
    return { items, endTime: t, lastPos, overflow: t > win.end + 15 };
  }

  // ---------- 일정 생성 ----------
  // 첫날은 도착(+공항 연결) 후부터, 마지막 날은 귀가편 출발 전까지.
  // 시간표를 고른 경우 실제 도착·출발 시각을, 아니면 하루 시작·종료 시각에서 이동시간을 빼서 계산
  function dayWindows(inp, tr) {
    tr = tr || trip(inp);
    const ds = hm(inp.dayStart || '09:00'), de = hm(inp.dayEnd || '21:00');
    const { out, ret } = tr;
    // 역·터미널은 10분/20분, 공항은 수하물·탑승 수속으로 20분/50분 여유
    const first = out.arr != null ? out.arr + out.postMin + (out.mode === 'air' ? 20 : 10) : ds + out.preMin + out.min + out.postMin;
    const last = ret.dep != null ? ret.dep - ret.preMin - (ret.mode === 'air' ? 50 : 20) : de - (ret.preMin + ret.min + ret.postMin);
    return Array.from({ length: inp.days }, (_, i) => ({
      start: i === 0 ? first : ds,
      end: i === inp.days - 1 ? last : de,
    }));
  }

  function build(inp, opt) {
    const { dest, origin, people, days } = inp;
    const prefs = inp.prefs || {}, cats = inp.cats || [], choices = inp.choices || {};
    const must = new Set(inp.must || []);
    const exclude = opt.exclude || new Set();
    const tr = trip(inp);
    const ic = tr.out;
    const wins = dayWindows(inp, tr);
    const feasible = wins.every(w => w.end - w.start >= MIN_WINDOW);
    const ctx = {
      dest, people, mode: inp.mode, vot: opt.tight ? 40 : 150, tight: !!opt.tight,
      // 예산이 빠듯하면 카페는 '휴식·카페'를 직접 고른 경우에만 넣는다
      wantCafe: cats.includes('R') || (!opt.tight && (prefs.food === 'food' || (prefs.themes || []).includes('R'))),
    };
    // 도착 지점(역·터미널, 공항이 멀면 리무진 도착지)과 귀가 출발 지점
    const arrivePt = tr.out.post ? tr.out.post.to : tr.out.to;
    const leavePt = tr.ret.pre ? tr.ret.pre.from : tr.ret.from;
    const hub = { name: arrivePt.name, lat: arrivePt.lat, lng: arrivePt.lng, type: 'hub' };
    const hubEnd = { name: leavePt.name, lat: leavePt.lat, lng: leavePt.lng, type: 'hub' };
    const base = { name: `${dest.name} 시내 중심`, lat: dest.center.lat, lng: dest.center.lng, type: 'base' };
    const res = {
      dest, origin, people, days, mode: inp.mode, intercity: ic, trip: tr, wins, feasible,
      tight: ctx.tight, exclude: [...exclude], warnings: [], dayPlans: [], spots: [],
      route: { optKm: 0, naiveKm: 0 },
    };
    const roundTrip = (tr.out.fare + tr.out.extraFare + tr.ret.fare + tr.ret.extraFare) * people;
    if (!feasible) {
      res.cost = { roundTrip, local: 0, meals: 0, breakfast: 0, food: 0, fees: 0, cafe: 0, misc: 0, cafeEtc: 0, total: roundTrip };
      return res;
    }

    // 1) 관광지 점수화 & 선정 (필수 장소 우선)
    const spots = dest.attractions
      .filter(a => must.has(a.id) || !exclude.has(a.id))
      .map(a => ({ ...a, must: must.has(a.id), score: must.has(a.id) ? 100 + a.pop : scoreSpot(a, prefs, cats) }))
      .sort((a, b) => b.score - a.score);
    const mealMin = w => (w.start <= 12 * 60 + 30 && w.end >= 13 * 60 + 30 ? LUNCH.dur : 0) + (w.start <= 18 * 60 && w.end >= 19 * 60 ? DINNER.dur : 0);
    const caps = wins.map(w => Math.max(0, w.end - w.start - mealMin(w) - (ctx.wantCafe ? CAFE_DUR : 0) - 30));
    const totalCap = sum(caps);
    const chosen = [];
    let used = 0;
    spots.forEach(s => {
      const c = s.dur + dest.legEst;
      if (s.must || (used + c <= totalCap && chosen.length < days * 6)) { chosen.push(s); used += c; }
    });

    // 2) 일자별 묶기 → 3) 방문 순서 최적화 → 4) 시간표 (넘치면 점수 낮은 곳부터 제외)
    const groups = clusterDays(chosen, caps, dest.legEst, base, hub);
    const usedR = new Set();
    let prevEnd = null;
    groups.forEach((g, i) => {
      // 둘째 날부터는 전날 마지막 장소 인근에서 출발, 마지막 날이 아니면 끝점은 열어 둔다
      const start = i === 0 ? hub : prevEnd || base;
      const end = i === days - 1 ? hubEnd : null;
      let stops = g.slice(), sch, ordered;
      for (let guard = 0; guard < 20; guard++) {
        ordered = orderRoute(start, end, stops, wins[i]);
        sch = schedule(i, ordered, wins[i], start, end, ctx, choices, new Set(usedR));
        if (!sch.overflow) break;
        const removable = stops.filter(s => !s.must);
        if (!removable.length) break;
        const worst = removable.reduce((a, b) => (b.score < a.score ? b : a));
        stops = stops.filter(s => s !== worst);
      }
      sch.items.filter(it => it.kind === 'meal').forEach(it => usedR.add(it.place.id));
      if (sch.overflow) res.warnings.push(`${i + 1}일차는 필수 장소 때문에 일정이 빠듯해요 (종료 예정 ${clock(sch.endTime)}).`);
      const legs = sch.items.filter(it => it.kind === 'leg');
      prevEnd = sch.lastPos && sch.lastPos !== start
        ? { name: `${sch.lastPos.name} 인근`, lat: sch.lastPos.lat, lng: sch.lastPos.lng, type: 'base' }
        : start;
      res.dayPlans.push({
        idx: i, win: wins[i], start, end, stops: ordered, items: sch.items, endTime: sch.endTime,
        km: sum(legs, l => l.km), moveMin: sum(legs, l => l.min), localCost: sum(legs, l => l.cost),
      });
    });

    // 동선 최적화 효과: 인기순 나열 대비 이동거리
    const allStops = res.dayPlans.flatMap(dp => dp.stops);
    const byPop = allStops.slice().sort((a, b) => b.pop - a.pop || b.score - a.score);
    let k = 0;
    res.route = {
      optKm: sum(res.dayPlans, dp => pathKm(dp.start, dp.stops, dp.end)),
      naiveKm: sum(res.dayPlans, dp => { const seg = byPop.slice(k, k + dp.stops.length); k += dp.stops.length; return pathKm(dp.start, seg, dp.end); }),
    };

    // 5) 비용 합산
    const items = res.dayPlans.flatMap(dp => dp.items);
    const pick = kind => items.filter(it => it.kind === kind);
    const c = {
      roundTrip,
      local: sum(pick('leg'), l => l.cost),
      meals: sum(pick('meal'), m => m.cost),
      breakfast: (days - 1) * BREAKFAST * people,
      fees: sum(pick('spot'), s => s.cost),
      cafe: sum(pick('cafe'), s => s.cost),
      misc: MISC * people * days,
    };
    c.food = c.meals + c.breakfast;
    c.cafeEtc = c.cafe + c.misc;
    c.total = c.roundTrip + c.local + c.food + c.fees + c.cafeEtc;
    res.cost = c;
    res.spots = allStops;
    return res;
  }

  // 예산을 넘으면: 저렴한 식당·저비용 이동으로 전환 → 입장료 비싼 장소부터 제외
  function plan(inp) {
    const exclude = new Set(inp.exclude || []);
    let p = build(inp, { exclude, tight: false });
    p.fitted = false;
    p.budgetExcluded = [];
    if (!inp.fit || !p.feasible || p.cost.total <= inp.budget) return finish(p, inp);

    p = build(inp, { exclude, tight: true });
    const removed = [];
    for (let guard = 0; guard < 40 && p.cost.total > inp.budget; guard++) {
      const cand = p.spots.filter(s => !s.must);
      if (cand.length <= inp.days) break;
      const victim = cand.reduce((a, b) => {
        const ka = a.fee * inp.people - a.score * 300, kb = b.fee * inp.people - b.score * 300;
        return kb > ka ? b : a;
      });
      exclude.add(victim.id);
      removed.push(victim);
      p = build(inp, { exclude, tight: true });
    }
    p.fitted = true;
    p.budgetExcluded = removed.filter(r => !p.spots.some(s => s.id === r.id));
    return finish(p, inp);
  }

  function finish(p, inp) {
    p.budget = inp.budget;
    p.left = inp.budget - p.cost.total;
    p.budgetOk = p.left >= 0;
    return p;
  }

  // 식당·카페 변경 시: 같은 관광지 구성으로 다시 계산
  function rebuild(inp, prev) {
    const p = build(inp, { exclude: new Set(prev.exclude), tight: prev.tight });
    p.fitted = prev.fitted;
    p.budgetExcluded = prev.budgetExcluded;
    return finish(p, inp);
  }

  // 예산 기반 후보 판정
  function estimate(dest, base) {
    const p = plan({ ...base, dest, prefs: {}, cats: [], must: [], choices: {}, fit: true });
    let status;
    if (!p.feasible || !p.spots.length) status = 'far';
    else if (!p.fitted) status = 'ok';
    else status = p.budgetOk ? 'tight' : 'over';
    return { dest, plan: p, status, total: p.cost.total };
  }

  function clock(m) {
    m = Math.round(m);
    return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
  }

  const Planner = {
    prepare, trip, longLeg, availableModes, defaultMode, station, estimateFare, MODE_INFO, leg, legOptions, plan, rebuild, estimate, prune, questionScore, scoreSpot, dayWindows,
    hav, clock, hm, QUESTIONS, CATEGORIES, MODES, LEG_KIND, TAG_LABEL, answered,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
  else root.Planner = Planner;
})(typeof window !== 'undefined' ? window : globalThis);
