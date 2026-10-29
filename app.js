// 오늘의 밥 — 날씨 맞춤 점심 추천
// 위치(Geolocation) → 날씨(Open-Meteo) → 메뉴 추천(menus.js) → 근처 식당(카카오 키워드 검색)
(() => {
  "use strict";

  const $ = s => document.querySelector(s);
  const CONDS = window.WEATHER_CONDS;
  const COND = Object.fromEntries(CONDS.map(c => [c.id, c]));
  const RADII = [500, 1000, 2000, 3000];
  const MAX_RECS = 5;
  const MAX_SEARCH = 10;          // 추천 한 번에 식당 수 확인은 최대 10회
  const CACHE_MS = 10 * 60 * 1000; // 같은 검색은 10분간 재사용
  const CACHE_M = 200;             // 200m 안이면 같은 위치로 본다

  // ---------- 저장 (실패해도 앱은 동작) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ob." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("ob." + k, JSON.stringify(v)); } catch (e) { /* 저장 못 해도 계속 */ } },
  };
  const savedRadius = store.get("radius", 1000);
  const P = {
    likes: new Set(store.get("likes", [])),
    nopes: new Set(store.get("nopes", [])),
    custom: store.get("custom", []),
    eaten: store.get("eaten", []),
    radius: RADII.includes(savedRadius) ? savedRadius : 1000,
  };
  const savePrefs = () => { store.set("likes", [...P.likes]); store.set("nopes", [...P.nopes]); };

  // ---------- 상태 ----------
  const S = {
    loc: null,          // {lat, lng, label, source: 'gps'|'manual'}
    weather: null,
    conds: [],
    recs: [],           // [{menu, count}]  count가 null이면 식당 수 확인 못 함
    order: [], idx: 0, tries: 0, run: 0, pending: 0, filling: false, short: false,
    kakaoDown: null,    // null | 'nokey' | 'load' | 'search'
    loadedAt: 0,
  };

  // ---------- 작은 도우미 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const radiusLabel = r => (r < 1000 ? r + "m" : r / 1000 + "km");
  const distLabel = m => (m < 1000 ? Math.round(m / 10) * 10 + "m" : (m / 1000).toFixed(1) + "km");
  const countLabel = n => (n >= 45 ? "45곳+" : n + "곳"); // 카카오는 검색 결과를 최대 45곳까지만 센다
  function meters(a, b, c, d) {
    const R = 6371000, rad = Math.PI / 180;
    const x = (d - b) * rad * Math.cos(((a + c) / 2) * rad), y = (c - a) * rad;
    return Math.sqrt(x * x + y * y) * R;
  }
  function startOfDay(offset = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime(); }

  let toastTimer = 0;
  function toast(msg, actionLabel, action) {
    const t = $("#toast");
    t.replaceChildren(h("span", null, msg));
    if (actionLabel) t.append(h("button", { type: "button", onclick: () => { t.hidden = true; action(); } }, actionLabel));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 5000 : 2800);
  }

  // ---------- 메뉴 ----------
  function allMenus() {
    const map = new Map();
    for (const m of window.MENUS) map.set(m.name, { name: m.name, q: m.q, conds: [...m.conds] });
    for (const c of P.custom) {
      const ex = map.get(c.name);
      if (ex) { ex.conds = [...new Set([...ex.conds, ...c.conds])]; ex.customId = c.id; }
      else map.set(c.name, { name: c.name, conds: [...c.conds], customId: c.id });
    }
    return [...map.values()];
  }
  const findMenu = name => allMenus().find(m => m.name === name) || { name, conds: [] };

  function recentEaten() {
    const from = startOfDay(-2); // 오늘 포함 3일
    return new Set(P.eaten.filter(e => e.at >= from).map(e => e.name));
  }
  function eatenToday(name) { const t = startOfDay(); return P.eaten.some(e => e.name === name && e.at >= t); }
  function setEaten(name, on) {
    const t = startOfDay();
    P.eaten = P.eaten.filter(e => !(e.name === name && e.at >= t) && e.at >= startOfDay(-30));
    if (on) P.eaten.push({ name, at: Date.now() });
    store.set("eaten", P.eaten);
  }

  function candidates() {
    const conds = new Set([...S.conds, "always"]);
    const recent = recentEaten();
    return allMenus().filter(m => m.conds.some(c => conds.has(c)) && !P.nopes.has(m.name) && !recent.has(m.name));
  }
  // 가중치 무작위 순서: 좋아요는 3배
  function weightedOrder(list) {
    return list
      .map(m => ({ m, k: Math.pow(Math.random(), 1 / (P.likes.has(m.name) ? 3 : 1)) }))
      .sort((a, b) => b.k - a.k)
      .map(x => x.m);
  }

  // ---------- 날씨 ----------
  const RAIN = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
  const SNOW = new Set([71, 73, 75, 77, 85, 86]);

  function classify(c) {
    const t = c.temperature_2m, code = c.weather_code, pr = c.precipitation || 0, day = c.is_day !== 0;
    let sky;
    if (SNOW.has(code)) sky = "snow";
    else if (RAIN.has(code)) sky = code >= 95 ? "thunder" : "rain";
    else if (pr > 0) sky = t <= 0 ? "snow" : "rain";
    else if (code === 45 || code === 48) sky = "fog";
    else if (code === 3) sky = "cloud";
    else if (code === 2) sky = "partly";
    else sky = day ? "sun" : "moon";

    const state = { snow: "눈", rain: "비", thunder: "천둥·비", fog: "안개", cloud: "흐림", partly: "구름 조금", sun: "맑음", moon: "맑음" }[sky];
    const wet = sky === "rain" || sky === "thunder" ? "rain" : sky === "snow" ? "snow" : null;
    let theme;
    if (wet) theme = wet;
    else if (t >= 28) theme = "hot";
    else if (sky === "cloud" || sky === "fog") theme = "cloud";
    else theme = "sun";

    const r = Math.round(t);
    const band = r < 0 ? "snow" : r <= 10 ? "cold" : r <= 22 ? "mild" : r <= 27 ? "warm" : "hot";
    const conds = [...new Set([wet, band].filter(Boolean))];
    return { temp: t, feels: c.apparent_temperature, precip: pr, sky, state, theme, conds };
  }

  const ICON = (() => {
    const cloud = `<path d="M18 44h28a10 10 0 0 0 0-20h-1a13 13 0 0 0-25 4a8 8 0 0 0-2 16z" fill="currentColor"/>`;
    const up = s => `<g transform="translate(0 -7)">${s}</g>`;
    const rays = (cx, cy, r1, r2) => Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
      return `<line x1="${(cx + c * r1).toFixed(1)}" y1="${(cy + s * r1).toFixed(1)}" x2="${(cx + c * r2).toFixed(1)}" y2="${(cy + s * r2).toFixed(1)}"/>`;
    }).join("");
    const g = inner => `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    return {
      sun: g(`<circle cx="32" cy="32" r="11" fill="currentColor"/>${rays(32, 32, 19, 27)}`),
      moon: g(`<path d="M40 10a22 22 0 1 0 14 32a17 17 0 0 1-14-32z" fill="currentColor"/>`),
      partly: g(`<circle cx="22" cy="22" r="8"/>${rays(22, 22, 13, 18)}${`<g transform="translate(4 4)">${cloud}</g>`}`),
      cloud: g(cloud),
      fog: g(`<line x1="12" y1="22" x2="52" y2="22"/><line x1="8" y1="32" x2="44" y2="32"/><line x1="18" y1="42" x2="56" y2="42"/><line x1="12" y1="52" x2="40" y2="52"/>`),
      rain: g(`${up(cloud)}<line x1="24" y1="46" x2="21" y2="56"/><line x1="34" y1="46" x2="31" y2="56"/><line x1="44" y1="46" x2="41" y2="56"/>`),
      thunder: g(`${up(cloud)}<path d="M34 40l-7 11h7l-4 10 11-14h-7l4-7z" fill="currentColor" stroke-width="2"/>`),
      snow: g(`${up(cloud)}<circle cx="23" cy="48" r="2.5" fill="currentColor"/><circle cx="33" cy="54" r="2.5" fill="currentColor"/><circle cx="43" cy="48" r="2.5" fill="currentColor"/><circle cx="28" cy="59" r="2.5" fill="currentColor"/><circle cx="39" cy="60" r="2.5" fill="currentColor"/>`),
    };
  })();

  function setWeatherMsg(msg, retry) {
    const card = $("#weather");
    card.className = "weather theme-loading";
    $("#weatherBody").replaceChildren(h("p", { class: "weather-msg" }, msg,
      retry ? h("br") : null,
      retry ? h("button", { class: "btn", type: "button", onclick: retry }, "다시 시도") : null));
  }

  function renderWeather() {
    const w = S.weather;
    $("#weather").className = "weather theme-" + w.theme;
    const sub = [];
    if (w.feels != null && Math.round(w.feels) !== Math.round(w.temp)) sub.push(`체감 ${Math.round(w.feels)}℃`);
    if (w.precip > 0) sub.push(`강수 ${w.precip}mm`);
    $("#weatherBody").replaceChildren(
      h("div", { class: "w-icon", html: ICON[w.sky] }),
      h("div", { class: "w-temp", "aria-label": `기온 ${Math.round(w.temp)}도` }, String(Math.round(w.temp)), h("small", null, "℃")),
      h("div", { class: "w-text" },
        h("span", { class: "w-state" }, w.state),
        sub.length ? h("span", { class: "w-sub" }, sub.join(" · ")) : null));
  }

  async function loadWeather(loc) {
    setWeatherMsg("날씨를 불러오고 있어요…");
    const u = "https://api.open-meteo.com/v1/forecast?latitude=" + loc.lat.toFixed(4) + "&longitude=" + loc.lng.toFixed(4) +
      "&current=temperature_2m,apparent_temperature,precipitation,weather_code,is_day&timezone=Asia%2FSeoul";
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      if (S.loc !== loc) return;
      S.weather = classify(j.current);
      S.conds = S.weather.conds;
      renderWeather();
    } catch (e) {
      if (S.loc !== loc) return;
      S.weather = null;
      S.conds = ["mild"];
      setWeatherMsg("날씨를 불러오지 못했어요.", () => loadWeather(loc).then(() => recommend()));
    }
    S.loadedAt = Date.now();
  }

  // ---------- 카카오 (키가 없거나 막혀도 메뉴 추천은 동작) ----------
  let kakaoP = null;
  function loadKakao() {
    if (kakaoP) return kakaoP;
    const key = ((window.APP_CONFIG || {}).KAKAO_JS_KEY || "").trim();
    if (!key || key.includes("여기에")) return (kakaoP = Promise.reject(Object.assign(new Error("nokey"), { kind: "nokey" })));
    kakaoP = new Promise((res, rej) => {
      const fail = () => rej(Object.assign(new Error("load"), { kind: "load" }));
      const timer = setTimeout(fail, 12000);
      const s = document.createElement("script");
      s.src = "https://dapi.kakao.com/v2/maps/sdk.js?appkey=" + encodeURIComponent(key) + "&libraries=services&autoload=false";
      s.onload = () => {
        try { window.kakao.maps.load(() => { clearTimeout(timer); res(window.kakao); }); }
        catch (e) { clearTimeout(timer); fail(); }
      };
      s.onerror = () => { clearTimeout(timer); fail(); };
      document.head.append(s);
    });
    kakaoP.catch(() => { kakaoP = null; }); // 네트워크 문제였다면 다음에 다시 시도
    return kakaoP;
  }

  const cache = []; // 추천 화면의 식당 수와 식당 목록이 같은 결과를 함께 쓴다
  function searchPlaces(menu) {
    const { lat, lng } = S.loc, radius = P.radius, kw = menu.q || menu.name, now = Date.now();
    for (let i = cache.length - 1; i >= 0; i--) if (now - cache[i].at > CACHE_MS) cache.splice(i, 1);
    const hit = cache.find(c => c.kw === kw && c.radius === radius && meters(c.lat, c.lng, lat, lng) <= CACHE_M);
    if (hit) return hit.p;
    const p = loadKakao().then(k => new Promise((res, rej) => {
      const St = k.maps.services.Status;
      const timer = setTimeout(() => rej(Object.assign(new Error("search"), { kind: "search" })), 10000);
      new k.maps.services.Places().keywordSearch(kw, (data, status, pg) => {
        clearTimeout(timer);
        if (status === St.OK) res({ total: pg && pg.totalCount ? pg.totalCount : data.length, places: data });
        else if (status === St.ZERO_RESULT) res({ total: 0, places: [] });
        else rej(Object.assign(new Error("search"), { kind: "search" }));
      }, {
        location: new k.maps.LatLng(lat, lng), radius, sort: k.maps.services.SortBy.DISTANCE,
        category_group_code: "FD6", size: 15,
      });
    }));
    const entry = { lat, lng, radius, kw, at: now, p };
    cache.push(entry);
    p.catch(() => { const i = cache.indexOf(entry); if (i >= 0) cache.splice(i, 1); });
    return p;
  }

  function kakaoFail(e) {
    S.kakaoDown = e.kind || "search";
    const msg = {
      nokey: "카카오 키가 아직 설정되지 않아 식당 수 없이 날씨 추천만 보여드려요.",
      load: "식당 검색을 불러오지 못했어요. 인터넷 연결을 확인해 주세요. 메뉴 추천은 계속 쓸 수 있어요.",
      search: "오늘 검색 한도에 도달했어요. 내일 다시 시도해 주세요. 메뉴 추천은 계속 쓸 수 있어요.",
    }[S.kakaoDown];
    const n = $("#notice");
    n.textContent = msg;
    n.hidden = false;
  }

  // ---------- 추천 ----------
  function condNote() {
    if (!S.weather) return "날씨 정보 없이 골랐어요.";
    const names = S.conds.map(c => (COND[c].range ? `${COND[c].label}(${COND[c].range})` : COND[c].label));
    return `${names.join(" · ")} 날씨에 어울리는 메뉴예요.`;
  }

  async function recommend({ keep = [], avoid = [] } = {}) {
    const run = ++S.run;
    if (S.kakaoDown && S.kakaoDown !== "nokey") { S.kakaoDown = null; $("#notice").hidden = true; }
    let order = weightedOrder(candidates());
    if (avoid.length) order = [...order.filter(m => !avoid.includes(m.name)), ...order.filter(m => avoid.includes(m.name))];
    if (keep.length) {
      const first = keep.map(n => order.find(m => m.name === n)).filter(Boolean);
      order = [...first, ...order.filter(m => !first.includes(m))];
    }
    Object.assign(S, { order, idx: 0, tries: 0, recs: [], short: false });
    $("#recNote").textContent = order.length ? condNote() : "";
    if (!order.length) {
      S.pending = 0;
      renderRecs("추천할 메뉴가 없어요. 내 메뉴에서 ✕ 안 먹음을 줄이거나 메뉴를 추가해 보세요.");
      return;
    }
    await fill(run, MAX_SEARCH);
  }

  // 후보를 차례로 꺼내 근처 식당이 있는 메뉴만 채운다
  async function fill(run, budget) {
    S.filling = true;
    S.pending = Math.min(MAX_RECS, S.recs.length + S.order.length - S.idx);
    renderRecs();
    let ok = !S.kakaoDown && S.loc;
    if (ok) { try { await loadKakao(); } catch (e) { ok = false; if (run === S.run) kakaoFail(e); } }
    if (run !== S.run) return;

    const fillWithoutCount = extra => {
      const rest = [...extra, ...S.order.slice(S.idx)];
      for (const m of rest) {
        if (S.recs.length >= MAX_RECS) break;
        S.recs.push({ menu: m, count: null });
        if (!extra.includes(m)) S.idx++;
      }
    };

    if (!ok) fillWithoutCount([]);
    else {
      while (S.recs.length < MAX_RECS && S.idx < S.order.length && S.tries < budget) {
        const n = Math.min(MAX_RECS - S.recs.length, budget - S.tries, S.order.length - S.idx);
        const batch = S.order.slice(S.idx, S.idx + n);
        S.idx += n; S.tries += n;
        const res = await Promise.allSettled(batch.map(searchPlaces));
        if (run !== S.run) return;
        const failed = [];
        res.forEach((r, i) => {
          if (r.status === "rejected") failed.push(batch[i]);
          else if (r.value.total > 0) S.recs.push({ menu: batch[i], count: r.value.total });
        });
        if (failed.length) {
          kakaoFail(res.find(r => r.status === "rejected").reason);
          fillWithoutCount(failed);
          break;
        }
        S.pending = Math.min(MAX_RECS, S.recs.length + Math.min(S.order.length - S.idx, budget - S.tries));
        renderRecs();
      }
    }
    S.pending = 0;
    S.filling = false;
    S.short = !S.kakaoDown && S.recs.length < MAX_RECS;
    renderRecs();
  }

  function prefButtons(name, compact) {
    const like = P.likes.has(name), nope = P.nopes.has(name);
    return [
      h("button", {
        class: "pref like", type: "button", "aria-pressed": String(like),
        "aria-label": `${name} 좋아요${like ? " 해제" : ""}`, onclick: () => togglePref(name, "like"),
      }, like ? "♥" : "♡", compact ? null : h("small", null, "좋아요")),
      h("button", {
        class: "pref nope", type: "button", "aria-pressed": String(nope),
        "aria-label": `${name} 안 먹음${nope ? " 해제" : ""}`, onclick: () => togglePref(name, "nope"),
      }, "✕", compact ? null : h("small", null, "안 먹음")),
    ];
  }

  function renderRecs(emptyMsg) {
    const list = $("#recList");
    list.replaceChildren();
    S.recs.forEach(r => {
      const name = r.menu.name, liked = P.likes.has(name);
      list.append(h("li", { class: "rec", "data-name": name },
        h("button", {
          class: "rec-main", type: "button",
          "aria-label": `${name}${liked ? ", 좋아요" : ""}${r.count != null ? `, 근처 ${r.count}곳` : ""}. 식당 보기`,
          onclick: () => go("#menu/" + encodeURIComponent(name)),
        },
          h("span", { class: "rec-name" }, name, liked ? h("span", { class: "heart", "aria-hidden": "true" }, "♥") : null),
          r.count != null ? h("span", { class: "badge" }, countLabel(r.count)) : null,
          h("span", { class: "rec-go", "aria-hidden": "true" }, "›")),
        h("div", { class: "rec-btns" }, prefButtons(name))));
    });
    for (let i = S.recs.length; i < S.pending; i++) {
      list.append(h("li", { class: "rec loading", "aria-hidden": "true" },
        h("div", { class: "rec-main" }, h("span", { class: "skeleton" }), h("span", { class: "skeleton", style: "width:3rem" }))));
    }
    if (emptyMsg) list.append(h("li", { class: "notice" }, emptyMsg));
    else if (S.short && !S.pending) {
      list.append(h("li", { class: "notice" },
        S.recs.length ? `반경 ${radiusLabel(P.radius)} 안에서 ${S.recs.length}개만 찾았어요. ` : `반경 ${radiusLabel(P.radius)} 안에서 식당을 찾지 못했어요. `,
        P.radius < 3000 ? h("a", { href: "#settings" }, "반경을 넓혀보세요") : "다른 지역으로 바꿔 보세요."));
    }
    const busy = S.pending > 0;
    list.setAttribute("aria-busy", String(busy));
    $("#pickBtn").disabled = busy || !S.recs.length;
  }

  function togglePref(name, kind) {
    const [set, other] = kind === "like" ? [P.likes, P.nopes] : [P.nopes, P.likes];
    const on = !set.has(name);
    if (on) { set.add(name); other.delete(name); } else set.delete(name);
    savePrefs();

    if (kind === "nope" && on) {
      const i = S.recs.findIndex(r => r.menu.name === name);
      if (i >= 0) {
        S.recs.splice(i, 1);
        S.order = S.order.filter(m => m.name !== name || S.order.indexOf(m) < S.idx);
        if (!S.filling) fill(S.run, S.tries + 3); // 빈자리 채우기
      }
      toast(`‘${name}’은(는) 추천하지 않을게요`, "되돌리기", () => { P.nopes.delete(name); savePrefs(); refreshViews(); });
    } else if (kind === "like" && on) toast(`‘${name}’ 좋아요! 더 자주 추천할게요`);
    refreshViews();
  }

  function refreshViews() {
    renderRecs();
    if (!$("#view-my").hidden) renderMy();
    if (!$("#view-menu").hidden) $("#menuPrefs").replaceChildren(...prefButtons(curMenu, true));
  }

  // 룰렛처럼 하나 뽑기
  let spinning = false;
  function spin() {
    const cards = [...document.querySelectorAll("#recList .rec:not(.loading)")];
    if (!cards.length || spinning) return;
    spinning = true;
    cards.forEach(c => c.classList.remove("picked"));
    const target = Math.floor(Math.random() * cards.length);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const total = reduce ? 1 : cards.length * 2 + target + 1;
    let step = 0;
    const tick = () => {
      cards.forEach(c => c.classList.remove("spin-on"));
      const i = reduce ? target : step % cards.length;
      cards[i].classList.add("spin-on");
      step++;
      if (step < total) {
        const p = step / total;
        setTimeout(tick, 55 + 380 * p * p * p);
      } else {
        setTimeout(() => {
          cards[i].classList.remove("spin-on");
          cards[i].classList.add("picked");
          spinning = false;
          if (navigator.vibrate) try { navigator.vibrate(40); } catch (e) { /* 진동 미지원 */ }
          openSheet(S.recs[i]);
        }, 250);
      }
    };
    tick();
  }

  function openSheet(rec) {
    if (!rec) return;
    $("#sheetTitle").textContent = rec.menu.name;
    $("#sheetSub").textContent = rec.count != null ? `반경 ${radiusLabel(P.radius)} 안에 ${countLabel(rec.count)}` : "";
    $("#sheetGo").onclick = () => { closeSheet(); go("#menu/" + encodeURIComponent(rec.menu.name)); };
    $("#sheet").hidden = false;
    $("#sheetGo").focus();
  }
  function closeSheet() { $("#sheet").hidden = true; }

  // ---------- 위치 ----------
  function getPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej({ code: 0 });
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
        rej, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 });
    });
  }

  function updateLocLabel() {
    const l = S.loc ? S.loc.label || (S.loc.source === "gps" ? "현재 위치" : "선택한 지역") : "위치 정하기";
    $("#locLabel").textContent = l;
    $("#setLoc").textContent = S.loc ? `지금 기준: ${l}${S.loc.source === "gps" ? " (현재 위치)" : ""}` : "아직 위치가 정해지지 않았어요.";
  }

  async function reverseLabel(loc) {
    try {
      const k = await loadKakao();
      return await new Promise(res => {
        new k.maps.services.Geocoder().coord2RegionCode(loc.lng, loc.lat, (r, st) => {
          if (st !== k.maps.services.Status.OK || !r.length) return res(null);
          const a = r.find(x => x.region_type === "H") || r[0];
          res(a.region_3depth_name || a.region_2depth_name || null);
        });
      });
    } catch (e) { return null; }
  }

  async function setLocation(loc) {
    S.loc = loc;
    updateLocLabel();
    if (loc.source === "manual") store.set("lastPlace", { lat: loc.lat, lng: loc.lng, label: loc.label });
    if (!loc.label) reverseLabel(loc).then(l => { if (l && S.loc === loc) { loc.label = l; updateLocLabel(); } });
    await loadWeather(loc);
    if (S.loc !== loc) return;
    if (curMenu) openMenu(curMenu);
    recommend();
  }

  function showPlaceForm(hint) {
    const f = $("#placeForm");
    f.hidden = false;
    $("#placeHint").textContent = hint || "지역이나 역 이름으로 찾을 수 있어요.";
    $("#placeCancel").hidden = !S.loc;
    $("#placeInput").focus();
  }
  function hidePlaceForm() { $("#placeForm").hidden = true; }

  async function locateByGps(initial) {
    if (!S.loc) setWeatherMsg("위치를 확인하고 있어요…");
    $("#locLabel").textContent = "위치 확인 중";
    try {
      const pos = await getPosition();
      hidePlaceForm();
      await setLocation({ ...pos, label: null, source: "gps" });
    } catch (e) {
      const saved = store.get("lastPlace", null);
      if (initial && saved && typeof saved.lat === "number") {
        await setLocation({ ...saved, source: "manual" });
        toast("현재 위치를 못 가져와서 지난번 지역으로 보여드려요");
      } else {
        updateLocLabel();
        showPlaceForm(e && e.code === 1
          ? "위치 권한이 꺼져 있어요. 지역이나 역 이름으로 찾아 주세요."
          : "현재 위치를 가져오지 못했어요. 지역이나 역 이름으로 찾아 주세요.");
        if (!S.loc) setWeatherMsg("어디 근처인지 알려 주세요 👇");
      }
    }
  }

  async function geocode(q) {
    try {
      const k = await loadKakao();
      return await new Promise((res, rej) => {
        new k.maps.services.Places().keywordSearch(q, (d, st) => {
          if (st === k.maps.services.Status.OK) res({ lat: +d[0].y, lng: +d[0].x, label: d[0].place_name });
          else if (st === k.maps.services.Status.ZERO_RESULT) res(null);
          else rej(new Error("search"));
        }, { size: 1 });
      });
    } catch (e) {
      // 카카오를 못 쓰면 Open-Meteo 지명 검색으로 대신
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ko&countryCode=KR&name=" + encodeURIComponent(q.replace(/역$/, "")));
      const j = await r.json();
      const g = j.results && j.results[0];
      return g ? { lat: g.latitude, lng: g.longitude, label: g.name } : null;
    }
  }

  // ---------- 식당 목록 ----------
  let curMenu = null, map = null, overlays = [];

  async function openMenu(name) {
    curMenu = name;
    const menu = findMenu(name);
    $("#menuTitle").textContent = `${name} 근처 식당`;
    $("#menuPrefs").replaceChildren(...prefButtons(name, true));
    updateEatBtn();
    const list = $("#placeList"), sum = $("#placeSummary"), box = $("#mapBox");
    list.replaceChildren();
    box.hidden = true;

    const fallbackLink = h("a", { class: "btn big", href: "https://map.kakao.com/link/search/" + encodeURIComponent(menu.q || name), target: "_blank", rel: "noopener" }, `카카오맵에서 ‘${name}’ 검색`);
    if (!S.loc) {
      sum.replaceChildren("위치를 먼저 정해 주세요. ", h("a", { href: "#", onclick: e => { e.preventDefault(); go(""); showPlaceForm(); } }, "위치 정하기"));
      return;
    }
    if (S.kakaoDown) {
      sum.replaceChildren($("#notice").textContent || "지금은 식당 검색을 할 수 없어요.");
      list.append(h("li", null, fallbackLink));
      return;
    }
    sum.textContent = "근처 식당을 찾고 있어요…";
    try {
      const r = await searchPlaces(menu);
      if (curMenu !== name) return;
      const updateRec = S.recs.find(x => x.menu.name === name);
      if (updateRec) { updateRec.count = r.total; renderRecs(); }
      if (!r.places.length) {
        sum.replaceChildren(`반경 ${radiusLabel(P.radius)} 안에 ‘${name}’ 식당이 없어요. `,
          P.radius < 3000 ? h("a", { href: "#settings" }, "반경을 넓혀보세요") : "");
        return;
      }
      sum.textContent = `반경 ${radiusLabel(P.radius)} 안 ${countLabel(r.total)} · 가까운 순` + (r.total > r.places.length ? ` ${r.places.length}곳 표시` : "");
      r.places.forEach((p, i) => list.append(placeEl(p, i)));
      showMap(r.places);
    } catch (e) {
      if (curMenu !== name) return;
      kakaoFail(e);
      sum.textContent = $("#notice").textContent;
      list.append(h("li", null, fallbackLink));
    }
  }

  function placeEl(p, i) {
    const cat = (p.category_name || "").split(">").map(s => s.trim()).slice(1).join(" · ");
    const addr = p.road_address_name || p.address_name;
    const route = `https://map.kakao.com/link/to/${encodeURIComponent(p.place_name)},${p.y},${p.x}`;
    return h("li", { class: "place", id: "pl-" + i },
      h("div", { class: "place-head", onclick: () => focusPlace(i, false) },
        h("span", { class: "num", "aria-hidden": "true" }, String(i + 1)),
        h("div", null, h("h2", { class: "place-name" }, p.place_name), cat ? h("span", { class: "place-cat" }, cat) : null),
        p.distance ? h("span", { class: "place-dist" }, distLabel(+p.distance)) : null),
      h("div", { class: "place-info" },
        addr ? h("p", null, addr) : null,
        p.phone ? h("p", null, h("a", { href: "tel:" + p.phone.replace(/[^0-9+]/g, "") }, "☎ " + p.phone)) : null),
      h("div", { class: "place-links" },
        h("a", { class: "btn", href: p.place_url, target: "_blank", rel: "noopener" }, "카카오맵에서 보기"),
        h("a", { class: "btn primary", href: route, target: "_blank", rel: "noopener" }, "길찾기")));
  }

  // 지도는 식당 목록을 볼 때만 만든다 (데이터·호출 절약)
  function showMap(places) {
    const k = window.kakao, box = $("#mapBox");
    if (!k || !k.maps) return;
    box.hidden = false;
    const me = new k.maps.LatLng(S.loc.lat, S.loc.lng);
    if (!map) {
      map = new k.maps.Map(box, { center: me, level: 5 });
      map.addControl(new k.maps.ZoomControl(), k.maps.ControlPosition.RIGHT);
    } else map.relayout();
    overlays.forEach(o => o.setMap(null));
    overlays = [new k.maps.CustomOverlay({ position: me, content: h("div", { class: "me-dot", title: "내 위치" }), zIndex: 3 })];
    const bounds = new k.maps.LatLngBounds();
    bounds.extend(me);
    places.forEach((p, i) => {
      const pos = new k.maps.LatLng(+p.y, +p.x);
      bounds.extend(pos);
      const el = h("div", { class: "pin", id: "pin-" + i, title: p.place_name }, String(i + 1));
      el.addEventListener("click", () => focusPlace(i, true));
      overlays.push(new k.maps.CustomOverlay({ position: pos, content: el, zIndex: 2 }));
    });
    overlays.forEach(o => o.setMap(map));
    map.setBounds(bounds, 30, 30, 30, 30);
  }

  function focusPlace(i, scroll) {
    document.querySelectorAll(".place.hl, .pin.hl").forEach(e => e.classList.remove("hl"));
    const item = $("#pl-" + i), pin = $("#pin-" + i);
    if (item) { item.classList.add("hl"); if (scroll) item.scrollIntoView({ behavior: "smooth", block: "center" }); }
    if (pin) pin.classList.add("hl");
    if (!scroll && map && overlays[i + 1]) map.panTo(overlays[i + 1].getPosition());
  }

  function updateEatBtn() {
    const b = $("#eatBtn"), on = eatenToday(curMenu);
    b.classList.toggle("done", on);
    b.classList.toggle("primary", !on);
    b.textContent = on ? "✓ 오늘 먹기로 했어요" : "✓ 오늘 이거 먹을래요";
    b.setAttribute("aria-pressed", String(on));
  }

  // ---------- 내 메뉴 ----------
  let editId = null;

  function renderAddConds(selected = []) {
    $("#addConds").replaceChildren(...CONDS.map(c => h("label", { class: "chip" },
      h("input", { type: "checkbox", name: "cond", value: c.id, checked: selected.includes(c.id) }),
      `${c.emoji} ${c.label}`, c.range ? h("small", null, c.range) : null)));
  }

  function renderMy() {
    // 최근 먹은 메뉴
    const from = startOfDay(-2), today = startOfDay(), yday = startOfDay(-1);
    const recent = P.eaten.filter(e => e.at >= from).sort((a, b) => b.at - a.at);
    $("#recentBox").replaceChildren(...(recent.length ? [h("section", { class: "cond-group" },
      h("h2", null, "최근 먹은 메뉴", h("small", null, "3일간 추천에서 빠져요")),
      h("ul", { class: "my-rows" }, recent.map(e => h("li", { class: "my-row" },
        h("span", { class: "my-name" }, e.name, h("span", { class: "tag" }, e.at >= today ? "오늘" : e.at >= yday ? "어제" : "그제")),
        h("button", {
          class: "mini", type: "button", "aria-label": `${e.name} 먹은 기록 지우기`,
          onclick: () => { P.eaten = P.eaten.filter(x => x !== e); store.set("eaten", P.eaten); renderMy(); },
        }, "기록 지우기")))))] : []));

    // 날씨별 전체 메뉴
    const menus = allMenus();
    $("#myList").replaceChildren(...CONDS.map(c => {
      const items = menus.filter(m => m.conds.includes(c.id));
      if (!items.length) return null;
      return h("section", { class: "cond-group" },
        h("h2", null, `${c.emoji} ${c.label}`, c.range ? h("small", null, c.range) : null),
        h("ul", { class: "my-rows" }, items.map(m => {
          const custom = P.custom.find(x => x.id === m.customId);
          return h("li", { class: "my-row" },
            h("span", { class: "my-name" + (P.nopes.has(m.name) ? " is-nope" : "") }, m.name,
              custom ? h("span", { class: "tag" }, "내 메뉴") : null),
            custom ? h("button", { class: "mini", type: "button", "aria-label": `${m.name} 수정`, onclick: () => startEdit(custom) }, "수정") : null,
            custom ? h("button", { class: "mini", type: "button", "aria-label": `${m.name} 삭제`, onclick: () => deleteCustom(custom) }, "삭제") : null,
            prefButtons(m.name, true));
        })));
    }).filter(Boolean));
  }

  function startEdit(c) {
    editId = c.id;
    $("#addBox").open = true;
    $("#addName").value = c.name;
    renderAddConds(c.conds);
    $("#addSave").textContent = "저장";
    $("#addCancel").hidden = false;
    $("#addErr").hidden = true;
    $("#addBox").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function resetAddForm() {
    editId = null;
    $("#addForm").reset();
    renderAddConds();
    $("#addSave").textContent = "추가";
    $("#addCancel").hidden = true;
    $("#addErr").hidden = true;
  }
  function saveCustom() { store.set("custom", P.custom); }
  function deleteCustom(c) {
    const i = P.custom.indexOf(c);
    if (i < 0) return;
    P.custom.splice(i, 1);
    saveCustom();
    if (editId === c.id) resetAddForm();
    renderMy();
    toast(`‘${c.name}’을(를) 삭제했어요`, "되돌리기", () => { P.custom.splice(i, 0, c); saveCustom(); renderMy(); });
  }

  // ---------- 설정 ----------
  function renderSettings() {
    $("#radiusChips").replaceChildren(...RADII.map(r => h("button", {
      type: "button", role: "radio", "aria-checked": String(r === P.radius),
      onclick: () => setRadius(r),
    }, radiusLabel(r))));
    updateLocLabel();
    const key = ((window.APP_CONFIG || {}).KAKAO_JS_KEY || "");
    $("#keyState").textContent = !key || key.includes("여기에") ? "카카오 키: 아직 설정 안 됨 (config.js)" : "카카오 키: 설정됨";
  }
  function setRadius(r) {
    if (r === P.radius) return;
    P.radius = r;
    store.set("radius", r);
    renderSettings();
    toast(`검색 반경을 ${radiusLabel(r)}로 바꿨어요`);
    if (S.loc) recommend({ keep: S.recs.map(x => x.menu.name) });
  }

  // ---------- 화면 전환 ----------
  let inAppNav = 0;
  function go(hash) {
    inAppNav++;
    location.hash = hash;
  }
  function route() {
    const hs = location.hash;
    let view = "home";
    if (hs.startsWith("#menu/")) view = "menu";
    else if (hs === "#my") view = "my";
    else if (hs === "#settings") view = "settings";
    for (const v of ["home", "menu", "my", "settings"]) $("#view-" + v).hidden = v !== view;
    document.body.classList.toggle("sub", view === "menu");
    document.querySelectorAll(".tabbar a").forEach(a => {
      if (a.dataset.tab === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    closeSheet();
    if (view !== "home") window.scrollTo(0, 0);
    if (view === "menu") openMenu(decodeURIComponent(hs.slice(6)));
    else curMenu = null;
    if (view === "my") renderMy();
    if (view === "settings") renderSettings();
  }

  // ---------- 이벤트 ----------
  $("#againBtn").addEventListener("click", () => {
    if (!S.loc) return showPlaceForm();
    recommend({ avoid: S.recs.map(r => r.menu.name) });
  });
  $("#pickBtn").addEventListener("click", spin);
  $("#sheetAgain").addEventListener("click", () => { closeSheet(); spin(); });
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

  $("#locBtn").addEventListener("click", () => showPlaceForm());
  $("#setLocBtn").addEventListener("click", () => { go(""); showPlaceForm(); });
  $("#useGpsBtn").addEventListener("click", () => locateByGps(false));
  $("#placeCancel").addEventListener("click", hidePlaceForm);
  $("#placeForm").addEventListener("submit", async e => {
    e.preventDefault();
    const q = $("#placeInput").value.trim();
    if (!q) return;
    const btn = e.submitter || $("#placeForm .btn.primary");
    btn.disabled = true;
    $("#placeHint").textContent = `‘${q}’을(를) 찾고 있어요…`;
    try {
      const loc = await geocode(q);
      if (!loc) { $("#placeHint").textContent = `‘${q}’을(를) 찾지 못했어요. 다른 이름으로 입력해 보세요.`; return; }
      hidePlaceForm();
      $("#placeInput").value = "";
      await setLocation({ ...loc, source: "manual" });
    } catch (err) {
      $("#placeHint").textContent = "지역을 찾지 못했어요. 인터넷 연결을 확인해 주세요.";
    } finally { btn.disabled = false; }
  });

  $("#backBtn").addEventListener("click", () => { if (inAppNav > 0) { inAppNav--; history.back(); } else go(""); });
  $("#eatBtn").addEventListener("click", () => {
    const on = !eatenToday(curMenu);
    setEaten(curMenu, on);
    updateEatBtn();
    toast(on ? `오늘은 ‘${curMenu}’! 3일 동안은 추천에서 빼둘게요` : "먹은 기록을 지웠어요");
  });

  $("#addForm").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("#addName").value.trim().replace(/\s+/g, " ");
    const conds = [...document.querySelectorAll('#addConds input:checked')].map(i => i.value);
    const err = $("#addErr");
    if (!name) return;
    if (!conds.length) { err.textContent = "어울리는 날씨를 하나 이상 골라 주세요."; err.hidden = false; return; }
    const dup = P.custom.find(c => c.name === name && c.id !== editId);
    if (editId) {
      const c = P.custom.find(x => x.id === editId);
      if (dup) { err.textContent = "같은 이름의 내 메뉴가 이미 있어요."; err.hidden = false; return; }
      if (c) { c.name = name; c.conds = conds; }
      toast(`‘${name}’을(를) 고쳤어요`);
    } else if (dup) {
      dup.conds = [...new Set([...dup.conds, ...conds])];
      toast(`‘${name}’에 날씨를 더했어요`);
    } else {
      P.custom.push({ id: "c" + Date.now().toString(36), name, conds });
      toast(`‘${name}’을(를) 추가했어요`);
    }
    saveCustom();
    resetAddForm();
    $("#addBox").open = false;
    renderMy();
  });
  $("#addCancel").addEventListener("click", resetAddForm);

  window.addEventListener("hashchange", route);

  // 오래 켜 두었다가 다시 열면 날씨를 새로 받는다
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.loadedAt && Date.now() - S.loadedAt > 60 * 60 * 1000 && S.loc) {
      if (S.loc.source === "gps") locateByGps(false); else setLocation(S.loc);
    }
  });

  // ---------- 시작 ----------
  renderAddConds();
  renderSettings();
  route();
  loadKakao().catch(e => { if (e.kind === "nokey") kakaoFail(e); });
  locateByGps(true);

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
