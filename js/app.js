/* 갈래말래 — 화면 흐름 (예산 → 출발지 → 이동 방식 → 후보 → 가지치기 → 여행지 → 날짜 → 교통편 → 카테고리 → 필수 장소 → 생성 → 결과) */
(function () {
  'use strict';

  const P = window.Planner;
  const T = window.Transport;
  const { ORIGINS, DESTINATIONS, STATIONS, AIR_ROUTES } = window.TRAVEL_DATA;
  P.prepare(DESTINATIONS, STATIONS, AIR_ROUTES);
  const KAKAO_KEY = ((window.APP_CONFIG || {}).KAKAO_JS_KEY || '').trim();

  const appEl = document.getElementById('app');
  const stepperEl = document.getElementById('stepper');
  const summaryEl = document.getElementById('summary');
  const layoutEl = document.getElementById('layout');

  // ---------- 포맷 ----------
  const won = n => `${n < 0 ? '-' : ''}${Math.abs(Math.round(n)).toLocaleString('ko-KR')}원`;
  const man = n => (n >= 10000 && n % 10000 === 0 ? `${(n / 10000).toLocaleString()}만원` : won(n));
  const dur = m => {
    m = Math.round(m);
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}시간${mm ? ` ${mm}분` : ''}` : `${mm}분`;
  };
  const km = k => (k < 1 ? `${Math.round(k * 1000)}m` : `${k.toFixed(1)}km`);
  const clock = P.clock;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY_COLORS = ['#0f766e', '#c2410c', '#7c3aed', '#be185d'];
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const DAYS_OPT = [
    { v: 1, label: '당일치기' },
    { v: 2, label: '1박 2일' },
    { v: 3, label: '2박 3일' },
  ];

  const STEPS = [
    { key: 'budget', label: '예산' },
    { key: 'origin', label: '출발지' },
    { key: 'mode', label: '이동 방식' },
    { key: 'cands', label: '후보 생성' },
    { key: 'prefs', label: '취향 가지치기' },
    { key: 'dest', label: '여행지 선택' },
    { key: 'time', label: '날짜·시간' },
    { key: 'ticket', label: '교통편' },
    { key: 'cats', label: '카테고리' },
    { key: 'must', label: '필수 장소' },
    { key: 'generate', label: '일정 생성' },
    { key: 'result', label: '최종 일정' },
  ];
  const ST = Object.fromEntries(STEPS.map((s, i) => [s.key, i]));

  const addDays = (date, n) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const legTotal = l => l.preMin + l.min + l.postMin;

  function nextWeekend() {
    const d = new Date();
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const S = {
    step: 0, maxStep: 0,
    budget: 150000, people: 2, days: 1, reserve: 0,
    origin: null, intercity: 'cheap', mode: null,
    candKey: '', cands: [],
    prefs: { nature: null, food: null, themes: [], hidden: null }, qi: 0, themesDraft: [],
    destId: null,
    date: nextWeekend(), dayStart: '09:00', dayEnd: '21:00',
    tickets: {}, tMode: {}, tSort: 'dep', sched: {}, ticketKey: '',
    cats: [], must: [], mustQuery: '',
    plan: null, choices: {}, activeDay: 0, showOver: false,
  };

  // 출발지·여행지·날짜·기간이 바뀌면 고른 교통편은 무효
  function syncTickets() {
    const k = [S.origin, S.destId, S.date, S.days].join('|');
    if (k !== S.ticketKey) { S.ticketKey = k; S.tickets = {}; S.tMode = {}; }
  }

  // ---------- 파생 값 ----------
  const origin = () => ORIGINS.find(o => o.id === S.origin);
  const dest = () => DESTINATIONS.find(d => d.id === S.destId);
  const effBudget = () => Math.max(0, S.budget - S.reserve);

  function baseInput() {
    return {
      origin: origin(), people: S.people, days: S.days, mode: S.mode, intercity: S.intercity,
      dayStart: S.dayStart, dayEnd: S.dayEnd, budget: effBudget(),
    };
  }
  // 여행지가 정해진 뒤의 입력 (고른 교통편 포함)
  const winInput = () => ({ ...baseInput(), dest: dest(), tickets: S.tickets });
  function fullInput() {
    return { ...winInput(), prefs: S.prefs, cats: S.cats, must: S.must, choices: S.choices, fit: true };
  }

  // 예산·출발지·기간·이동방식이 바뀔 때만 후보를 다시 계산
  function ensureCands() {
    const key = JSON.stringify([S.budget, S.reserve, S.people, S.days, S.origin, S.intercity, S.mode, S.dayStart, S.dayEnd]);
    if (key === S.candKey) return;
    S.candKey = key;
    const base = baseInput();
    S.cands = DESTINATIONS.map(d => (d.name === base.origin.name
      ? { dest: d, status: 'same', total: 0 }
      : P.estimate(d, base)));
    const order = { ok: 0, tight: 1, over: 2, far: 3, same: 4 };
    S.cands.sort((a, b) => order[a.status] - order[b.status] || a.total - b.total);
  }
  const available = () => S.cands.filter(c => c.status === 'ok' || c.status === 'tight');
  const pruning = () => P.prune(available(), S.prefs);

  // ---------- 네비게이션 ----------
  function go(step) {
    S.step = Math.max(0, Math.min(STEPS.length - 1, step));
    S.maxStep = Math.max(S.maxStep, S.step);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // 앞 단계를 바꾸면 이후 단계로 건너뛰지 못하도록 진행 범위를 되돌림
  function invalidateFrom(step) { S.maxStep = Math.min(S.maxStep, step); S.plan = null; }

  // ---------- 공통 조각 ----------
  function head(no, title, desc) {
    return `<div class="step-head"><span class="step-no">STEP ${no}</span><h2>${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>`;
  }
  function footer({ back = true, nextLabel = '다음', nextDisabled = false, hint = '' } = {}) {
    return `<div class="step-foot">
      ${back ? '<button class="btn ghost" data-act="back">← 이전</button>' : '<span></span>'}
      <div class="foot-right">${hint ? `<span class="hint">${hint}</span>` : ''}
        <button class="btn primary" data-act="next" ${nextDisabled ? 'disabled' : ''}>${nextLabel} →</button></div>
    </div>`;
  }
  const tagChips = tags => tags.filter(t => P.TAG_LABEL[t]).map(t => `<span class="tag t-${t}">${P.TAG_LABEL[t]}</span>`).join('');

  // ---------- STEP 1 예산 ----------
  function viewBudget() {
    return `${head(1, '여행 예산을 먼저 알려주세요', '보유한 예산 안에서 실제로 갈 수 있는 여행지만 골라 드려요. 왕복 교통비·현지 교통비·식비·입장료까지 모두 포함해서 계산합니다.')}
    <div class="field">
      <label for="budget">총 여행 예산 <small>(인원 전체 합계)</small></label>
      <div class="money-input"><input id="budget" inputmode="numeric" autocomplete="off" value="${S.budget.toLocaleString()}"><em>원</em></div>
      <div class="chips">${[50000, 100000, 150000, 200000, 300000, 500000].map(v =>
        `<button class="chip ${S.budget === v ? 'on' : ''}" data-act="budget" data-v="${v}">${man(v)}</button>`).join('')}</div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>인원</label>
        <div class="stepper-input">
          <button class="btn icon" data-act="people" data-v="-1" aria-label="인원 줄이기">−</button>
          <b>${S.people}명</b>
          <button class="btn icon" data-act="people" data-v="1" aria-label="인원 늘리기">+</button>
        </div>
      </div>
      <div class="field">
        <label>여행 기간</label>
        <div class="seg">${DAYS_OPT.map(o => `<button class="${S.days === o.v ? 'on' : ''}" data-act="days" data-v="${o.v}">${o.label}</button>`).join('')}</div>
      </div>
    </div>
    <details class="field reserve" ${S.reserve ? 'open' : ''}>
      <summary>예산에서 미리 빼둘 금액이 있나요? <small>(숙박비 등 · 선택)</small></summary>
      <p class="muted">숙소 추천 기능은 제공하지 않아요. 숙박이 필요하다면 그 금액만큼 빼고 계산할게요.</p>
      <div class="money-input small"><input id="reserve" inputmode="numeric" autocomplete="off" value="${S.reserve ? S.reserve.toLocaleString() : ''}" placeholder="0"><em>원</em></div>
    </details>
    <div class="callout">
      <b>일정에 쓸 수 있는 예산</b>
      <span id="eff" class="big">${won(effBudget())}</span>
      <small>1인당 약 ${won(effBudget() / S.people)}</small>
    </div>
    ${footer({ back: false, nextDisabled: effBudget() < 10000, hint: effBudget() < 10000 ? '최소 1만원 이상 입력해 주세요' : '' })}`;
  }

  // ---------- STEP 2 출발지 ----------
  function viewOrigin() {
    return `${head(2, '어디에서 출발하나요?', '출발지에 따라 왕복 교통비와 이동 시간이 달라져요.')}
    <div class="grid-cities">${ORIGINS.map(o => {
      // 기차역·버스터미널이 모두 있으면 둘 다, 없으면 있는 거점만 (제주는 공항)
      const st = ['rail', 'bus', 'air'].map(m => [m, P.station(o, m)]).filter(([, s]) => s);
      const shown = st.filter(([m]) => m !== 'air');
      return `<button class="city ${S.origin === o.id ? 'on' : ''}" data-act="origin" data-v="${o.id}">
        <b>${o.name}</b>
        ${(shown.length ? shown : st).map(([m, s]) => `<small>${P.MODE_INFO[m].icon} ${esc(s.name)}</small>`).join('')}
      </button>`;
    }).join('')}</div>
    <div class="field">
      <label>왕복 교통편</label>
      <div class="seg wide">
        <button class="${S.intercity === 'cheap' ? 'on' : ''}" data-act="intercity" data-v="cheap">💰 최대한 저렴하게 <small>고속·시외버스</small></button>
        <button class="${S.intercity === 'fast' ? 'on' : ''}" data-act="intercity" data-v="fast">🚄 빠르게 <small>KTX·ITX (가능한 구간)</small></button>
      </div>
      <p class="muted">제주는 항공, 근거리(인천 등)는 광역버스·전철로 계산해요. 여행지를 고른 뒤 실제 기차·버스·항공 시간표에서 편을 직접 고를 수 있어요.</p>
    </div>
    ${footer({ nextDisabled: !S.origin, hint: S.origin ? '' : '출발지를 선택해 주세요' })}`;
  }

  // ---------- STEP 3 현지 이동 방식 ----------
  function viewMode() {
    const sample = DESTINATIONS.find(d => d.id === 'jeonju');
    const ex = [1.2, 4, 12];
    return `${head(3, '여행지에서는 어떻게 움직일까요?', '선택한 방식에 따라 현지 교통비와 이동 시간을 구간마다 다르게 계산해요. 현지 교통비는 전체 예산에 반드시 포함됩니다.')}
    <div class="grid-modes">${Object.entries(P.MODES).map(([k, m]) => `
      <button class="mode ${S.mode === k ? 'on' : ''}" data-act="mode" data-v="${k}">
        <span class="mode-icon">${m.icon}</span>
        <b>${m.label}</b>
        <small>${m.desc}</small>
        <table class="mini">${ex.map(e => {
          const l = legPreview(sample, e, k);
          return `<tr><td>${e}km</td><td>${P.LEG_KIND[l.kind].icon} ${dur(l.min)}</td><td>${l.cost ? won(l.cost) : '무료'}</td></tr>`;
        }).join('')}</table>
      </button>`).join('')}</div>
    <p class="muted">표는 ${S.people}명 기준 예시 구간(도심형 여행지)이에요. ‘알아서 최적화’는 인원이 많을수록 택시를, 예산이 빠듯할수록 대중교통을 더 고릅니다.</p>
    ${footer({ nextLabel: '갈 수 있는 여행지 찾기', nextDisabled: !S.mode, hint: S.mode ? '' : '이동 방식을 선택해 주세요' })}`;
  }
  function legPreview(d, distKm, mode) {
    const a = { lat: 35.8, lng: 127.1 };
    const b = { lat: 35.8 + distKm / 1.3 / 111.2, lng: 127.1 };
    return P.leg(a, b, { dest: d, people: S.people, mode, vot: 150 });
  }

  // ---------- STEP 4 예산 기반 후보 ----------
  function viewCands() {
    ensureCands();
    const ok = available();
    const out = S.cands.filter(c => c.status === 'over' || c.status === 'far');
    const B = effBudget();
    const card = c => {
      const p = c.plan, pc = p.cost;
      const pct = Math.min(100, (c.total / B) * 100);
      return `<div class="cand ${c.status}">
        <div class="cand-top"><span class="emoji">${c.dest.emoji}</span>
          <div><b>${c.dest.name}</b><small>${c.dest.region} · ${p.trip.out.icon} ${p.trip.out.label} 편도 ${dur(legTotal(p.trip.out))}</small></div>
          <span class="badge ${c.status}">${c.status === 'ok' ? '예산 내 가능' : '알뜰 코스로 가능'}</span></div>
        <p class="cand-desc">${c.dest.desc}</p>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="cand-cost"><b>${won(c.total)}</b><span>잔여 ${won(B - c.total)}</span></div>
        <div class="cand-break">왕복 ${won(pc.roundTrip)} · 현지 교통 ${won(pc.local)} · 식비 ${won(pc.food)} · 입장료 ${won(pc.fees)}</div>
      </div>`;
    };
    const outRow = c => {
      if (c.status === 'far') return `<li><span>${c.dest.emoji} ${c.dest.name}</span><em>이동 시간 부족 · 편도 ${dur(legTotal(c.plan.trip.out))} (현지 체류가 너무 짧아요)</em></li>`;
      return `<li><span>${c.dest.emoji} ${c.dest.name}</span><em>최소 ${won(c.total)} · <b>${won(c.total - B)} 초과</b></em></li>`;
    };
    return `${head(4, `${won(B)}으로 갈 수 있는 여행지`, `${origin().name} 출발 · ${S.people}명 · ${DAYS_OPT[S.days - 1].label} · ${P.MODES[S.mode].icon} ${P.MODES[S.mode].label} 기준으로 전체 비용을 계산해 예산을 넘는 곳은 먼저 제외했어요.`)}
    <div class="stat-row">
      <div><b>${DESTINATIONS.length - 1}</b><small>전체 여행지</small></div>
      <div class="accent"><b>${ok.length}</b><small>예산 내 가능</small></div>
      <div><b>${out.length}</b><small>제외됨</small></div>
    </div>
    ${ok.length ? `<div class="grid-cands">${ok.map(card).join('')}</div>` : `<div class="empty">😢 현재 조건으로는 갈 수 있는 여행지가 없어요.<br>예산을 늘리거나, 기간·왕복 교통편·이동 방식을 바꿔 보세요.</div>`}
    ${out.length ? `<details class="excluded" ${S.showOver ? 'open' : ''}><summary data-act="toggleOver">예산·시간 때문에 제외된 여행지 ${out.length}곳</summary><ul>${out.map(outRow).join('')}</ul></details>` : ''}
    <p class="muted">‘알뜰 코스로 가능’은 저렴한 식당과 저비용 이동을 고르고 입장료가 비싼 곳을 줄이면 예산 안에 들어오는 여행지예요.</p>
    ${footer({ nextLabel: '취향으로 좁히기', nextDisabled: !ok.length })}`;
  }

  // ---------- STEP 5 선호도 가지치기 ----------
  function viewPrefs() {
    ensureCands();
    const { alive, pruned } = pruning();
    const qs = P.QUESTIONS;
    const done = S.qi >= qs.length;
    const q = qs[S.qi];
    const treeRow = available().map(c => {
      const pr = pruned[c.dest.id];
      return `<span class="leaf ${pr ? 'cut' : ''}" title="${pr ? esc(`${pr.q}: ${pr.reason}`) : '남아 있음'}">${c.dest.emoji} ${c.dest.name}${pr ? `<small>${pr.q}</small>` : ''}</span>`;
    }).join('');
    let body;
    if (done) {
      body = `<div class="q-done"><span class="big-emoji">🌳</span>
        <h3>가지치기 완료! ${alive.length}곳이 남았어요</h3>
        <p class="muted">다음 단계에서 취향 일치도와 예상 비용을 비교해 최종 여행지를 골라 주세요.</p>
        <button class="btn ghost" data-act="qreset">↺ 취향 다시 고르기</button></div>`;
    } else if (q.multi) {
      body = `<div class="q-card"><div class="q-meta">질문 ${S.qi + 1} / ${qs.length}</div><h3>${q.title}</h3>
        <div class="q-options four">${q.options.map(o => `
          <button class="q-opt ${S.themesDraft.includes(o.v) ? 'on' : ''}" data-act="qtheme" data-v="${o.v}">
            <span>${o.icon}</span><b>${o.label}</b><small>${o.desc}</small></button>`).join('')}</div>
        <div class="q-actions"><button class="btn ghost" data-act="qany">상관없어요</button>
          <button class="btn primary" data-act="qthemeDone" ${S.themesDraft.length ? '' : 'disabled'}>선택 완료</button></div></div>`;
    } else {
      body = `<div class="q-card"><div class="q-meta">질문 ${S.qi + 1} / ${qs.length}</div><h3>${q.title}</h3>
        <div class="q-options">${q.options.map(o => `
          <button class="q-opt ${S.prefs[q.key] === o.v ? 'on' : ''}" data-act="qans" data-v="${o.v}">
            <span>${o.icon}</span><b>${o.label}</b><small>${o.desc}</small></button>`).join('')}</div>
        <div class="q-actions"><button class="btn ghost" data-act="qany">상관없어요</button></div></div>`;
    }
    return `${head(5, '취향으로 여행지를 가지치기해요', '몇 가지만 고르면 성향에 맞지 않는 여행지를 잘라내고, 이후 관광지 추천에도 반영해요.')}
    <div class="q-progress">${qs.map((x, i) => `<button class="${i < S.qi ? 'done' : i === S.qi ? 'cur' : ''}" data-act="qgoto" data-v="${i}">${i + 1}. ${x.short}${answerLabel(x)}</button>`).join('')}</div>
    ${body}
    <div class="tree"><div class="tree-title">후보 여행지 <b>${alive.length}</b> / ${available().length}</div><div class="leaves">${treeRow}</div></div>
    ${footer({ nextLabel: done ? '최종 여행지 고르기' : '건너뛰고 여행지 고르기' })}`;
  }
  function answerLabel(q) {
    const v = S.prefs[q.key];
    if (!P.answered(v)) return v === 'any' ? ' · 상관없음' : '';
    const lab = x => q.options.find(o => o.v === x).label;
    return ` · ${Array.isArray(v) ? v.map(lab).join('/') : lab(v)}`;
  }

  // ---------- STEP 6 최종 여행지 ----------
  function viewDest() {
    ensureCands();
    const { alive, match } = pruning();
    const B = effBudget();
    const list = alive.slice().sort((a, b) => (match(b.dest.id) || 0) - (match(a.dest.id) || 0) || a.total - b.total);
    return `${head(6, '어디로 떠날까요?', '예산과 취향으로 추려낸 여행지예요. 취향 일치도가 높은 순서로 보여 드려요.')}
    <div class="grid-dest">${list.map(c => {
      const m = match(c.dest.id);
      const top = c.dest.attractions.slice().sort((a, b) => P.scoreSpot(b, S.prefs, []) - P.scoreSpot(a, S.prefs, [])).slice(0, 3);
      return `<button class="dest ${S.destId === c.dest.id ? 'on' : ''}" data-act="dest" data-v="${c.dest.id}">
        <div class="dest-top"><span class="emoji">${c.dest.emoji}</span><div><b>${c.dest.name}</b><small>${c.dest.region}</small></div>
          ${m != null ? `<span class="match"><b>${m}%</b><small>취향 일치</small></span>` : ''}</div>
        <p>${c.dest.desc}</p>
        <div class="dest-spots">${top.map(a => `<span>${esc(a.name)}</span>`).join('')}</div>
        <div class="dest-cost"><span>예상 ${won(c.total)}</span><span class="${B - c.total >= 0 ? 'pos' : 'neg'}">잔여 ${won(B - c.total)}</span></div>
        ${c.status === 'tight' ? '<span class="badge tight">알뜰 코스</span>' : ''}
      </button>`;
    }).join('')}</div>
    ${footer({ nextDisabled: !S.destId, hint: S.destId ? '' : '여행지를 선택해 주세요' })}`;
  }

  // ---------- STEP 7 날짜·시간 ----------
  function dayLabel(i) {
    if (!S.date) return `${i + 1}일차`;
    const d = new Date(`${S.date}T00:00:00`);
    d.setDate(d.getDate() + i);
    return `${i + 1}일차 · ${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
  }
  function windowCards(wins, tr) {
    const { out, ret } = tr;
    return `<div class="windows">${wins.map((w, i) => {
      const len = w.end - w.start;
      const first = out.ticket
        ? `${out.icon} ${clock(out.arr)} ${esc(out.to.name)} 도착 후 시작`
        : `${out.icon} ${origin().name} → ${esc(out.to.name)} 약 ${dur(legTotal(out))} 후 시작`;
      const last = ret.ticket
        ? ` · ${ret.icon} ${clock(ret.dep)} 귀가편 전 종료`
        : ` · 귀가 이동 약 ${dur(legTotal(ret))} 전 종료`;
      return `<div class="win ${len < 150 ? 'bad' : ''}">
        <b>${dayLabel(i)}</b>
        <span>${clock(w.start)} ~ ${clock(w.end)}</span>
        <small>${i === 0 ? first : '전날 마무리한 곳 인근에서 출발'}${i === wins.length - 1 ? last : ''}</small>
        <em>현지 일정 ${dur(Math.max(0, len))}</em>
      </div>`;
    }).join('')}</div>`;
  }
  const windowsBad = wins => wins.some(w => w.end - w.start < 150);

  function viewTime() {
    const tr = P.trip(winInput());
    const wins = P.dayWindows(winInput(), tr);
    const bad = windowsBad(wins);
    return `${head(7, '언제, 몇 시부터 몇 시까지 움직일까요?', '첫날은 도착 후부터, 마지막 날은 귀가 교통편 시간을 빼고 일정을 짜요. 다음 단계에서 실제 시간표를 고르면 더 정확해져요.')}
    <div class="grid-3">
      <div class="field"><label for="date">출발 날짜</label><input type="date" id="date" value="${S.date}"></div>
      <div class="field"><label for="dayStart">하루 시작 (집에서 출발)</label><input type="time" id="dayStart" value="${S.dayStart}" step="1800"></div>
      <div class="field"><label for="dayEnd">하루 종료 (집 도착)</label><input type="time" id="dayEnd" value="${S.dayEnd}" step="1800"></div>
    </div>
    ${windowCards(wins, tr)}
    ${bad ? '<div class="warn">현지에 머무는 시간이 너무 짧은 날이 있어요. 시작을 앞당기거나 종료를 늦춰 주세요.</div>' : ''}
    ${footer({ nextLabel: '교통편 고르기', nextDisabled: bad })}`;
  }

  // ---------- STEP 8 교통편 (기차·버스·항공 시간표) ----------
  function viewTicket() {
    const o = origin(), d = dest();
    const modes = P.availableModes(o, d);
    const tr = P.trip(winInput());
    const wins = P.dayWindows(winInput(), tr);
    const bad = windowsBad(wins);
    const est = P.trip({ ...winInput(), tickets: {} });
    const perPerson = l => l.fare + l.extraFare;
    const total = (perPerson(tr.out) + perPerson(tr.ret)) * S.people;
    const estTotal = (perPerson(est.out) + perPerson(est.ret)) * S.people;
    const picked = (S.tickets.out ? 1 : 0) + (S.tickets.ret ? 1 : 0);
    const body = modes[0] === 'metro'
      ? `<div class="empty">🚇 ${o.name} ↔ ${d.name}은 가까운 거리라 광역버스·전철로 이동해요. 따로 예약할 필요가 없어요.<br><small>편도 약 ${dur(tr.out.min)} · 1인 ${won(tr.out.fare)}</small></div>`
      : `<div class="tk-sort">정렬 ${[['dep', '출발 시각순'], ['fare', '최저가순'], ['time', '최단 시간순']].map(([v, l]) =>
        `<button class="chip ${S.tSort === v ? 'on' : ''}" data-act="tsort" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="tk-panels">${ticketPanel('out', S.date, modes)}${ticketPanel('ret', addDays(S.date, S.days - 1), modes)}</div>`;
    return `${head(8, '가는 편 · 오는 편을 골라 주세요', '시간표에서 고른 편의 출발·도착 시각과 요금이 일정과 예산에 그대로 반영돼요. 고르지 않으면 예상치로 계산합니다.')}
    <div id="tkStatus" class="tk-status">${statusBadge()}</div>
    ${body}
    <div class="tk-summary">
      <div><small>왕복 교통비 (${S.people}명)</small><b>${won(total)}</b>
        <em>${picked ? `예상치 ${won(estTotal)} 대비 ${total >= estTotal ? '+' : ''}${won(total - estTotal)}` : '아직 예상치예요'}</em></div>
      ${windowCards(wins, tr)}
    </div>
    ${bad ? '<div class="warn">고른 편으로는 현지에 머무는 시간이 2시간 30분도 안 돼요. 더 이른 가는 편이나 더 늦은 오는 편을 골라 주세요.</div>' : ''}
    ${footer({ nextLabel: picked === 2 || modes[0] === 'metro' ? '다음' : '예상치로 계속', nextDisabled: bad })}`;
  }

  function statusBadge() {
    const st = S.tStatus;
    if (!st) return '<span class="pill">시간표 연결 확인 중…</span>';
    if (st.live) return '<span class="pill live">● 실시간 시간표 · 국토교통부 TAGO(공공데이터포털)</span><small>코레일·티머니GO에서 같은 열차번호·출발 시각의 편을 고르면 돼요.</small>';
    return `<span class="pill">예시 시간표</span><small>지금 보이는 시각·편은 실제 코레일·티머니GO 시간표와 맞지 않아요. ${st.server
      ? 'server_config.json에 공공데이터포털 인증키를 넣고 서버를 다시 켜면 실제 열차번호·시간표·요금으로 바뀌어요.'
      : '실행.bat(server.py)로 열고 공공데이터포털 인증키를 설정하면 실제 열차번호·시간표·요금으로 바뀌어요.'}</small>`;
  }

  function ticketPanel(dir, date, modes) {
    const o = origin(), d = dest();
    const [A, B] = dir === 'out' ? [o, d] : [d, o];
    const chosen = S.tickets[dir];
    const mode = S.tMode[dir] || (chosen && chosen.mode) || P.defaultMode(o, d, S.intercity);
    const legInfo = P.longLeg(dir, o, d, mode, null);
    const key = [mode, A.id, B.id, date].join('|');
    let sc = S.sched[key];
    if (!sc) {
      sc = S.sched[key] = { loading: true };
      T.schedules(mode, A, B, date).then(r => {
        S.sched[key] = r;
        if (S.step === ST.ticket) rerenderKeepScroll();
      });
    }
    const [y, m, dd] = date.split('-').map(Number);
    const wd = WEEK[new Date(y, m - 1, dd).getDay()];
    const tabs = modes.map(md => `<button class="${md === mode ? 'on' : ''}" data-act="tmode" data-dir="${dir}" data-v="${md}">${P.MODE_INFO[md].icon} ${P.MODE_INFO[md].label}</button>`).join('');
    const extra = [legInfo.pre, legInfo.post].filter(Boolean)
      .map(x => `🚌 ${esc(x.from.name)} → ${esc(x.to.name)} ${x.label} 약 ${dur(x.min)} · 1인 ${won(x.fare)} 별도`).join('<br>');

    let list, route = `${esc(legInfo.from.name)} → ${esc(legInfo.to.name)}`;
    if (sc.loading) list = '<div class="tk-loading"><span class="spinner sm"></span> 시간표를 불러오는 중…</div>';
    else {
      const items = sc.items.slice();
      // 여러 역·터미널(예: 서울·용산·청량리)에서 출발하는 편이 섞여 있으면 편마다 역 이름을 함께 표시
      const uniq = f => [...new Set(items.map(f))];
      const froms = uniq(i => i.from.name), tos = uniq(i => i.to.name);
      const multi = froms.length > 1 || tos.length > 1;
      if (items.length) route = `${froms.map(esc).join('·')} → ${tos.map(esc).join('·')}`;
      if (!items.length) list = '<div class="empty small">운행 편이 없어요</div>';
      else {
        const minFare = Math.min(...items.map(i => i.fare));
        const minTime = Math.min(...items.map(i => i.arr - i.dep));
        const sorter = { dep: (a, b) => a.dep - b.dep, fare: (a, b) => a.fare - b.fare || a.dep - b.dep, time: (a, b) => (a.arr - a.dep) - (b.arr - b.dep) || a.dep - b.dep }[S.tSort];
        list = items.sort(sorter).map(it => {
          const w = P.dayWindows({ ...winInput(), tickets: { ...S.tickets, [dir]: toTicket(it, sc.source) } });
          const tooShort = windowsBad(w);
          const on = chosen && chosen.id === it.id;
          const sub = [it.grade, multi ? `${it.from.name} → ${it.to.name}` : '', tooShort ? '현지 시간 부족' : ''].filter(Boolean).join(' · ');
          return `<button class="tk ${on ? 'on' : ''} ${tooShort ? 'short' : ''}" data-act="ticket" data-dir="${dir}" data-key="${esc(key)}" data-v="${esc(it.id)}">
            <span class="tk-time"><b>${clock(it.dep)}</b><i>→</i><b>${clock(it.arr)}</b><small>${dur(it.arr - it.dep)}${it.arrEst ? ' · 도착 예상' : ''}</small></span>
            <span class="tk-name"><b>${esc(it.name)}</b><small>${esc(sub)}</small></span>
            <span class="tk-badges">${it.fare === minFare && !it.fareEst ? '<em class="cheap">최저가</em>' : ''}${it.arr - it.dep === minTime ? '<em class="fast">최단</em>' : ''}</span>
            <span class="tk-fare"><b>${it.fareEst ? '약 ' : ''}${won(it.fare)}</b><small>${it.fareEst ? '요금 정보 없음 · 예상치' : `${S.people}명 ${won(it.fare * S.people)}`}</small></span>
          </button>`;
        }).join('');
      }
    }
    const links = T.bookingLinks(mode, A, B, date, null, S.people);
    return `<section class="tk-panel">
      <div class="tk-head">
        <div><span class="tk-dir">${dir === 'out' ? '가는 편' : '오는 편'}</span><b>${esc(A.name)} → ${esc(B.name)}</b><small>${m}/${dd}(${wd})</small></div>
        ${chosen ? `<button class="link" data-act="tclear" data-dir="${dir}">선택 해제</button>` : ''}
      </div>
      <div class="seg tk-tabs">${tabs}</div>
      <div class="tk-route">${route}${extra ? `<br><small>${extra}</small>` : ''}</div>
      ${sc.note ? `<div class="tk-note ${sc.source}">${esc(sc.note)}</div>` : ''}
      <div class="tk-list">${list}</div>
      <div class="tk-links">${chosen && chosen.mode === mode ? `<b>${esc(chosen.name)}</b> · ${chosen.from ? `${esc(chosen.from.name)} ` : ''}${clock(chosen.dep)} 출발 — ` : ''}예매하기 ${links.map(l => `<a class="btn ghost sm" href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>
    </section>`;
  }
  const toTicket = (it, source) => ({ id: it.id, mode: it.mode, dep: it.dep, arr: it.arr, fare: it.fare, fareEst: !!it.fareEst, grade: it.grade, name: it.name, from: it.from, to: it.to, source });

  // ---------- STEP 9 카테고리 ----------
  function viewCats() {
    return `${head(9, '어떤 걸 보고 싶나요?', '원하는 여행 카테고리를 여러 개 골라 주세요. 관광지 선정과 카페 포함 여부에 반영돼요.')}
    <div class="grid-cats">${P.CATEGORIES.map(c => `
      <button class="cat ${S.cats.includes(c.v) ? 'on' : ''}" data-act="cat" data-v="${c.v}">
        <span>${c.icon}</span><b>${c.label}</b>
        <small>${dest().attractions.filter(a => a.tags.includes(c.v)).length}곳</small>
      </button>`).join('')}</div>
    ${footer({ nextLabel: S.cats.length ? '다음' : '선택 없이 다음' })}`;
  }

  // ---------- STEP 9 필수 방문 장소 ----------
  function viewMust() {
    const d = dest();
    const list = d.attractions
      .map(a => ({ a, s: P.scoreSpot(a, S.prefs, S.cats) }))
      .sort((x, y) => y.s - x.s);
    const picked = S.must.map(id => d.attractions.find(a => a.id === id)).filter(Boolean);
    return `${head(10, '꼭 가고 싶은 곳이 있나요?', '선택한 장소는 시간·예산이 빠듯해도 일정에 우선 포함하고, 나머지는 취향과 동선에 맞춰 자동으로 채워요.')}
    <div class="picked">${picked.length ? picked.map(a => `<span class="pick">${esc(a.name)}<button data-act="must" data-v="${a.id}" aria-label="${esc(a.name)} 빼기">×</button></span>`).join('') : '<span class="muted">아직 선택한 장소가 없어요 (선택 사항)</span>'}</div>
    <input id="mustQuery" class="search" placeholder="장소 이름이나 태그로 검색 (예: 시장, 야경)" value="${esc(S.mustQuery)}" autocomplete="off">
    <div class="spot-list">${list.map(({ a }) => `
      <label class="spot ${S.must.includes(a.id) ? 'on' : ''}" data-search="${esc(`${a.name} ${a.tags.map(t => P.TAG_LABEL[t] || '').join(' ')}`)}">
        <input type="checkbox" data-act="must" data-v="${a.id}" ${S.must.includes(a.id) ? 'checked' : ''}>
        <div><b>${esc(a.name)}</b><div class="tags">${tagChips(a.tags)}</div></div>
        <div class="spot-meta"><span>${a.fee ? `1인 ${won(a.fee)}` : '무료'}</span><small>약 ${dur(a.dur)}</small></div>
      </label>`).join('')}
      <div class="empty small" id="noSpot" hidden>검색 결과가 없어요</div></div>
    ${footer({ nextLabel: '조건 확인하기' })}`;
  }
  // 한글 조합이 깨지지 않도록 다시 그리지 않고 목록만 필터링
  function filterSpots() {
    const q = S.mustQuery.trim();
    let shown = 0;
    document.querySelectorAll('.spot[data-search]').forEach(el => {
      const hit = !q || el.dataset.search.includes(q);
      el.hidden = !hit;
      if (hit) shown++;
    });
    const none = document.getElementById('noSpot');
    if (none) none.hidden = shown > 0;
  }

  // ---------- STEP 10 확인 & 생성 ----------
  function viewGenerate() {
    const d = dest();
    const rows = [
      ['총 예산', `${won(S.budget)}${S.reserve ? ` <small>(별도 ${won(S.reserve)} 제외 → ${won(effBudget())})</small>` : ''}`, 0],
      ['인원 · 기간', `${S.people}명 · ${DAYS_OPT[S.days - 1].label}`, 0],
      ['출발지', `${origin().name} (${S.intercity === 'fast' ? '빠른 교통편' : '저렴한 교통편'})`, 1],
      ['현지 이동', `${P.MODES[S.mode].icon} ${P.MODES[S.mode].label}`, 2],
      ['취향', P.QUESTIONS.map(q => answerLabel(q).replace(' · ', '')).filter(Boolean).join(', ') || '선택 안 함', 4],
      ['여행지', `${d.emoji} ${d.name}`, 5],
      ['날짜 · 시간', `${S.date || '미정'} · ${S.dayStart} ~ ${S.dayEnd}`, ST.time],
      ['교통편', ticketText(), ST.ticket],
      ['카테고리', S.cats.map(v => P.CATEGORIES.find(c => c.v === v).label).join(', ') || '선택 안 함', ST.cats],
      ['필수 장소', S.must.map(id => d.attractions.find(a => a.id === id).name).join(', ') || '없음', ST.must],
    ];
    return `${head(11, '이 조건으로 일정을 만들까요?', '비용 · 이동 동선 · 음식점 · 관광지가 모두 포함된 일정을 자동으로 생성해요.')}
    <dl class="review">${rows.map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v}</dd><button class="link" data-act="goto" data-v="${s}">수정</button></div>`).join('')}</dl>
    <div class="gen-box">
      <button class="btn primary xl" data-act="generate">✨ 일정 자동 생성</button>
      <p class="muted">관광지 선정 → 일자별 권역 묶기 → 방문 순서 최적화 → 식사·카페 배치 → 비용 계산 순서로 진행돼요.</p>
    </div>
    ${footer({ nextLabel: '일정 생성', nextDisabled: false })}`;
  }

  function ticketText() {
    const t = S.tickets;
    const one = (x, lab) => (x ? `${lab} ${P.MODE_INFO[x.mode].icon} ${esc(x.name)} ${clock(x.dep)}→${clock(x.arr)}` : `${lab} 예상치`);
    return `${one(t.out, '가는 편')} · ${one(t.ret, '오는 편')}`;
  }

  function viewLoading() {
    return `<div class="loading"><div class="spinner"></div>
      <h3>최적의 동선을 계산하고 있어요</h3>
      <ul class="load-steps">
        <li>💰 예산 안에서 관광지 고르는 중</li>
        <li>🗺️ 가까운 장소끼리 일자별로 묶는 중</li>
        <li>🔀 이동거리가 최소가 되도록 순서 조정 중</li>
        <li>🍽️ 동선 주변 음식점 찾는 중</li>
      </ul></div>`;
  }

  // ---------- STEP 11 결과 ----------
  function viewResult() {
    const p = S.plan;
    const c = p.cost, B = effBudget(), left = B - c.total;
    const d = p.dest, { out, ret } = p.trip;
    const legText = (l, lab) => `${lab} ${l.icon} ${l.ticket ? `${esc(l.ticket.name)} ${clock(l.dep)}` : `${l.label}(예상)`} ${won(l.fare)}${l.extraFare ? ` + 공항 연결 ${won(l.extraFare)}` : ''}`;
    const segs = [
      ['roundTrip', '왕복 교통비', c.roundTrip],
      ['local', '현지 교통비', c.local],
      ['food', '식비', c.food],
      ['fees', '관광지 입장료', c.fees],
      ['etc', '카페 및 기타', c.cafeEtc],
    ];
    const scale = Math.max(B, c.total);
    const legs = p.dayPlans.flatMap(dp => dp.items.filter(it => it.kind === 'leg'));
    const cnt = k => legs.filter(l => l.via === k).length;
    const meals = p.dayPlans.flatMap(dp => dp.items.filter(it => it.kind === 'meal'));
    const cafes = p.dayPlans.flatMap(dp => dp.items.filter(it => it.kind === 'cafe'));
    const paid = p.spots.filter(s => s.fee > 0).length;
    const detail = {
      roundTrip: `${legText(out, '가는 편')} · ${legText(ret, '오는 편')} (1인 기준) × ${p.people}명`,
      local: `${P.MODES[p.mode].icon} ${P.MODES[p.mode].label} · 도보 ${cnt('walk')}회 · 대중교통 ${cnt('transit')}회 · 택시 ${cnt('taxi')}회`,
      food: `점심·저녁 ${meals.length}끼 ${won(c.meals)}${c.breakfast ? ` + 아침 간편식 ${won(c.breakfast)}` : ''}`,
      fees: `관광지 ${p.spots.length}곳 중 유료 ${paid}곳`,
      etc: `카페 ${cafes.length}회 ${won(c.cafe)} + 간식·기타 ${won(c.misc)}`,
    };
    const saved = p.route.naiveKm - p.route.optKm;
    const savedPct = p.route.naiveKm ? Math.round((saved / p.route.naiveKm) * 100) : 0;
    const dateRange = S.date ? `${dayLabel(0).split(' · ')[1]}${p.days > 1 ? ` ~ ${dayLabel(p.days - 1).split(' · ')[1]}` : ''}` : '';

    return `<div class="result-head">
      <div><span class="step-no">최종 일정</span><h2>${d.emoji} ${d.name} ${DAYS_OPT[p.days - 1].label} 여행</h2>
        <p>${origin().name} 출발 · ${p.people}명 · ${dateRange} · ${P.MODES[p.mode].icon} ${P.MODES[p.mode].label}</p></div>
      <div class="result-actions"><button class="btn ghost" data-act="goto" data-v="${ST.generate}">조건 수정</button><button class="btn ghost" data-act="restart">처음부터</button></div>
    </div>

    <section class="card budget-card ${left < 0 ? 'over' : ''}">
      <div class="budget-nums">
        <div><small>총 예산</small><b>${won(B)}</b></div>
        <div><small>예상 사용 금액</small><b>${won(c.total)}</b></div>
        <div class="${left < 0 ? 'neg' : 'pos'}"><small>${left < 0 ? '예산 초과' : '잔여 예산'}</small><b>${won(Math.abs(left))}</b></div>
      </div>
      <div class="stack">${segs.map(([k, , v]) => `<span class="s-${k}" style="width:${(v / scale) * 100}%"></span>`).join('')}
        ${c.total < B ? `<span class="s-left" style="width:${((B - c.total) / scale) * 100}%"></span>` : ''}</div>
      <ul class="cost-list">${segs.map(([k, label, v]) => `
        <li><i class="dot s-${k}"></i><div><b>${label}</b><small>${detail[k]}</small></div><span>${won(v)}</span></li>`).join('')}
        <li class="total"><div><b>최종 예상 여행 비용</b><small>1인당 ${won(c.total / p.people)}${S.reserve ? ` · 별도 확보 ${won(S.reserve)} 제외` : ''}</small></div><span>${won(c.total)}</span></li>
      </ul>
      ${p.fitted ? `<div class="info">💡 예산에 맞추기 위해 저렴한 식당·이동수단을 우선 골랐어요${p.budgetExcluded.length ? ` · 제외한 장소: ${p.budgetExcluded.map(s => `${esc(s.name)}${s.fee ? `(1인 ${won(s.fee)})` : ''}`).join(', ')}` : ''}.</div>` : ''}
      ${!out.ticket || !ret.ticket ? `<div class="info">🎫 왕복 교통비 일부가 예상치예요. <button class="link" data-act="goto" data-v="${ST.ticket}">교통편 단계</button>에서 실제 시간표를 고르면 정확해져요.</div>` : ''}
      ${left < 0 ? '<div class="warn">선택한 식당·필수 장소 때문에 예산을 넘었어요. 더 저렴한 식당을 고르거나 필수 장소를 줄여 보세요.</div>' : ''}
      ${p.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')}
    </section>

    <section class="card route-card">
      <div class="card-title"><h3>🗺️ 이동 동선 <small class="map-src">${MapView.label()}</small></h3>
        <div class="route-stats">
          <span>총 이동 <b>${km(legs.reduce((s, l) => s + l.km, 0))}</b></span>
          <span>이동 시간 <b>${dur(legs.reduce((s, l) => s + l.min, 0))}</b></span>
          ${saved > 0.5 ? `<span class="saved">인기순 나열 대비 <b>${km(saved)} (${savedPct}%)</b> 단축</span>` : ''}
        </div></div>
      ${p.days > 1 ? `<div class="day-tabs">
        <button class="${S.activeDay === -1 ? 'on' : ''}" data-act="day" data-v="-1">전체</button>
        ${p.dayPlans.map((dp, i) => `<button class="${S.activeDay === i ? 'on' : ''}" data-act="day" data-v="${i}" style="--c:${DAY_COLORS[i]}">${i + 1}일차</button>`).join('')}
      </div>` : ''}
      <div id="map" class="map"></div>
      <div class="map-links">${p.dayPlans.filter((_, i) => S.activeDay === -1 || S.activeDay === i || p.days === 1).map(dp =>
        kakaoDayLinks(dp).map((u, j, arr) => `<a class="btn ghost sm" href="${u}" target="_blank" rel="noopener">카카오맵에서 ${p.days > 1 ? `${dp.idx + 1}일차 ` : ''}동선 열기${arr.length > 1 ? ` (${j + 1}/${arr.length})` : ''} ↗</a>`).join('')).join('')}
        <small class="muted">지도 위 선은 방문 순서이고, 실제 길 안내는 구간별 ‘길찾기’ 링크로 볼 수 있어요.</small></div>
    </section>

    ${p.dayPlans.filter((_, i) => S.activeDay === -1 || S.activeDay === i || p.days === 1).map(viewDay).join('')}`;
  }

  // 장거리 구간 (공항 연결 → 본 구간 → 공항 연결)
  function longRows(l, startTime) {
    const rows = [];
    let t = startTime;
    const row = (time, html) => rows.push(`<li class="tl ic"><span class="time">${time != null ? clock(time) : ''}</span><div>${html}</div></li>`);
    if (l.pre) { row(t, `🚌 ${esc(l.pre.from.name)} → <b>${esc(l.pre.to.name)}</b> <small>${l.pre.label} · 약 ${dur(l.pre.min)} · 1인 ${won(l.pre.fare)}</small>`); t += l.pre.min + (l.mode === 'air' ? 40 : 0); }
    const dep = l.dep != null ? l.dep : t, arr = l.arr != null ? l.arr : dep + l.min;
    row(dep, `${l.icon} <b>${esc(l.from.name)}</b> → <b>${esc(l.to.name)}</b> ${clock(arr)} 도착
      <small>${l.ticket ? `${esc(l.ticket.name)} · ${esc(l.ticket.grade)}` : `${l.label} (예상)`} · ${dur(arr - dep)} · 1인 ${l.ticket && l.ticket.fareEst ? '약 ' : ''}${won(l.fare)}</small>`);
    if (l.post) row(arr + 10, `🚌 ${esc(l.post.from.name)} → <b>${esc(l.post.to.name)}</b> <small>${l.post.label} · 약 ${dur(l.post.min)} · 1인 ${won(l.post.fare)}</small>`);
    return rows;
  }

  function viewDay(dp) {
    const p = S.plan, { out, ret } = p.trip, i = dp.idx, last = i === p.days - 1;
    const color = DAY_COLORS[i];
    let n = 0;
    const rows = [];
    if (i === 0) {
      const leave = out.dep != null ? out.dep - out.preMin - (out.mode === 'air' ? 40 : 10) : P.hm(S.dayStart);
      rows.push(...longRows(out, leave));
    } else rows.push(`<li class="tl start"><span class="time">${clock(dp.win.start)}</span><div>🌅 <b>${esc(dp.start.name)}</b>에서 출발</div></li>`);

    dp.items.forEach(it => {
      if (it.kind === 'leg') {
        const k = P.LEG_KIND[it.via];
        rows.push(`<li class="tl leg ${it.via}"><span class="time"></span><div>${k.icon} ${k.label} ${dur(it.min)} · ${km(it.km)}${it.cost ? ` · ${won(it.cost)}` : ''}
          ${it.km >= 0.3 ? `<span class="dir-links"><a href="${kakaoLegUrl(it)}" target="_blank" rel="noopener">카카오 길찾기</a><a href="${googleLegUrl(it)}" target="_blank" rel="noopener">구글</a></span>` : ''}</div></li>`);
      } else if (it.kind === 'spot') {
        n++;
        const a = it.place;
        rows.push(`<li class="tl spot"><span class="time">${clock(it.time)}<small>~${clock(it.time + it.dur)}</small></span>
          <div class="tl-card"><span class="num" style="background:${color}">${n}</span>
            <div class="tl-main"><b>${esc(a.name)}</b>${a.must ? '<span class="must">필수</span>' : ''}<div class="tags">${tagChips(a.tags)}</div></div>
            <div class="tl-side"><span>${a.fee ? won(it.cost) : '무료'}</span><small>${dur(it.dur)} 체류</small></div></div></li>`);
      } else if (it.kind === 'meal' || it.kind === 'cafe') {
        rows.push(`<li class="tl ${it.kind}"><span class="time">${clock(it.time)}<small>~${clock(it.time + it.dur)}</small></span>
          <div class="tl-card food"><div class="food-head">${it.kind === 'meal' ? '🍽️' : '☕'} <b>${it.label}</b> <small>동선 주변 후보 중 선택하면 비용이 다시 계산돼요</small><span class="food-cost">${won(it.cost)}</span></div>
            <div class="food-opts">${it.options.map(o => `
              <button class="food-opt ${o.place.id === it.place.id ? 'on' : ''}" data-act="choose" data-key="${it.key}" data-v="${o.place.id}">
                <b>${esc(o.place.name)}</b><small>${esc(o.place.menu)}</small>
                <span><em>1인 ${won(o.place.price)}</em> · 동선에서 ${km(o.km)}</span>
              </button>`).join('')}</div></div></li>`);
      } else if (it.kind === 'free') {
        rows.push(`<li class="tl free"><span class="time">${clock(it.time)}</span><div>⏳ 자유 시간 ${dur(it.dur)} <small>주변 산책·쇼핑</small></div></li>`);
      }
    });

    if (last) {
      rows.push(`<li class="tl end"><span class="time">${clock(dp.endTime)}</span><div>🚉 <b>${esc(dp.end.name)}</b> 도착 <small>${ret.ticket ? `귀가편 ${clock(ret.dep)} 출발` : '귀가편 탑승'}</small></div></li>`);
      rows.push(...longRows(ret, dp.endTime + (ret.pre ? 0 : 10)));
      rows.push(`<li class="tl end"><span class="time"></span><div>🏠 ${origin().name} 도착</div></li>`);
    } else {
      const lastPlace = [...dp.items].reverse().find(it => it.place);
      rows.push(`<li class="tl end"><span class="time">${clock(dp.endTime)}</span><div>🌙 <b>${esc(lastPlace ? lastPlace.place.name : dp.start.name)}</b> 인근에서 하루 마무리 <small>다음 날 이곳에서 출발 (숙박비 별도)</small></div></li>`);
    }

    return `<section class="card day-card" style="--c:${color}">
      <div class="card-title"><h3><span class="day-dot"></span>${dayLabel(i)}</h3>
        <div class="route-stats"><span>이동 <b>${km(dp.km)}</b></span><span>이동 시간 <b>${dur(dp.moveMin)}</b></span><span>현지 교통비 <b>${won(dp.localCost)}</b></span></div></div>
      <ol class="timeline">${rows.join('')}</ol>
    </section>`;
  }

  // ---------- 길찾기 링크 ----------
  const kname = p => encodeURIComponent(String(p.name).replace(/[,/]/g, ' '));
  const kpt = p => `${kname(p)},${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const KAKAO_BY = { walk: 'walk', transit: 'traffic', taxi: 'car' };
  const kakaoLegUrl = l => `https://map.kakao.com/link/by/${KAKAO_BY[l.via]}/${kpt(l.from)}/${kpt(l.to)}`;
  const GOOGLE_BY = { walk: 'walking', transit: 'transit', taxi: 'driving' };
  const googleLegUrl = l => `https://www.google.com/maps/dir/?api=1&origin=${l.from.lat},${l.from.lng}&destination=${l.to.lat},${l.to.lng}&travelmode=${GOOGLE_BY[l.via]}`;
  // 카카오맵은 출발·도착 + 경유지 5곳까지 → 7곳씩 끊어서 링크 생성 (자동차 경로)
  function kakaoDayLinks(dp) {
    const pts = MapView.points(dp);
    const out = [];
    for (let s = 0; s < pts.length - 1; s += 6) {
      const seg = pts.slice(s, s + 7);
      if (seg.length >= 2) out.push(`https://map.kakao.com/link/by/car/${seg.map(kpt).join('/')}`);
    }
    return out;
  }

  // ---------- 카카오맵 SDK ----------
  let kakaoState = KAKAO_KEY ? 'loading' : 'off';
  if (KAKAO_KEY) {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_KEY)}&autoload=false`;
    s.onload = () => {
      try {
        window.kakao.maps.load(() => { kakaoState = 'ready'; if (S.step === ST.result) rerenderKeepScroll(); });
      } catch (e) { kakaoState = 'error'; }
    };
    s.onerror = () => { kakaoState = 'error'; if (S.step === ST.result) rerenderKeepScroll(); };
    document.head.appendChild(s);
  }

  // ---------- 지도 (카카오맵 → OpenStreetMap → SVG 순으로 사용) ----------
  const pinHtml = (p, color) => (p.mark === 'spot' ? `<span class="pin" style="background:${color}">${p.n}</span>`
    : p.mark === 'meal' ? '<span class="pin food">🍽</span>'
      : p.mark === 'cafe' ? '<span class="pin food">☕</span>'
        : `<span class="pin hub">${p.mark === 'hub' ? '🚉' : '🌅'}</span>`);

  const MapView = {
    kind: null, map: null, layer: null, objs: [], el: null,
    tiles: null, // 'osm' | 'esri'
    label() {
      if (kakaoState === 'ready') return '카카오맵';
      if (kakaoState === 'loading') return '카카오맵 불러오는 중…';
      if (this.tiles === 'esri' || (!this.tiles && location.protocol === 'file:')) {
        return location.protocol === 'file:'
          ? '간이 지도 (확대하면 흐려져요) · 실행.bat으로 열면 선명한 지도가 나와요'
          : '간이 지도 (확대하면 흐려져요) · 지도 서버 연결을 확인해 주세요';
      }
      return kakaoState === 'error'
        ? 'OpenStreetMap · 카카오맵 키를 확인해 주세요'
        : 'OpenStreetMap · config.js에 카카오 키를 넣으면 카카오맵으로 바뀌어요';
    },
    unmount() {
      if (this.kind === 'leaflet' && this.map) this.map.remove();
      this.objs.forEach(o => o.setMap(null));
      Object.assign(this, { kind: null, map: null, layer: null, objs: [], el: null, tiles: null });
    },
    mount(el) {
      this.unmount();
      if (!el) return;
      this.el = el;
      if (kakaoState === 'ready') {
        const k = window.kakao.maps;
        this.kind = 'kakao';
        this.map = new k.Map(el, { center: new k.LatLng(36.5, 127.8), level: 8 });
        this.map.setZoomable(false);
        this.map.addControl(new k.ZoomControl(), k.ControlPosition.RIGHT);
      } else if (window.L) {
        this.kind = 'leaflet';
        this.map = L.map(el, { scrollWheelZoom: false });
        // Esri 타일은 키 없이 쓸 수 있지만 한국은 줌 13까지만 있어 그 이상은 확대해서 보여 준다
        const esri = () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19, maxNativeZoom: 13, attribution: 'Tiles &copy; Esri',
        });
        if (location.protocol === 'file:') {
          // 파일로 직접 열면 OSM이 요청을 차단하므로 처음부터 간이 지도 사용
          this.tiles = 'esri';
          esri().addTo(this.map);
        } else {
          // server.py가 OSM 타일을 대신 받아 와서 캐시해 준다
          this.tiles = 'osm';
          const osm = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
            maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
          }).addTo(this.map);
          let fails = 0;
          osm.on('tileerror', () => {
            if (++fails !== 4 || !this.map) return;
            this.map.removeLayer(osm);
            esri().addTo(this.map);
            this.tiles = 'esri';
            const lab = document.querySelector('.map-src');
            if (lab) lab.textContent = this.label();
          });
        }
        this.layer = L.layerGroup().addTo(this.map);
      } else {
        this.kind = 'svg';
      }
    },
    points(dp) {
      const pts = [{ ...dp.start, mark: dp.idx === 0 ? 'hub' : 'base' }];
      let n = 0;
      dp.items.forEach(it => {
        if (it.kind === 'spot') pts.push({ ...it.place, mark: 'spot', n: ++n });
        else if (it.kind === 'meal' || it.kind === 'cafe') pts.push({ ...it.place, mark: it.kind });
      });
      if (dp.end) pts.push({ ...dp.end, mark: 'hub' });
      return pts;
    },
    draw(plan, active) {
      const days = plan.dayPlans.filter((_, i) => active === -1 || active === i || plan.days === 1);
      if (this.kind === 'kakao') return this.drawKakao(days);
      if (this.kind !== 'leaflet') return this.drawSvg(plan, days);
      this.layer.clearLayers();
      const bounds = [];
      days.forEach(dp => {
        const color = DAY_COLORS[dp.idx];
        const pts = this.points(dp);
        L.polyline(pts.map(p => [p.lat, p.lng]), { color, weight: 4, opacity: 0.85, dashArray: dp.idx ? '8 6' : null }).addTo(this.layer);
        pts.forEach(p => {
          bounds.push([p.lat, p.lng]);
          L.marker([p.lat, p.lng], { icon: L.divIcon({ html: pinHtml(p, color), className: 'pin-wrap', iconSize: [28, 28], iconAnchor: [14, 14] }) })
            .bindTooltip(esc(p.name), { direction: 'top', offset: [0, -12] })
            .addTo(this.layer);
        });
      });
      if (bounds.length) this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: this.tiles === 'esri' ? 14 : 16 });
      setTimeout(() => this.map && this.map.invalidateSize(), 50);
    },
    drawKakao(days) {
      const k = window.kakao.maps;
      this.objs.forEach(o => o.setMap(null));
      this.objs = [];
      const bounds = new k.LatLngBounds();
      days.forEach(dp => {
        const color = DAY_COLORS[dp.idx];
        const pts = this.points(dp);
        const path = pts.map(p => new k.LatLng(p.lat, p.lng));
        const line = new k.Polyline({ path, strokeWeight: 4, strokeColor: color, strokeOpacity: 0.85, strokeStyle: dp.idx ? 'shortdash' : 'solid' });
        line.setMap(this.map);
        this.objs.push(line);
        pts.forEach((p, i) => {
          bounds.extend(path[i]);
          const ov = new k.CustomOverlay({ position: path[i], content: `<div class="pin-wrap" title="${esc(p.name)}">${pinHtml(p, color)}</div>`, xAnchor: 0.5, yAnchor: 0.5 });
          ov.setMap(this.map);
          this.objs.push(ov);
        });
      });
      this.map.relayout();
      this.map.setBounds(bounds, 40, 40, 40, 40);
    },
    // Leaflet을 불러오지 못했을 때(오프라인 등) 간단한 SVG 동선도
    drawSvg(plan, days) {
      const el = this.el || document.getElementById('map');
      if (!el) return;
      const all = days.flatMap(dp => this.points(dp));
      const lats = all.map(p => p.lat), lngs = all.map(p => p.lng);
      const [a0, a1, o0, o1] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
      const W = 800, H = 380, pad = 30;
      const sx = (W - pad * 2) / Math.max(1e-6, o1 - o0), sy = (H - pad * 2) / Math.max(1e-6, a1 - a0), s = Math.min(sx, sy);
      const X = p => pad + (p.lng - o0) * s + ((W - pad * 2) - (o1 - o0) * s) / 2;
      const Y = p => H - pad - (p.lat - a0) * s - ((H - pad * 2) - (a1 - a0) * s) / 2;
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="svg-map">${days.map(dp => {
        const pts = this.points(dp), color = DAY_COLORS[dp.idx];
        return `<polyline points="${pts.map(p => `${X(p)},${Y(p)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3"/>
          ${pts.map(p => `<g><circle cx="${X(p)}" cy="${Y(p)}" r="${p.mark === 'spot' ? 11 : 7}" fill="${p.mark === 'spot' ? color : '#fff'}" stroke="${color}" stroke-width="2"/>
          ${p.n ? `<text x="${X(p)}" y="${Y(p) + 4}" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">${p.n}</text>` : ''}
          <title>${esc(p.name)}</title></g>`).join('')}`;
      }).join('')}</svg><p class="muted center">지도를 불러오지 못해 간단한 동선도로 표시했어요.</p>`;
    },
  };

  // ---------- 요약 사이드바 ----------
  function renderSummary() {
    if (S.step === ST.result) { summaryEl.innerHTML = ''; return; }
    const d = dest();
    const row = (k, v, step) => `<li class="${step <= S.maxStep ? 'link' : ''}" ${step <= S.maxStep ? `data-act="goto" data-v="${step}"` : ''}><span>${k}</span><b>${v || '<i>-</i>'}</b></li>`;
    let alive = '';
    if (S.step >= 3 && S.origin && S.mode) {
      ensureCands();
      alive = `${pruning().alive.length}곳`;
    }
    summaryEl.innerHTML = `<div class="card sum-card"><h4>나의 여행 조건</h4><ul>
      ${row('예산', `${won(effBudget())}`, 0)}
      ${row('인원·기간', `${S.people}명 · ${DAYS_OPT[S.days - 1].label}`, 0)}
      ${row('출발지', S.origin ? origin().name : '', 1)}
      ${row('현지 이동', S.mode ? `${P.MODES[S.mode].icon} ${P.MODES[S.mode].label}` : '', 2)}
      ${row('후보', alive, 4)}
      ${row('여행지', d ? `${d.emoji} ${d.name}` : '', 5)}
      ${row('날짜', S.maxStep >= ST.time ? `${S.date} ${S.dayStart}~${S.dayEnd}` : '', ST.time)}
      ${row('교통편', S.maxStep >= ST.ticket ? ['out', 'ret'].map(k => (S.tickets[k] ? `${P.MODE_INFO[S.tickets[k].mode].icon}${clock(S.tickets[k].dep)}` : '예상')).join(' / ') : '', ST.ticket)}
      ${row('카테고리', S.cats.length ? S.cats.map(v => P.CATEGORIES.find(c => c.v === v).icon).join(' ') : '', ST.cats)}
      ${row('필수 장소', S.must.length ? `${S.must.length}곳` : '', ST.must)}
    </ul>
    <div class="concept"><b>💸 돈 + 🗺️ 동선</b><p>예산으로 여행지를 먼저 추리고, 현지 교통비와 이동 동선까지 계산해 실제로 실행 가능한 일정을 만들어요.</p></div></div>`;
  }

  function renderStepper() {
    stepperEl.innerHTML = `<ol>${STEPS.map((s, i) => `
      <li class="${i === S.step ? 'cur' : i <= S.maxStep ? 'done' : ''}">
        <button ${i <= S.maxStep ? `data-act="goto" data-v="${i}"` : 'disabled'}><span>${i + 1}</span><em>${s.label}</em></button>
      </li>`).join('')}</ol>`;
    const cur = stepperEl.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  const VIEWS = [viewBudget, viewOrigin, viewMode, viewCands, viewPrefs, viewDest, viewTime, viewTicket, viewCats, viewMust, viewGenerate, viewResult];

  function render() {
    syncTickets();
    if (S.step === ST.result && !S.plan) S.step = ST.generate;
    renderStepper();
    renderSummary();
    layoutEl.classList.toggle('wide', S.step === ST.result);
    appEl.innerHTML = `<div class="${S.step === ST.result ? '' : 'card step-card'}">${VIEWS[S.step]()}</div>`;
    if (S.step === ST.result) {
      MapView.mount(document.getElementById('map'));
      MapView.draw(S.plan, S.plan.days === 1 ? 0 : S.activeDay);
    } else {
      MapView.mount(null);
    }
    if (S.step === ST.must) filterSpots();
  }

  // 결과 화면에서 식당 변경 등: 스크롤 위치 유지하며 다시 그림
  function rerenderKeepScroll() {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  // ---------- 이벤트 ----------
  const canNext = () => {
    switch (S.step) {
      case 0: return effBudget() >= 10000;
      case 1: return !!S.origin;
      case 2: return !!S.mode;
      case 3: return available().length > 0;
      case 5: return !!S.destId;
      case ST.time:
      case ST.ticket: return !windowsBad(P.dayWindows(winInput()));
      default: return true;
    }
  };

  function answer(key, val) {
    S.prefs = { ...S.prefs, [key]: val };
    S.qi = Math.min(P.QUESTIONS.length, S.qi + 1);
    if (S.qi < P.QUESTIONS.length && P.QUESTIONS[S.qi].multi) S.themesDraft = S.prefs.themes === 'any' ? [] : (S.prefs.themes || []).slice();
    invalidateFrom(4);
    const { alive } = pruning();
    if (S.destId && !alive.some(c => c.dest.id === S.destId)) S.destId = null;
    render();
  }

  function generate() {
    appEl.innerHTML = `<div class="card step-card">${viewLoading()}</div>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      S.choices = {};
      S.plan = P.plan(fullInput());
      S.activeDay = S.days > 1 ? -1 : 0;
      go(ST.result);
    }, 900);
  }

  // 시간표 연결 상태 (실시간 / 예시)
  T.status().then(st => { S.tStatus = st; const el = document.getElementById('tkStatus'); if (el) el.innerHTML = statusBadge(); });

  const actions = {
    home: (v, el, e) => { e.preventDefault(); go(0); },
    back: () => go(S.step - 1),
    next: () => {
      if (!canNext()) return;
      if (S.step === ST.generate) return generate();
      go(S.step + 1);
    },
    goto: v => go(Number(v)),
    budget: v => { S.budget = Number(v); invalidateFrom(0); render(); },
    people: v => { S.people = Math.max(1, Math.min(8, S.people + Number(v))); invalidateFrom(0); render(); },
    days: v => { S.days = Number(v); invalidateFrom(0); render(); },
    origin: v => { S.origin = v; invalidateFrom(1); if (S.destId && dest().name === origin().name) S.destId = null; render(); },
    intercity: v => { S.intercity = v; invalidateFrom(1); render(); },
    mode: v => { S.mode = v; invalidateFrom(2); render(); },
    toggleOver: () => { S.showOver = !S.showOver; },
    qans: v => answer(P.QUESTIONS[S.qi].key, v),
    qany: () => answer(P.QUESTIONS[S.qi].key, 'any'),
    qtheme: v => {
      S.themesDraft = S.themesDraft.includes(v) ? S.themesDraft.filter(x => x !== v) : S.themesDraft.concat(v);
      render();
    },
    qthemeDone: () => answer('themes', S.themesDraft.slice()),
    qgoto: v => {
      S.qi = Number(v);
      if (P.QUESTIONS[S.qi].multi) S.themesDraft = Array.isArray(S.prefs.themes) ? S.prefs.themes.slice() : [];
      render();
    },
    qreset: () => { S.prefs = { nature: null, food: null, themes: [], hidden: null }; S.qi = 0; S.themesDraft = []; invalidateFrom(4); render(); },
    dest: v => {
      if (S.destId !== v) { S.must = []; S.choices = {}; S.mustQuery = ''; invalidateFrom(5); }
      S.destId = v;
      render();
    },
    tmode: (v, el) => { S.tMode = { ...S.tMode, [el.dataset.dir]: v }; rerenderKeepScroll(); },
    tsort: v => { S.tSort = v; rerenderKeepScroll(); },
    tclear: (v, el) => { const t = { ...S.tickets }; delete t[el.dataset.dir]; S.tickets = t; invalidateFrom(ST.ticket); rerenderKeepScroll(); },
    ticket: (v, el) => {
      const dir = el.dataset.dir, sc = S.sched[el.dataset.key];
      const it = sc && sc.items && sc.items.find(x => x.id === v);
      if (!it) return;
      const t = { ...S.tickets };
      if (t[dir] && t[dir].id === v) delete t[dir];
      else t[dir] = toTicket(it, sc.source);
      S.tickets = t;
      invalidateFrom(ST.ticket);
      rerenderKeepScroll();
    },
    cat: v => { S.cats = S.cats.includes(v) ? S.cats.filter(x => x !== v) : S.cats.concat(v); invalidateFrom(ST.cats); render(); },
    must: v => { S.must = S.must.includes(v) ? S.must.filter(x => x !== v) : S.must.concat(v); invalidateFrom(ST.must); render(); },
    generate: () => generate(),
    restart: () => {
      Object.assign(S, { step: 0, maxStep: 0, origin: null, mode: null, destId: null, candKey: '', plan: null, choices: {}, must: [], cats: [], qi: 0, themesDraft: [], tickets: {}, tMode: {}, prefs: { nature: null, food: null, themes: [], hidden: null } });
      render();
      window.scrollTo({ top: 0 });
    },
    day: v => { S.activeDay = Number(v); rerenderKeepScroll(); },
    choose: (v, el) => {
      S.choices = { ...S.choices, [el.dataset.key]: v };
      S.plan = P.rebuild(fullInput(), S.plan);
      rerenderKeepScroll();
    },
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    // 체크박스는 change 이벤트에서 처리
    if (el.tagName === 'INPUT' && el.type === 'checkbox') return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el.dataset.v, el, e);
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('input[type=checkbox][data-act]')) actions[el.dataset.act](el.dataset.v, el, e);
    if (el.id === 'date' && el.value) { S.date = el.value; invalidateFrom(ST.time); render(); }
    if (el.id === 'dayStart' || el.id === 'dayEnd') {
      if (el.value) S[el.id] = el.value;
      invalidateFrom(ST.time);
      render();
    }
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'budget' || el.id === 'reserve') {
      const n = Number(el.value.replace(/[^\d]/g, '')) || 0;
      S[el.id] = Math.min(n, 100000000);
      el.value = n ? S[el.id].toLocaleString() : '';
      invalidateFrom(0);
      const eff = document.getElementById('eff');
      if (eff) {
        eff.textContent = won(effBudget());
        eff.nextElementSibling.textContent = `1인당 약 ${won(effBudget() / S.people)}`;
      }
      document.querySelectorAll('[data-act="budget"]').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === S.budget));
      const next = document.querySelector('[data-act="next"]');
      if (next) next.disabled = effBudget() < 10000;
      renderSummary();
      renderStepper();
    }
    if (el.id === 'mustQuery') {
      S.mustQuery = el.value;
      filterSpots();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('#budget, #reserve')) actions.next();
  });

  render();
})();
