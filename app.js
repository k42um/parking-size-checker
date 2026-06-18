/* 駐車場 広さ判定 & 駐車シミュレーター
 * Google Maps JavaScript API (geometry) を使用。図形描画・検索はクリック/Geocoderで自前実装。
 */

"use strict";

// ---------- 判定の基準値（普通車・日本の一般的な区画を想定, 単位: m） ----------
const THRESHOLDS = {
  stallWidth:  { narrow: 2.3, wide: 2.55 },  // 標準 2.5m
  stallLength: { narrow: 4.7, wide: 5.3 },   // 標準 5.0m
  roadWidth:   { narrow: 5.0, wide: 6.0 },   // 90度駐車で必要な通路幅 5.5〜6m
};

const COLORS = {
  stall: "#1e88e5",
  aisle: "#fb8c00",
  width: "#e53935",
  entrance: "#43a047",
  route: "#8e24aa",
};

// ---------- アプリ状態 ----------
const state = {
  map: null,
  mode: "none",
  draw: { active: null, points: [], preview: null, dots: [] }, // 自前描画の作業状態
  stalls: [],        // { polygon, label, marker, id }
  aisle: null,       // google.maps.Polyline
  widthLine: null,   // google.maps.Polyline (2点)
  entrance: null,    // google.maps.Marker
  route: null,       // google.maps.Polyline
  car: null,         // google.maps.Marker
  routePath: null,   // LatLng[]
  anim: null,        // requestAnimationFrame id
  stallSeq: 0,
};

// ===================================================================
// 地図の読み込み
// ===================================================================
document.getElementById("loadMapBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKey").value.trim();
  if (!key) {
    alert("Google Maps の APIキーを入力してください。");
    return;
  }
  if (window.google && window.google.maps) {
    initMap();
    return;
  }
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry,places&v=weekly&loading=async&callback=__initMap`;
  s.async = true;
  s.onerror = () => alert("地図の読み込みに失敗しました。APIキーや有効化状況を確認してください。");
  window.__initMap = initMap;
  document.head.appendChild(s);
});

function initMap() {
  document.getElementById("map-placeholder").style.display = "none";

  state.map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.681236, lng: 139.767125 }, // 東京駅
    zoom: 19,
    mapTypeId: "satellite",
    tilt: 0,
    rotateControl: true,
    streetViewControl: false,
    fullscreenControl: true,
    gestureHandling: "greedy",
  });

  // 各セットアップは独立させ、1つが失敗しても他（特に検索欄の有効化）が止まらないようにする
  safeSetup("検索", setupSearch);
  safeSetup("描画ツール", setupDrawingManager);
  safeSetup("モード切替", setupModeButtons);
  safeSetup("シミュレーション", setupSimulation);

  document.getElementById("clearBtn").addEventListener("click", clearAll);
}

function safeSetup(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[${name}] の初期化に失敗:`, err);
  }
}

// ===================================================================
// 検索（Google Places API (New) / PlaceAutocompleteElement）
// ===================================================================
// 施設名・ランドマーク・住所のサジェスト検索。Places API (New) の有効化が必要。
async function setupSearch() {
  const container = document.getElementById("searchContainer");
  const placesLib = await google.maps.importLibrary("places");
  if (!placesLib || !placesLib.PlaceAutocompleteElement) {
    throw new Error("PlaceAutocompleteElement が利用できません（Places API (New) を確認）");
  }

  const pac = new placesLib.PlaceAutocompleteElement({ includedRegionCodes: ["jp"] });
  pac.id = "place-autocomplete";
  container.appendChild(pac);

  pac.addEventListener("gmp-select", (ev) => handlePlaceSelect(ev));
}

async function handlePlaceSelect(ev) {
  // イベント形状はバージョンで差があるため複数パターンに対応
  const pred = ev.placePrediction || (ev.detail && ev.detail.placePrediction);
  let place = ev.place || (ev.detail && ev.detail.place) ||
    (pred && typeof pred.toPlace === "function" && pred.toPlace());

  if (!place) {
    console.error("gmp-select に place がありません:", ev);
    alert("候補から場所情報を取得できませんでした（イベント形状不一致）。コンソールを確認してください。");
    return;
  }

  try {
    // まず viewport を含めて取得。フィールドエラー時は location のみで再試行
    try {
      await place.fetchFields({ fields: ["location", "viewport"] });
    } catch (fieldErr) {
      console.warn("viewport 取得不可。location のみで再試行:", fieldErr);
      await place.fetchFields({ fields: ["location"] });
    }
    if (!place.location) throw new Error("location が空");
    moveTo(place.location, place.viewport || null);
  } catch (e) {
    console.error("場所の取得に失敗:", e);
    alert("場所の取得に失敗しました（" + (e && e.message ? e.message : e) +
      "）。\nPlaces API (New) が有効か、キーのAPI制限に Places API (New) が含まれるか確認してください。");
  }
}

function moveTo(location, viewport) {
  if (viewport) {
    state.map.fitBounds(viewport);
    if (state.map.getZoom() < 19) state.map.setZoom(20);
  } else {
    state.map.setCenter(location);
    state.map.setZoom(20);
  }
}

// ===================================================================
// 描画コントローラ（Maps JS API v3.65 で DrawingManager が廃止されたため自前実装）
// ===================================================================
const DRAW_TIPS = {
  stall: "区画の四隅を順にクリック → ダブルクリック / 右クリック / Enter で確定（Esc取消）。確定後そのまま次の区画を描けます。",
  aisle: "通路の中心に沿ってクリック → ダブルクリック / Enter で確定（Esc取消）。",
  width: "道（通路）を横切るように2点をクリックすると自動で確定します。",
  entrance: "入口の位置をクリックしてください。",
};

function setupDrawingManager() {
  state.map.setOptions({ disableDoubleClickZoom: true });

  state.map.addListener("click", (e) => onDrawClick(e.latLng));
  state.map.addListener("dblclick", () => finishDrawing());
  state.map.addListener("rightclick", () => finishDrawing());
  state.map.addListener("mousemove", (e) => onDrawMove(e.latLng));

  document.addEventListener("keydown", (e) => {
    if (!state.draw.active) return;
    if (e.key === "Enter") finishDrawing();
    else if (e.key === "Escape") cancelDrawing();
  });
}

function onDrawClick(latLng) {
  const m = state.draw.active;
  if (!m) return;
  if (m === "entrance") {
    setEntrance(new google.maps.Marker({ position: latLng, map: state.map }));
    recompute();
    setMode("none");
    return;
  }
  state.draw.points.push(latLng);
  addVertexDot(latLng);
  updatePreview(latLng);
  if (m === "width" && state.draw.points.length >= 2) finishDrawing();
}

function onDrawMove(latLng) {
  if (!state.draw.active || state.draw.active === "entrance") return;
  if (state.draw.points.length === 0) return;
  updatePreview(latLng);
}

function updatePreview(cursor) {
  const pts = state.draw.points.slice();
  if (cursor) pts.push(cursor);
  if (!state.draw.preview) {
    state.draw.preview = new google.maps.Polyline({
      map: state.map,
      clickable: false, // クリックを地図に通す
      strokeColor: COLORS[state.draw.active] || "#fff",
      strokeWeight: 2, strokeOpacity: 0.85, zIndex: 9,
    });
  }
  state.draw.preview.setPath(pts);
}

function addVertexDot(latLng) {
  state.draw.dots.push(new google.maps.Marker({
    position: latLng, map: state.map, clickable: false, zIndex: 9,
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 4,
      fillColor: COLORS[state.draw.active] || "#fff", fillOpacity: 1,
      strokeColor: "#fff", strokeWeight: 1,
    },
  }));
}

function clearDrawTemp() {
  if (state.draw.preview) { state.draw.preview.setMap(null); state.draw.preview = null; }
  state.draw.dots.forEach((d) => d.setMap(null));
  state.draw.dots = [];
  state.draw.points = [];
}

function cancelDrawing() {
  clearDrawTemp();
  setMode("none");
}

function finishDrawing() {
  const m = state.draw.active;
  if (!m || m === "entrance") return;
  const pts = dedupeLatLng(state.draw.points);

  if (m === "stall") {
    if (pts.length >= 3) {
      addStall(new google.maps.Polygon({
        paths: pts, map: state.map,
        fillColor: COLORS.stall, fillOpacity: 0.25,
        strokeColor: COLORS.stall, strokeWeight: 2, editable: true, zIndex: 2,
      }));
    }
    clearDrawTemp();          // 連続描画のため active は 'stall' のまま
    recompute();
    return;
  }

  if (m === "aisle" && pts.length >= 2) {
    setAisle(new google.maps.Polyline({
      path: pts, map: state.map,
      strokeColor: COLORS.aisle, strokeWeight: 4, editable: true, zIndex: 3,
    }));
  } else if (m === "width" && pts.length >= 2) {
    setWidthLine(new google.maps.Polyline({
      path: [pts[0], pts[pts.length - 1]], map: state.map,
      strokeColor: COLORS.width, strokeWeight: 3, editable: true, zIndex: 4,
    }));
  }
  clearDrawTemp();
  recompute();
  setMode("none");
}

function dedupeLatLng(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || sph().computeDistanceBetween(last, p) > 0.5) out.push(p);
  }
  return out;
}

// ===================================================================
// モード切替
// ===================================================================
function setupModeButtons() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
}

function setMode(mode) {
  clearDrawTemp(); // 進行中の描画を破棄
  state.mode = mode;
  state.draw.active = mode === "none" ? null : mode;

  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );

  // 描画中はカーソルを常に十字に固定し、既存図形のクリック奪取を無効化（点を確実に打てるように）
  const drawing = !!state.draw.active;
  state.map.setOptions({
    draggableCursor: drawing ? "crosshair" : null,
    draggingCursor: drawing ? "crosshair" : null,
  });
  setOverlaysClickable(!drawing);

  const tip = document.getElementById("draw-tip");
  if (tip) {
    const text = DRAW_TIPS[mode];
    tip.textContent = text || "";
    tip.style.display = text ? "block" : "none";
  }
}

// 描画中は既存図形を非クリックにし、地図クリック（＝点の追加）を妨げないようにする。
// 描画していない時は元に戻し、区画クリックでの選択を有効化する。
function setOverlaysClickable(clickable) {
  state.stalls.forEach((s) => s.polygon.setOptions({ clickable }));
  if (state.aisle) state.aisle.setOptions({ clickable });
  if (state.widthLine) state.widthLine.setOptions({ clickable });
  if (state.entrance) state.entrance.setOptions({ clickable });
  if (state.route) state.route.setOptions({ clickable });
}

// ===================================================================
// 各要素の登録
// ===================================================================
function addStall(polygon) {
  const id = ++state.stallSeq;
  const center = polygonCentroid(polygon);
  const marker = new google.maps.Marker({
    position: center,
    map: state.map,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0, },
    label: { text: `P${id}`, className: "stall-label", color: "#fff", fontSize: "11px" },
    clickable: false,
  });
  const stall = { id, polygon, marker };
  state.stalls.push(stall);

  polygon.addListener("click", () => selectStall(id));
  ["set_at", "insert_at", "remove_at"].forEach((ev) => {
    polygon.getPath().addListener(ev, () => {
      stall.marker.setPosition(polygonCentroid(polygon));
      recompute();
    });
  });
  // 区画を連続描画中は、追加直後の区画もクリックを奪わないようにする
  if (state.draw.active) polygon.setOptions({ clickable: false });
  refreshStallSelect();
}

function setAisle(polyline) {
  if (state.aisle) state.aisle.setMap(null);
  state.aisle = polyline;
  ["set_at", "insert_at", "remove_at"].forEach((ev) =>
    polyline.getPath().addListener(ev, recompute)
  );
}

function setWidthLine(polyline) {
  if (state.widthLine) state.widthLine.setMap(null);
  // 始点・終点の2点に切り詰める
  const path = polyline.getPath();
  if (path.getLength() > 2) {
    const first = path.getAt(0);
    const last = path.getAt(path.getLength() - 1);
    polyline.setPath([first, last]);
  }
  state.widthLine = polyline;
  ["set_at", "insert_at", "remove_at"].forEach((ev) =>
    polyline.getPath().addListener(ev, recompute)
  );
}

function setEntrance(marker) {
  if (state.entrance) state.entrance.setMap(null);
  marker.setOptions({
    draggable: true,
    label: { text: "入口", color: "#fff", fontSize: "11px", fontWeight: "bold" },
    icon: {
      path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
      scale: 6, fillColor: COLORS.entrance, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 1,
    },
  });
  state.entrance = marker;
  marker.addListener("dragend", recompute);
}

// ===================================================================
// 計測・判定
// ===================================================================
function recompute() {
  const widths = [];
  const lengths = [];
  state.stalls.forEach((s) => {
    const dim = stallDimensions(s.polygon);
    if (dim) { widths.push(dim.width); lengths.push(dim.length); }
  });

  const avgW = widths.length ? avg(widths) : null;
  const avgL = lengths.length ? avg(lengths) : null;
  const roadW = state.widthLine ? polylineLength(state.widthLine) : null;

  setText("mStallWidth", avgW != null ? `${avgW.toFixed(2)} m` : "—");
  setText("mStallLength", avgL != null ? `${avgL.toFixed(2)} m` : "—");
  setText("mRoadWidth", roadW != null ? `${roadW.toFixed(2)} m` : "—");
  setText("mStallCount", String(state.stalls.length));

  updateVerdict(avgW, avgL, roadW);
}

function classify(value, t) {
  if (value == null) return null;
  if (value < t.narrow) return -1;
  if (value > t.wide) return 1;
  return 0;
}

function updateVerdict(avgW, avgL, roadW) {
  const el = document.getElementById("verdict");
  const detail = document.getElementById("verdictDetail");
  detail.innerHTML = "";

  const items = [
    { key: "区画の幅",   value: avgW,  t: THRESHOLDS.stallWidth,  weight: 1.0 },
    { key: "区画の奥行", value: avgL,  t: THRESHOLDS.stallLength, weight: 0.5 },
    { key: "道幅(通路)", value: roadW, t: THRESHOLDS.roadWidth,   weight: 1.2 },
  ];

  let scoreSum = 0, weightSum = 0, measured = 0;
  items.forEach((it) => {
    const c = classify(it.value, it.t);
    const li = document.createElement("li");
    let tag = "未計測", cls = "";
    if (c !== null) {
      measured++;
      scoreSum += c * it.weight;
      weightSum += it.weight;
      if (c < 0) { tag = "狭め"; cls = "tag-narrow"; }
      else if (c > 0) { tag = "広め"; cls = "tag-wide"; }
      else { tag = "ふつう"; cls = "tag-normal"; }
    }
    li.innerHTML = `<span>${it.key}${it.value != null ? `（${it.value.toFixed(2)}m）` : ""}</span><span class="tag ${cls}">${tag}</span>`;
    detail.appendChild(li);
  });

  if (measured === 0) {
    el.textContent = "未計測";
    el.className = "verdict verdict-unknown";
    return;
  }

  const norm = scoreSum / weightSum; // -1〜+1
  if (norm <= -0.34) {
    el.textContent = "狭め";
    el.className = "verdict verdict-narrow";
  } else if (norm >= 0.34) {
    el.textContent = "広め";
    el.className = "verdict verdict-wide";
  } else {
    el.textContent = "ふつう";
    el.className = "verdict verdict-normal";
  }
}

// ===================================================================
// シミュレーション
// ===================================================================
function setupSimulation() {
  document.getElementById("simulateBtn").addEventListener("click", simulate);
  document.getElementById("playBtn").addEventListener("click", playAnimation);
  refreshStallSelect();
}

function refreshStallSelect() {
  const sel = document.getElementById("targetStall");
  const prev = sel.value;
  sel.innerHTML = "";
  if (state.stalls.length === 0) {
    const o = document.createElement("option");
    o.textContent = "（区画なし）";
    o.value = "";
    sel.appendChild(o);
    return;
  }
  state.stalls.forEach((s) => {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = `P${s.id}`;
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
}

function selectStall(id) {
  document.getElementById("targetStall").value = String(id);
  state.stalls.forEach((s) =>
    s.polygon.setOptions({ strokeWeight: s.id === id ? 4 : 2 })
  );
}

function simulate() {
  const info = document.getElementById("simInfo");
  if (!state.entrance) { info.textContent = "⚠ 入口を置いてください。"; return; }
  if (!state.aisle || state.aisle.getPath().getLength() < 2) {
    info.textContent = "⚠ 通路の中心線を描いてください。"; return;
  }
  const id = parseInt(document.getElementById("targetStall").value, 10);
  const stall = state.stalls.find((s) => s.id === id);
  if (!stall) { info.textContent = "⚠ 対象の区画を選んでください。"; return; }
  selectStall(id);

  const ref = state.entrance.getPosition();
  const aislePts = pathToXY(state.aisle.getPath(), ref);
  const entranceXY = toXY(ref, ref);

  // 入口 → 通路 への合流点
  const entryProj = projectOntoPath(entranceXY, aislePts);
  // 区画 → 通路 への分岐点
  const stallCenter = polygonCentroid(stall.polygon);
  const stallCenterXY = toXY(stallCenter, ref);
  const exitProj = projectOntoPath(stallCenterXY, aislePts);

  // 通路に沿って合流点→分岐点を辿る
  const along = walkAlong(aislePts, entryProj, exitProj);

  // 区画の「入口側エッジ」中点（通路に最も近い辺）
  const mouthXY = stallMouth(stall.polygon, exitProj.point, ref);

  const pathXY = [entranceXY, entryProj.point, ...along, exitProj.point, mouthXY, stallCenterXY];
  const dedup = dedupePath(pathXY);
  const pathLatLng = dedup.map((p) => toLatLng(p, ref));

  // 描画
  if (state.route) state.route.setMap(null);
  state.route = new google.maps.Polyline({
    path: pathLatLng,
    map: state.map,
    strokeColor: COLORS.route,
    strokeWeight: 5,
    strokeOpacity: 0.9,
    zIndex: 5,
    icons: [{
      icon: { path: google.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 3, strokeColor: "#fff" },
      offset: "0",
      repeat: "60px",
    }],
  });
  state.routePath = pathLatLng;

  const total = polylinePathLength(pathLatLng);
  const aisleDist = segLength(along.length ? along : [entryProj.point, exitProj.point]);
  info.innerHTML = `経路: 入口 → 通路（約${aisleDist.toFixed(0)}m）→ <b>P${id}</b><br>総距離: 約 ${total.toFixed(0)} m / 推奨: 区画手前で減速しハンドルを切って後退駐車。`;

  document.getElementById("playBtn").disabled = false;

  // 経路全体が見えるよう調整
  const bounds = new google.maps.LatLngBounds();
  pathLatLng.forEach((p) => bounds.extend(p));
  state.map.fitBounds(bounds, 80);
}

function playAnimation() {
  if (!state.routePath || state.routePath.length < 2) return;
  if (state.anim) cancelAnimationFrame(state.anim);

  if (!state.car) {
    state.car = new google.maps.Marker({
      map: state.map,
      zIndex: 6,
      icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5,
        fillColor: COLORS.route, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 1 },
    });
  }
  state.car.setMap(state.map);

  // 各頂点までの累積距離
  const pts = state.routePath;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + google.maps.geometry.spherical.computeDistanceBetween(pts[i - 1], pts[i]));
  }
  const total = cum[cum.length - 1];
  const durationMs = Math.max(2500, total * 250); // 約 4km/h 換算
  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const dist = t * total;
    let i = 1;
    while (i < cum.length && cum[i] < dist) i++;
    const segStart = pts[i - 1], segEnd = pts[i] || pts[i - 1];
    const segLen = cum[i] - cum[i - 1] || 1;
    const f = (dist - cum[i - 1]) / segLen;
    const pos = google.maps.geometry.spherical.interpolate(segStart, segEnd, Math.min(1, Math.max(0, f)));
    state.car.setPosition(pos);
    const heading = google.maps.geometry.spherical.computeHeading(segStart, segEnd);
    state.car.setIcon({ ...state.car.getIcon(), rotation: heading });
    if (t < 1) state.anim = requestAnimationFrame(step);
  };
  state.anim = requestAnimationFrame(step);
}

// ===================================================================
// 全消去
// ===================================================================
function clearAll() {
  state.stalls.forEach((s) => { s.polygon.setMap(null); s.marker.setMap(null); });
  state.stalls = [];
  state.stallSeq = 0;
  if (state.aisle) state.aisle.setMap(null), (state.aisle = null);
  if (state.widthLine) state.widthLine.setMap(null), (state.widthLine = null);
  if (state.entrance) state.entrance.setMap(null), (state.entrance = null);
  if (state.route) state.route.setMap(null), (state.route = null);
  if (state.car) state.car.setMap(null), (state.car = null);
  if (state.anim) cancelAnimationFrame(state.anim);
  state.routePath = null;
  document.getElementById("playBtn").disabled = true;
  document.getElementById("simInfo").textContent = "";
  refreshStallSelect();
  recompute();
  setMode("none");
}

// ===================================================================
// 幾何ヘルパー
// ===================================================================
const sph = () => google.maps.geometry.spherical;

function polylineLength(line) {
  return polylinePathLength(line.getPath().getArray());
}
function polylinePathLength(arr) {
  let d = 0;
  for (let i = 1; i < arr.length; i++) d += sph().computeDistanceBetween(arr[i - 1], arr[i]);
  return d;
}

function polygonCentroid(polygon) {
  const path = polygon.getPath().getArray();
  let lat = 0, lng = 0;
  path.forEach((p) => { lat += p.lat(); lng += p.lng(); });
  return new google.maps.LatLng(lat / path.length, lng / path.length);
}

// 区画ポリゴンの 幅(短辺) と 奥行(長辺) を推定。
// 頂点の並び順・形状・点数に依存しないよう、最小面積の外接長方形(OBB)で測る。
function stallDimensions(polygon) {
  const pts = polygon.getPath().getArray();
  if (pts.length < 3) return null;
  const ref = pts[0];
  const xy = pts.map((p) => toXY(p, ref)); // 局所平面(メートル)へ
  const rect = minAreaRect(xy);
  if (!rect) return null;
  return { width: Math.min(rect.w, rect.h), length: Math.max(rect.w, rect.h) };
}

// 凸包（Andrew's monotone chain）
function convexHull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// 最小面積の外接長方形を回転キャリパー法で求め、2辺長 {w, h} を返す
function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length < 2) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len; // 辺方向
    const vx = -uy, vy = ux;                               // 直交方向
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pv = p.x * vx + p.y * vy;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const w = maxU - minU, h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area) best = { area, w, h };
  }
  return best;
}

// --- 平面（メートル）投影 ---
const R_EARTH = 6378137;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function toXY(latlng, ref) {
  return {
    x: (toRad(latlng.lng()) - toRad(ref.lng())) * Math.cos(toRad(ref.lat())) * R_EARTH,
    y: (toRad(latlng.lat()) - toRad(ref.lat())) * R_EARTH,
  };
}
function toLatLng(xy, ref) {
  const lat = toDeg(xy.y / R_EARTH + toRad(ref.lat()));
  const lng = toDeg(xy.x / (R_EARTH * Math.cos(toRad(ref.lat()))) + toRad(ref.lng()));
  return new google.maps.LatLng(lat, lng);
}
function pathToXY(mvcPath, ref) {
  return mvcPath.getArray().map((p) => toXY(p, ref));
}

// 点を折れ線に投影。最近点・どのセグメントか・セグメント内の位置を返す
function projectOntoPath(pt, pathPts) {
  let best = { dist: Infinity, point: pathPts[0], seg: 0, t: 0 };
  for (let i = 0; i < pathPts.length - 1; i++) {
    const a = pathPts[i], b = pathPts[i + 1];
    const r = projectPointOnSegment(pt, a, b);
    if (r.dist < best.dist) best = { dist: r.dist, point: r.point, seg: i, t: r.t };
  }
  return best;
}
function projectPointOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  const dist = Math.hypot(p.x - point.x, p.y - point.y);
  return { point, dist, t };
}

// 折れ線上を proj1 → proj2 まで辿る中間頂点列
function walkAlong(pathPts, proj1, proj2) {
  let s1 = proj1.seg, s2 = proj2.seg;
  const out = [];
  if (s1 === s2) return out; // 同一セグメント内: 中間頂点なし
  if (s1 < s2) {
    for (let i = s1 + 1; i <= s2; i++) out.push(pathPts[i]);
  } else {
    for (let i = s1; i > s2; i--) out.push(pathPts[i]);
  }
  return out;
}

// 区画の「通路に面した辺」の中点
function stallMouth(polygon, aislePointXY, ref) {
  const pts = polygon.getPath().getArray().map((p) => toXY(p, ref));
  let best = { dist: Infinity, mid: pts[0] };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(mid.x - aislePointXY.x, mid.y - aislePointXY.y);
    if (d < best.dist) best = { dist: d, mid };
  }
  return best.mid;
}

function dedupePath(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.3) out.push(p);
  }
  return out;
}
function segLength(xyPts) {
  let d = 0;
  for (let i = 1; i < xyPts.length; i++) d += Math.hypot(xyPts[i].x - xyPts[i - 1].x, xyPts[i].y - xyPts[i - 1].y);
  return d;
}

// ---------- 雑用 ----------
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
function setText(id, txt) { document.getElementById(id).textContent = txt; }
