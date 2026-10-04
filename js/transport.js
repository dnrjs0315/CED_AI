/*
 * 장거리 교통편 시간표
 *  - server.py가 실행 중이고 공공데이터포털(TAGO) 키가 설정되어 있으면 실시간 시간표·요금을 조회
 *    → 코레일 열차번호·출발역, 티머니(고속·시외버스) 출발 터미널·시각이 예매 사이트와 그대로 일치
 *  - 그렇지 않으면 노선 거리 기반의 '예시 시간표'를 생성 (같은 노선·날짜는 항상 같은 결과)
 *    예시는 실제 운행 편이 아니므로 열차번호·편명을 붙이지 않는다
 *  - 예매는 코레일 / 고속·시외버스 티머니 / 스카이스캐너로 연결
 */
(function (root) {
  'use strict';

  const P = root.Planner;
  const r100 = x => Math.round(x / 100) * 100;

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let s = seed || 1;
    return () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 예시 시간표 ----------
  const RAIL = { KTX: [1, 1], 'ITX-새마을': [0.68, 1.45], 무궁화호: [0.47, 1.7], 'ITX-청춘': [0.62, 1.9] };
  const BUS = { 일반: 0.68, 우등: 1, 프리미엄: 1.3 };
  const AIRLINES = [
    ['대한항공', 'KE', 1.3], ['아시아나항공', 'OZ', 1.25], ['제주항공', '7C', 1], ['진에어', 'LJ', 1],
    ['티웨이항공', 'TW', 0.95], ['에어부산', 'BX', 0.95], ['이스타항공', 'ZE', 0.9], ['에어서울', 'RS', 0.9],
  ];

  function mockSchedule(mode, from, to, date) {
    const km = P.hav(from, to);
    const base = P.estimateFare(mode, km);
    const R = rng(hash([mode, from.name, to.name, date].join('|')));
    const list = [];
    if (mode === 'rail') {
      const itxOnly = /춘천/.test(from.name + to.name);
      const pure = base.min - 25;
      let t = 5 * 60 + 15 + Math.floor(R() * 30);
      while (t < 21 * 60 + 40) {
        const g = itxOnly ? 'ITX-청춘' : R() < 0.55 ? 'KTX' : R() < 0.55 ? 'ITX-새마을' : '무궁화호';
        const [f, s] = RAIL[g];
        const min = Math.round(pure * s + R() * 12);
        list.push({ mode, grade: g, name: `${g} (예시)`, dep: t, arr: t + min, fare: r100(base.fare * f) });
        t += 35 + Math.floor(R() * 55);
      }
    } else if (mode === 'bus') {
      const pure = base.min - 20;
      let t = 6 * 60 + Math.floor(R() * 30);
      while (t < 23 * 60) {
        const r = R();
        const g = r < 0.3 ? '일반' : r < 0.8 ? '우등' : '프리미엄';
        const min = Math.round(pure + R() * 20);
        list.push({ mode, grade: g, name: `고속버스 ${g} (예시)`, dep: t, arr: t + min, fare: r100(base.fare * BUS[g]) });
        t += 25 + Math.floor(R() * 50);
      }
    } else if (mode === 'air') {
      const busy = /GMP/.test(from.iata + to.iata) && /CJU/.test(from.iata + to.iata);
      const cju = /CJU/.test(from.iata + to.iata);
      const step = busy ? [20, 30] : cju ? [80, 120] : [150, 180];
      let t = 6 * 60 + 30 + Math.floor(R() * 40);
      while (t < 21 * 60) {
        const [airline, , af] = AIRLINES[Math.floor(R() * (cju ? AIRLINES.length : 4))];
        const peak = (t >= 7 * 60 && t < 9 * 60 + 30) || (t >= 17 * 60 && t < 19 * 60 + 30) ? 1.35 : 1;
        const min = base.flightMin + Math.floor(R() * 8);
        list.push({
          mode, grade: airline, name: `${airline} (예시)`,
          dep: t, arr: t + min, fare: r100((38000 + 50 * km) * af * peak * (0.7 + R() * 0.55)),
        });
        t += step[0] + Math.floor(R() * step[1]);
      }
    }
    return list;
  }

  // ---------- 실시간 조회 (server.py → 공공데이터포털 TAGO) ----------
  let statusPromise = null;
  function status() {
    if (!statusPromise) {
      statusPromise = location.protocol === 'file:'
        ? Promise.resolve({ server: false, live: false })
        : fetch('/api/status').then(r => r.json()).then(j => ({ server: true, live: !!j.live })).catch(() => ({ server: false, live: false }));
    }
    return statusPromise;
  }

  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

  // TAGO 역·터미널 이름 → 지도 좌표가 있는 지점 (대표 거점이 아니면 STOPS에서 찾는다)
  function stopPoint(mode, tagoName, def) {
    if (!tagoName || !def.tago || tagoName === [].concat(def.tago)[0]) return def;
    const s = ((root.TRAVEL_DATA.STOPS || {})[mode] || {})[tagoName];
    if (s) return { name: s[0], lat: s[1], lng: s[2] };
    return { name: mode === 'rail' ? `${tagoName}역` : tagoName, lat: def.lat, lng: def.lng };
  }

  async function liveSchedule(mode, from, to, date) {
    const q = new URLSearchParams({ mode, date: date.replace(/-/g, '') });
    if (mode === 'rail' || mode === 'bus') { q.set('from', [].concat(from.tago).join('|')); q.set('to', [].concat(to.tago).join('|')); }
    if (mode === 'air') { q.set('from', from.icao); q.set('to', to.icao); }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`/api/schedules?${q}`, { signal: ctrl.signal });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '조회 실패');
      // 요금·도착 시각이 비어 있는 편도 실제로 운행하므로 빼지 않고 거리 기반 예상치로 채움
      const est = P.estimateFare(mode, P.hav(from, to));
      const estFare = est.fare;
      return j.items.map(it => {
        const dep = toMin(it.dep);
        let arr = it.arr ? toMin(it.arr) : dep + (mode === 'air' ? est.flightMin : est.min);
        if (arr < dep) arr += 24 * 60;
        return {
          mode, grade: it.grade, name: it.name, dep, arr,
          fare: it.fare > 0 ? it.fare : estFare, fareEst: !(it.fare > 0), arrEst: !it.arr,
          from: stopPoint(mode, it.depSt, from), to: stopPoint(mode, it.arrSt, to),
        };
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const cache = new Map();
  // 반환: { source: 'live' | 'mock', items, note }
  async function schedules(mode, fromCity, toCity, date) {
    const from = P.station(fromCity, mode), to = P.station(toCity, mode);
    const key = [mode, from.name, to.name, date].join('|');
    if (cache.has(key)) return cache.get(key);
    const st = await status();
    const MOCK = '실제 운행 편이 아니라서 코레일·티머니GO의 시각·열차번호와 맞지 않아요';
    let out;
    if (st.live) {
      try {
        const items = await liveSchedule(mode, from, to, date);
        out = items.length
          ? { source: 'live', items, note: `국토교통부 TAGO 실시간 시간표 — ${{ rail: '코레일과 같은 열차번호로', bus: '티머니와 같은 출발 터미널·시각으로', air: '항공사 편명으로' }[mode]} 표시돼요` }
          : { source: 'mock', items: mockSchedule(mode, from, to, date), note: `실시간 조회 결과가 없어요 (직통편이 없거나 아직 판매 전일 수 있어요). 아래는 예시 시간표로, ${MOCK}` };
      } catch (e) {
        out = { source: 'mock', items: mockSchedule(mode, from, to, date), note: `실시간 조회 실패 (${e.message}). 아래는 예시 시간표로, ${MOCK}` };
      }
    } else {
      out = {
        source: 'mock', items: mockSchedule(mode, from, to, date),
        note: `예시 시간표예요. ${MOCK}`,
      };
    }
    out.items = out.items
      .map(it => {
        const f = it.from || from, t = it.to || to;
        return { ...it, id: `${mode}-${it.dep}-${it.name}-${f.name}`, from: f, to: t };
      })
      .sort((a, b) => a.dep - b.dep);
    cache.set(key, out);
    return out;
  }

  // ---------- 예매 링크 ----------
  const yymmdd = d => d.replace(/-/g, '').slice(2);
  function bookingLinks(mode, fromCity, toCity, date, retDate, people) {
    if (mode === 'rail') return [{ label: '코레일 예매', url: 'https://www.letskorail.com/' }];
    if (mode === 'bus') {
      return [
        { label: '고속버스 티머니 예매', url: 'https://www.kobus.co.kr/main.do' },
        { label: '시외버스 티머니 예매', url: 'https://txbus.t-money.co.kr/' },
      ];
    }
    if (mode === 'air') {
      const a = P.station(fromCity, 'air'), b = P.station(toCity, 'air');
      const path = `${a.iata.toLowerCase()}/${b.iata.toLowerCase()}/${yymmdd(date)}/${retDate ? `${yymmdd(retDate)}/` : ''}`;
      return [
        { label: '스카이스캐너에서 비교·예매', url: `https://www.skyscanner.co.kr/transport/flights/${path}?adultsv2=${people}&cabinclass=economy` },
      ];
    }
    return [];
  }

  root.Transport = { schedules, status, bookingLinks, mockSchedule };
})(window);
