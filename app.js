// ブラウザ内に釣果、釣行、ルアーを保存するシンプルなアプリです。
const STORAGE_KEY = "seabass-log-data-v1";

// ルアー情報の保存形式をそろえ、名前だけの旧データも引き継ぎます。
function normalizeLure(lure) {
  if (typeof lure === "string") {
    return {
      id: crypto.randomUUID(), manufacturer: "", name: lure, type: "",
      action: "", weight: "", color: "", shallowRange: "", deepRange: ""
    };
  }
  return {
    id: lure.id || crypto.randomUUID(),
    manufacturer: String(lure.manufacturer || ""),
    name: String(lure.name || ""),
    type: String(lure.type || ""),
    action: String(lure.action || ""),
    weight: String(lure.weight || ""),
    color: String(lure.color || ""),
    shallowRange: String(lure.shallowRange || ""),
    deepRange: String(lure.deepRange || "")
  };
}

// 保存データを読み込み、見つからない場合は空のデータを用意します。
function loadData() {
  try {
    const savedData = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      catches: Array.isArray(savedData?.catches) ? savedData.catches : [],
      trips: Array.isArray(savedData?.trips) ? savedData.trips : [],
      lures: Array.isArray(savedData?.lures) ? savedData.lures.map(normalizeLure).filter((lure) => lure.name) : []
    };
  } catch (error) {
    return { catches: [], trips: [], lures: [] };
  }
}

const data = loadData();
const catchForm = document.querySelector("#catch-form");
const toast = document.querySelector("#toast");
let toastTimer;
let tideStationsPromise;
let editingCatchId = "";

// JavaScriptで作る日時を、datetime-local入力欄の形式に整えます。
function localDateTime(date = new Date()) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (error) {
    showToast("保存できませんでした。写真のサイズや空き容量を確認してください。");
    return false;
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

// 方位角を、入力欄で使う8方位の名前に変換します。
function windDirectionName(degrees) {
  const directions = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  return directions[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

// 気象庁の潮位観測所一覧から、座標に最も近い観測所を探します。
async function findNearestTideStation(latitude, longitude) {
  if (!tideStationsPromise) {
    tideStationsPromise = fetch("https://www.jma.go.jp/bosai/tidelevel/const/tide_area.json")
      .then((response) => {
        if (!response.ok) throw new Error("潮位観測所一覧を取得できません");
        return response.json();
      })
      .then((areas) => Object.values(areas).flatMap((area) =>
        (area.class30s ?? []).flatMap((region) => region.stations ?? [])
      ).filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lon) && !station.missing))
      .catch((error) => {
        tideStationsPromise = undefined;
        throw error;
      });
  }

  const stations = await tideStationsPromise;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  let nearest = null;
  stations.forEach((station) => {
    const latitudeDifference = toRadians(station.lat - latitude);
    const longitudeDifference = toRadians(station.lon - longitude);
    const arc = Math.sin(latitudeDifference / 2) ** 2 + Math.cos(toRadians(latitude)) *
      Math.cos(toRadians(station.lat)) * Math.sin(longitudeDifference / 2) ** 2;
    const distance = 6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
    if (!nearest || distance < nearest.distance) nearest = { ...station, distance };
  });
  if (!nearest || nearest.distance > 100) throw new Error("近くに利用できる潮位観測所がありません");
  return nearest;
}

// 月齢をもとに、日本で使われる潮回りの目安を返します。
function estimateTideCycle(date = new Date()) {
  const jstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const parts = Object.fromEntries(jstParts.map((part) => [part.type, part.value]));
  const localNoon = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+09:00`);
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const lunarMonth = 29.530588853;
  const age = ((localNoon.getTime() - knownNewMoon) / 86400000 % lunarMonth + lunarMonth) % lunarMonth;
  const lunarDay = Math.floor(age) + 1;

  if (lunarDay <= 3 || lunarDay >= 27) return "大潮";
  if ([9, 22].includes(lunarDay)) return "長潮";
  if ([10, 23].includes(lunarDay)) return "若潮";
  if ([7, 8, 20, 21].includes(lunarDay)) return "小潮";
  return "中潮";
}

// Open-Meteoの現在の気象値と、気象庁の最寄り観測所の潮位を入力します。
async function fetchConditions(latitude, longitude) {
  const button = document.querySelector("#conditions-button");
  const status = document.querySelector("#conditions-status");
  button.disabled = true;
  status.textContent = "気象と潮位を取得しています。";

  const weatherParameters = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "auto"
  });
  catchForm.elements.tideCycle.value = estimateTideCycle();

  try {
    const [weatherResult, tideResult] = await Promise.allSettled([
      fetch(`https://api.open-meteo.com/v1/forecast?${weatherParameters}`).then((response) => {
        if (!response.ok) throw new Error("気象データを取得できません");
        return response.json();
      }),
      (async () => {
        const station = await findNearestTideStation(latitude, longitude);
        const now = new Date();
        const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
        }).formatToParts(now).map((part) => [part.type, part.value]));
        const date = `${dateParts.year}${dateParts.month}${dateParts.day}`;
        const year = dateParts.year;
        const baseUrl = "https://www.jma.go.jp/bosai/tidelevel";
        const observationsResponse = await fetch(`${baseUrl}/data/tide/tide_obs_${date}_${station.code}.json`);
        if (!observationsResponse.ok) throw new Error("潮位データを取得できません");
        const observations = await observationsResponse.json();
        const index = Math.floor((now.getTime() - new Date(observations.time).getTime()) /
          (observations.interval * 60000));
        const level = observations.tide[index];
        if (!Number.isFinite(level)) throw new Error("現在の潮位データがありません");

        catchForm.elements.tideLevel.value = String(Math.round(level));
        const previousLevel = observations.tide[index - 2];
        const nextLevel = observations.tide[index + 2];
        if (Number.isFinite(previousLevel) && Number.isFinite(nextLevel)) {
          const tideFlow = nextLevel - previousLevel;
          const flowValue = tideFlow > 0.5 ? "上げ潮" : tideFlow < -0.5 ? "下げ潮" : "止まり";
          const flowInput = catchForm.querySelector(`input[name="tideFlow"][value="${flowValue}"]`);
          if (flowInput) flowInput.checked = true;
        }
        return { station, level };
      })()
    ]);

    const messages = [];
    if (weatherResult.status === "fulfilled") {
      const current = weatherResult.value.current;
      if (Number.isFinite(current.temperature_2m)) catchForm.elements.airTemp.value = String(current.temperature_2m);
      if (Number.isFinite(current.wind_speed_10m)) catchForm.elements.windSpeed.value = String(current.wind_speed_10m);
      if (Number.isFinite(current.wind_direction_10m)) {
        catchForm.elements.windDirection.value = windDirectionName(current.wind_direction_10m);
      }
      if (Number.isFinite(current.pressure_msl)) catchForm.elements.pressure.value = String(current.pressure_msl);
      messages.push("気象を入力しました");
    } else {
      messages.push("気象データを取得できませんでした");
    }

    if (tideResult.status === "fulfilled") {
      const { station } = tideResult.value;
      messages.push(`潮位は最寄りの${station.name}（約${Math.round(station.distance)}km）`);
    } else {
      messages.push("潮位データを取得できませんでした");
    }
    status.textContent = `${messages.join("。")}。潮回りは月齢による目安です。`;
  } catch (error) {
    status.textContent = error.message || "気象・潮汐データを取得できませんでした。";
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#conditions-button").addEventListener("click", () => {
  const latitude = Number(catchForm.elements.latitude.value);
  const longitude = Number(catchForm.elements.longitude.value);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    document.querySelector("#conditions-status").textContent = "先に緯度と経度を入力するか、GPSで現在地を取得してください。";
    return;
  }
  fetchConditions(latitude, longitude);
});

// GPSで座標を取得し、地図サービスから近くの地名を調べます。
document.querySelector("#location-button").addEventListener("click", () => {
  const button = document.querySelector("#location-button");
  const status = document.querySelector("#location-status");
  if (!navigator.geolocation) {
    status.textContent = "このブラウザーでは位置情報を利用できません。";
    return;
  }

  button.disabled = true;
  status.textContent = "現在地を取得しています。位置情報の許可を確認してください。";
  navigator.geolocation.getCurrentPosition(async (position) => {
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    catchForm.elements.latitude.value = latitude.toFixed(6);
    catchForm.elements.longitude.value = longitude.toFixed(6);
    fetchConditions(latitude, longitude);

    try {
      const parameters = new URLSearchParams({
        format: "jsonv2",
        lat: String(latitude),
        lon: String(longitude),
        "accept-language": "ja"
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${parameters}`);
      if (!response.ok) throw new Error("地名を検索できません");
      const place = await response.json();
      const address = place.address ?? {};
      const placeName = String(
        place.name || address.neighbourhood || address.suburb || address.village ||
        address.town || address.city || address.hamlet || place.display_name || ""
      ).slice(0, 80);
      if (placeName && !catchForm.elements.point.value.trim()) {
        catchForm.elements.point.value = placeName;
        status.textContent = `座標と周辺地名「${placeName}」を入力しました。釣り場名は必要に応じて修正してください。`;
      } else if (placeName) {
        status.textContent = `座標を取得しました。周辺地名は「${placeName}」です。入力済みのポイント名は変更していません。`;
      } else {
        status.textContent = "座標を取得しました。周辺の地名が見つからないため、ポイント名を入力してください。";
      }
    } catch (error) {
      status.textContent = "座標を取得しましたが、地名検索に失敗しました。ポイント名は手入力できます。";
    } finally {
      button.disabled = false;
    }
  }, (error) => {
    const messages = {
      1: "位置情報が許可されていません。ブラウザーの設定で許可してください。",
      2: "現在地を確認できませんでした。電波の届く場所で再度お試しください。",
      3: "位置情報の取得がタイムアウトしました。もう一度お試しください。"
    };
    status.textContent = messages[error.code] || "位置情報を取得できませんでした。";
    button.disabled = false;
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "日時未設定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function getActiveTrip() {
  return data.trips.find((trip) => !trip.endedAt) ?? null;
}

function renderSession() {
  const panel = document.querySelector(".session-panel");
  const status = document.querySelector("#session-status");
  const detail = document.querySelector("#session-detail");
  const button = document.querySelector("#session-toggle");
  const activeTrip = getActiveTrip();
  const startTideField = catchForm.elements.tripStartTideLevel;
  const endTideField = catchForm.elements.tripEndTideLevel;

  panel.classList.toggle("is-active", Boolean(activeTrip));
  if (activeTrip) {
    startTideField.value = activeTrip.startTideLevel ?? "";
    endTideField.value = activeTrip.endTideLevel ?? "";
    status.textContent = "釣行中";
    detail.textContent = `${formatDate(activeTrip.startedAt)} 開始${activeTrip.point ? ` ・ ${activeTrip.point}` : ""}`;
    button.textContent = "釣行終了";
  } else {
    startTideField.value = "";
    endTideField.value = "";
    status.textContent = "釣行はまだ始まっていません";
    detail.textContent = "準備ができたら記録を開始";
    button.textContent = "釣行開始";
  }
}

function renderLures() {
  const options = document.querySelector("#lure-options");
  const list = document.querySelector("#lure-list");
  options.innerHTML = data.lures.map((lure) => `<option value="${escapeHTML(lure.name)}"></option>`).join("");
  list.innerHTML = data.lures.length
    ? data.lures.map((lure) => {
      const details = [
        lure.manufacturer,
        lure.type,
        lure.action && `アクション: ${lure.action}`,
        lure.weight && `${lure.weight} g`,
        lure.color && `カラー: ${lure.color}`,
        (lure.shallowRange || lure.deepRange) && `レンジ: ${lure.shallowRange || "?"}〜${lure.deepRange || "?"} cm`
      ].filter(Boolean).join(" ・ ");
      return `<div class="lure-row"><div><p class="lure-row-name">${escapeHTML(lure.name)}</p><p class="lure-row-details">${escapeHTML(details || "詳細未登録")}</p></div><button class="text-button danger" type="button" data-remove-lure="${escapeHTML(lure.id)}">削除</button></div>`;
    }).join("")
    : '<div class="empty-state">登録したルアーはまだありません。</div>';
}

// 釣果フォームにルアー入力行を追加します。
function addCatchLureRow() {
  const row = document.createElement("div");
  row.className = "catch-lure-row";
  row.innerHTML = `<label class="field catch-lure-name">ルアー名
      <input name="lure" type="text" list="lure-options" placeholder="ルアー名">
    </label>
    <button class="button catch-lure-remove" type="button" aria-label="このルアー行を削除" title="このルアー行を削除">×</button>
    <label class="field">カラー
      <input name="lureColor" type="text" placeholder="例：チャートバック" maxlength="50">
    </label>
    <label class="field">レンジ
      <select name="range">
        <option value="">選択してください</option><option>表層</option><option>表層直下</option><option>中層</option><option>ボトム</option><option>不明</option>
      </select>
    </label>`;
  document.querySelector("#catch-lure-list").append(row);
  return row;
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  const summary = document.querySelector("#history-summary");
  const sortedCatches = [...data.catches].sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalFish = data.catches.reduce((sum, entry) => sum + (Number(entry.catchCount) || 0), 0);
  summary.innerHTML = `<span>記録 <strong>${data.catches.length}</strong> 件</span><span>・</span><span>釣果 <strong>${totalFish}</strong> 匹</span><span>・</span><span>釣行 <strong>${data.trips.length}</strong> 回</span>`;

  if (!sortedCatches.length) {
    list.innerHTML = '<div class="empty-state">釣行記録はまだありません。<br>最初の一匹を記録してみましょう。</div>';
    return;
  }

  list.innerHTML = sortedCatches.map((entry) => {
    const trip = data.trips.find((item) => item.id === entry.tripId);
    const lures = Array.isArray(entry.lures) && entry.lures.length
      ? entry.lures
      : entry.lure ? [{ name: entry.lure, color: entry.lureColor, range: entry.range }] : [];
    const lureDetails = lures.map((lure) => {
      const detail = [lure.color, lure.range].filter(Boolean).join(" / ");
      return `${lure.name}${detail ? ` (${detail})` : ""}`;
    }).join(" / ");
    const coordinates = [entry.latitude, entry.longitude].filter((value) => value !== "" && value != null).join(", ");
    const wind = [entry.windDirection, entry.windSpeed !== "" && entry.windSpeed != null ? `${entry.windSpeed} m/s` : ""].filter(Boolean).join(" / ");
    const detailFields = [
      ["緯度・経度", coordinates],
      ["気温", entry.airTemp !== "" && entry.airTemp != null ? `${entry.airTemp} ℃` : ""],
      ["水温", entry.waterTemp !== "" && entry.waterTemp != null ? `${entry.waterTemp} ℃` : ""],
      ["風向・風速", wind],
      ["気圧", entry.pressure !== "" && entry.pressure != null ? `${entry.pressure} hPa` : ""],
      ["潮回り", entry.tideCycle],
      ["潮位", entry.tideLevel !== "" && entry.tideLevel != null ? `${entry.tideLevel} cm` : ""],
      ["潮の動き", entry.tideFlow],
      ["使用ルアー", lureDetails],
      ["ベイト", entry.bait],
      ["バイト数", entry.bites !== "" && entry.bites != null ? `${entry.bites} 回` : ""],
      ["釣果", entry.catchCount !== "" && entry.catchCount != null ? `${entry.catchCount} 匹` : ""],
      ["シーバスのサイズ", entry.size !== "" && entry.size != null ? `${entry.size} cm` : ""],
      ["メモ", entry.memo, true]
    ].filter(([, value]) => value !== "" && value != null);
    const details = detailFields.map(([label, value, wide]) =>
      `<div class="record-field${wide ? " record-field-wide" : ""}"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`
    ).join("");
    const photo = entry.photo ? `<img class="record-photo" src="${entry.photo}" alt="${escapeHTML(entry.point)}で撮影した釣果写真">` : "";
    return `<article class="record-card">
      <div class="record-main"><div><p class="record-date">${escapeHTML(formatDate(entry.date))}</p><h3 class="record-point">${escapeHTML(entry.point)}</h3></div><div class="record-catch">${escapeHTML(entry.catchCount || "0")}<span>匹</span></div></div>
      <dl class="record-details">${details || '<div class="record-field record-field-wide"><dd>追加情報はありません</dd></div>'}</dl>
      ${photo}<div class="record-actions"><button class="text-button" type="button" data-edit-catch="${escapeHTML(entry.id)}">編集</button><button class="text-button danger" type="button" data-delete-catch="${escapeHTML(entry.id)}">記録を削除</button></div>
    </article>`;
  }).join("");
}

// 履歴の内容を釣果フォームへ読み込みます。
function editCatchEntry(entry) {
  editingCatchId = entry.id;
  ["date", "point", "latitude", "longitude", "airTemp", "waterTemp", "windDirection", "windSpeed", "pressure", "tideCycle", "tideLevel", "tripStartTideLevel", "tripEndTideLevel", "tideFlow", "bait", "bites", "catchCount", "size", "memo"].forEach((name) => {
    const field = catchForm.elements[name];
    if (field) field.value = entry[name] ?? "";
  });

  const savedLures = Array.isArray(entry.lures) && entry.lures.length
    ? entry.lures
    : entry.lure ? [{ name: entry.lure, color: entry.lureColor, range: entry.range }] : [];
  const lureList = document.querySelector("#catch-lure-list");
  lureList.replaceChildren();
  (savedLures.length ? savedLures : [{}]).forEach((lure) => {
    const row = addCatchLureRow();
    row.querySelector('[name="lure"]').value = lure.name || "";
    row.querySelector('[name="lureColor"]').value = lure.color || "";
    row.querySelector('[name="range"]').value = lure.range || "";
  });

  const preview = document.querySelector("#photo-preview");
  preview.hidden = !entry.photo;
  if (entry.photo) preview.src = entry.photo;
  catchForm.querySelector(".submit-button").innerHTML = "変更を保存";
  document.querySelector("#cancel-edit-button").hidden = false;
  switchView("record");
  catchForm.elements.point.focus({ preventScroll: true });
}

function cancelCatchEdit() {
  editingCatchId = "";
  catchForm.reset();
  document.querySelector("#catch-lure-list").replaceChildren();
  addCatchLureRow();
  catchForm.elements.date.value = localDateTime();
  catchForm.querySelector(".submit-button").innerHTML = '<span aria-hidden="true">＋</span> 釣果を保存';
  document.querySelector("#cancel-edit-button").hidden = true;
  document.querySelector("#photo-preview").hidden = true;
  renderSession();
}

function renderAll() {
  renderSession();
  renderLures();
  renderHistory();
}

function switchView(viewName) {
  document.querySelector(".app-shell").classList.toggle("home-active", viewName === "home");
  document.querySelectorAll(".view").forEach((view) => {
    const isSelected = view.id === `${viewName}-view`;
    view.hidden = !isSelected;
    view.classList.toggle("active", isSelected);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    const isSelected = button.dataset.view === viewName;
    button.classList.toggle("active", isSelected);
    if (isSelected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelector("#add-catch-lure").addEventListener("click", () => {
  addCatchLureRow().querySelector('[name="lure"]').focus();
});

document.querySelector("#catch-lure-list").addEventListener("click", (event) => {
  const removeButton = event.target.closest(".catch-lure-remove");
  if (!removeButton) return;
  const row = removeButton.closest(".catch-lure-row");
  const rows = document.querySelectorAll(".catch-lure-row");
  if (rows.length === 1) {
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    row.querySelector("select").value = "";
  } else {
    row.remove();
  }
});

document.querySelector("#cancel-edit-button").addEventListener("click", cancelCatchEdit);

// 釣行開始と終了を、履歴に残る一つの釣行として管理します。
document.querySelector("#session-toggle").addEventListener("click", () => {
  const activeTrip = getActiveTrip();
  if (activeTrip) {
    activeTrip.endedAt = new Date().toISOString();
    activeTrip.endTideLevel = String(
      catchForm.elements.tripEndTideLevel.value || catchForm.elements.tideLevel.value || ""
    ).trim();
    if (!saveData()) return;
    showToast("釣行を終了しました。");
  } else {
    const fields = new FormData(catchForm);
    const startTideLevel = String(fields.get("tripStartTideLevel") || fields.get("tideLevel") || "").trim();
    data.trips.push({
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      point: String(fields.get("point") || "").trim(),
      startTideLevel,
      endTideLevel: ""
    });
    if (!saveData()) {
      data.trips.pop();
      return;
    }
    showToast("釣行を開始しました。");
  }
  renderSession();
  renderHistory();
});

// 釣行中に入力した潮位を保存し、履歴へすぐ反映します。
[
  [catchForm.elements.tripStartTideLevel, "startTideLevel"],
  [catchForm.elements.tripEndTideLevel, "endTideLevel"]
].forEach(([field, property]) => {
  field.addEventListener("change", () => {
    if (editingCatchId) return;
    const activeTrip = getActiveTrip();
    if (!activeTrip) return;
    activeTrip[property] = field.value;
    saveData();
    renderHistory();
  });
});

// 入力内容と選んだ写真を、一件の釣果として保存します。
catchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const originalIndex = editingCatchId
    ? data.catches.findIndex((entry) => entry.id === editingCatchId)
    : -1;
  const originalEntry = originalIndex >= 0 ? data.catches[originalIndex] : null;
  if (editingCatchId && !originalEntry) {
    showToast("編集する記録が見つかりませんでした。");
    cancelCatchEdit();
    return;
  }
  const formData = new FormData(catchForm);
  const photoFile = formData.get("photo");
  let photo = "";
  if (photoFile instanceof File && photoFile.size > 0) {
    if (!photoFile.type.startsWith("image/")) {
      showToast("写真ファイルを選び直してください。");
      return;
    }
    try {
      photo = await resizePhoto(photoFile);
    } catch (error) {
      showToast("写真を読み込めませんでした。");
      return;
    }
  }

  const entry = Object.fromEntries(formData.entries());
  entry.id = originalEntry?.id ?? crypto.randomUUID();
  entry.tripId = originalEntry?.tripId ?? getActiveTrip()?.id ?? "";
  entry.photo = photo || originalEntry?.photo || "";
  entry.lures = formData.getAll("lure").map((name, index) => ({
    name: String(name || "").trim(),
    color: String(formData.getAll("lureColor")[index] || "").trim(),
    range: String(formData.getAll("range")[index] || "").trim()
  })).filter((lure) => lure.name);
  entry.lure = entry.lures.map((lure) => lure.name).join(" / ");
  entry.lureColor = entry.lures.map((lure) => lure.color).filter(Boolean).join(" / ");
  entry.range = entry.lures.map((lure) => lure.range).filter(Boolean).join(" / ");
  if (entry.latitude && (Number(entry.latitude) < -90 || Number(entry.latitude) > 90)) {
    showToast("緯度は -90 から 90 の範囲で入力してください。");
    return;
  }
  if (entry.longitude && (Number(entry.longitude) < -180 || Number(entry.longitude) > 180)) {
    showToast("経度は -180 から 180 の範囲で入力してください。");
    return;
  }
  if (originalEntry) data.catches[originalIndex] = entry;
  else data.catches.push(entry);
  if (!saveData()) {
    if (originalEntry) data.catches[originalIndex] = originalEntry;
    else data.catches.pop();
    return;
  }
  entry.lures.forEach((lure) => {
    if (lure.name && !data.lures.some((savedLure) => savedLure.name === lure.name)) {
      data.lures.push(normalizeLure(lure.name));
    }
  });
  saveData();
  const wasEditing = Boolean(originalEntry);
  editingCatchId = "";
  catchForm.reset();
  document.querySelector("#catch-lure-list").replaceChildren();
  addCatchLureRow();
  catchForm.elements.date.value = localDateTime();
  document.querySelector("#photo-preview").hidden = true;
  catchForm.querySelector(".submit-button").innerHTML = '<span aria-hidden="true">＋</span> 釣果を保存';
  document.querySelector("#cancel-edit-button").hidden = true;
  renderAll();
  showToast(wasEditing ? "記録を更新しました。" : "釣果を保存しました。");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// 写真は長辺を縮小してから保存し、ブラウザの容量を使いすぎないようにします。
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.78));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("画像を読み込めません"));
    };
    image.src = objectUrl;
  });
}

document.querySelector("#photo-preview").addEventListener("click", (event) => {
  event.currentTarget.hidden = true;
});
catchForm.elements.photo.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const preview = document.querySelector("#photo-preview");
  if (!file) {
    preview.hidden = true;
    return;
  }
  try {
    preview.src = await resizePhoto(file);
    preview.hidden = false;
  } catch (error) {
    showToast("写真を読み込めませんでした。");
  }
});

document.querySelector("#lure-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const name = String(formData.get("lureName") || "").trim();
  if (!name) return;
  if (data.lures.some((lure) => lure.name === name)) {
    showToast("このルアーはすでに登録されています。");
    return;
  }
  data.lures.push({
    id: crypto.randomUUID(),
    manufacturer: String(formData.get("manufacturer") || "").trim(),
    name,
    type: String(formData.get("type") || "").trim(),
    action: String(formData.get("action") || "").trim(),
    weight: String(formData.get("weight") || ""),
    color: String(formData.get("color") || "").trim(),
    shallowRange: String(formData.get("shallowRange") || ""),
    deepRange: String(formData.get("deepRange") || "")
  });
  if (!saveData()) {
    data.lures.pop();
    return;
  }
  form.reset();
  renderLures();
  showToast("ルアーを追加しました。");
});

document.querySelector("#lure-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-lure]");
  if (!button) return;
  const index = data.lures.findIndex((lure) => lure.id === button.dataset.removeLure);
  if (index < 0) return;
  const removedLure = data.lures.splice(index, 1)[0];
  if (!saveData()) {
    data.lures.splice(index, 0, removedLure);
    return;
  }
  renderLures();
  showToast("ルアーを削除しました。");
});

document.querySelector("#history-list").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-catch]");
  if (editButton) {
    const entry = data.catches.find((item) => item.id === editButton.dataset.editCatch);
    if (entry) editCatchEntry(entry);
    return;
  }
  const button = event.target.closest("[data-delete-catch]");
  if (!button) return;
  const index = data.catches.findIndex((entry) => entry.id === button.dataset.deleteCatch);
  if (index < 0 || !window.confirm("この釣果記録を削除しますか？")) return;
  const [deletedEntry] = data.catches.splice(index, 1);
  if (!saveData()) {
    data.catches.splice(index, 0, deletedEntry);
    return;
  }
  renderHistory();
  showToast("記録を削除しました。");
});

// 記録した釣果を、表計算ソフトで開けるCSVファイルにします。
document.querySelector("#export-button").addEventListener("click", () => {
  if (!data.catches.length) {
    showToast("出力する釣果記録がありません。");
    return;
  }
  const columns = [
    ["釣行日時", "date"], ["ポイント名", "point"], ["緯度", "latitude"], ["経度", "longitude"],
    ["気温", "airTemp"], ["水温", "waterTemp"], ["風向", "windDirection"], ["風速", "windSpeed"],
    ["気圧", "pressure"], ["潮回り", "tideCycle"], ["潮位", "tideLevel"], ["上げ潮／下げ潮", "tideFlow"],
    ["釣行開始時潮位", "tripStartTideLevel"], ["釣行終了時潮位", "tripEndTideLevel"],
    ["使用ルアー", "lure"], ["ルアーカラー", "lureColor"], ["レンジ", "range"], ["ベイト", "bait"],
    ["バイト数", "bites"], ["釣果", "catchCount"], ["シーバスのサイズ", "size"], ["写真", "photo"], ["メモ", "memo"]
  ];
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [columns.map(([label]) => csvCell(label)).join(",")];
  const tripsById = new Map(data.trips.map((trip) => [trip.id, trip]));
  data.catches.forEach((entry) => {
    const trip = tripsById.get(entry.tripId);
    rows.push(columns.map(([, key]) => {
      if (key === "photo") return csvCell(entry.photo ? "写真あり" : "");
      if (key === "tripStartTideLevel") return csvCell(trip?.startTideLevel);
      if (key === "tripEndTideLevel") return csvCell(trip?.endTideLevel);
      if (key === "lure" && Array.isArray(entry.lures)) return csvCell(entry.lures.map((lure) => lure.name).join(" / "));
      if (key === "lureColor" && Array.isArray(entry.lures)) return csvCell(entry.lures.map((lure) => lure.color).join(" / "));
      if (key === "range" && Array.isArray(entry.lures)) return csvCell(entry.lures.map((lure) => lure.range).join(" / "));
      return csvCell(entry[key]);
    }).join(","));
  });
  const csv = `\uFEFF${rows.join("\r\n")}`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `seabass-log-${localDateTime().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("CSVを出力しました。");
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (button.matches("a")) event.preventDefault();
    switchView(button.dataset.view);
  });
});

document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric", month: "long", day: "numeric", weekday: "short"
}).format(new Date());
catchForm.elements.date.value = localDateTime();
addCatchLureRow();
renderAll();