const $ = (selector) => document.querySelector(selector);
const state = {
  manifest: null,
  time: 0,
  playing: false,
  speed: 1,
  wallStarted: 0,
  timeStarted: 0,
  panels: new Map(),
  frame: 0
};
const preloadCache = { images: new Map(), videos: new Map() };
const preloadHorizon = 20_000;

const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

function itemAt(source, time) {
  let low = 0;
  let high = source.items.length - 1;
  let candidate = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = source.items[middle];
    if (item.start <= time) { candidate = item; low = middle + 1; }
    else high = middle - 1;
  }
  return candidate && time < candidate.end ? candidate : null;
}

function show(panel, type, item) {
  panel.image.classList.toggle("active", type === "image");
  panel.video.classList.toggle("active", type === "video");
  panel.empty.hidden = Boolean(type);
}

function loadVideo(panel, item, desired) {
  if (panel.videoItemId !== item.id) {
    panel.videoItemId = item.id;
    panel.video.src = item.url;
    panel.video.load();
  }
  const applyTime = () => {
    panel.loadingId = null;
    if (Math.abs(panel.video.currentTime - desired) > 0.15) panel.video.currentTime = desired;
    if (state.playing) panel.video.play().catch(() => {});
  };
  if (panel.video.readyState >= 1) applyTime();
  else if (panel.loadingId !== item.id) {
    panel.loadingId = item.id;
    panel.video.addEventListener("loadedmetadata", applyTime, { once: true });
  }
}

function renderContinuous(source, panel, time) {
  const item = itemAt(source, time);
  if (!item) {
    panel.video.pause();
    panel.videoItemId = null;
    show(panel, null, null);
    return;
  }
  const desired = Math.max(0, Math.min(item.duration, (time - item.start) / 1000));
  show(panel, "video", item);
  loadVideo(panel, item, desired);
  if (panel.video.readyState >= 2) {
    const drift = desired - panel.video.currentTime;
    if (Math.abs(drift) > 0.3) panel.video.currentTime = desired;
    panel.video.playbackRate = state.speed * Math.max(0.97, Math.min(1.03, 1 + drift * 0.08));
  }
}

function preloadUpcoming(source, time) {
  for (const item of source.items) {
    if (item.start <= time || item.start > time + preloadHorizon) continue;
    if (item.type === "image" && !preloadCache.images.has(item.url)) {
      const image = new Image();
      image.className = "media image";
      image.alt = "";
      image.decoding = "async";
      image.src = item.url;
      image.decode().catch(() => {});
      preloadCache.images.set(item.url, image);
    }
    if (item.type === "video" && !preloadCache.videos.has(item.url)) {
      const video = document.createElement("video");
      video.className = "media video";
      video.preload = "auto";
      video.playsInline = true;
      video.muted = true;
      video.src = item.url;
      video.load();
      preloadCache.videos.set(item.url, video);
    }
  }
}

function prunePreloads(time) {
  const retained = new Set(state.manifest.sources
    .filter((source) => source.kind === "events")
    .flatMap((source) => source.items)
    .filter((item) => item.end >= time && item.start <= time + preloadHorizon)
    .map((item) => item.url));
  for (const [url] of preloadCache.images) {
    if (!retained.has(url)) preloadCache.images.delete(url);
  }
  for (const [url, video] of preloadCache.videos) {
    if (retained.has(url)) continue;
    video.pause();
    video.removeAttribute("src");
    video.load();
    preloadCache.videos.delete(url);
  }
}

function adoptImage(panel, item) {
  if (panel.imageItemId === item.id) return;
  const image = preloadCache.images.get(item.url);
  if (image && image !== panel.image) {
    panel.image.replaceWith(image);
    panel.image = image;
  } else panel.image.src = item.url;
  panel.imageItemId = item.id;
}

function adoptVideo(panel, item) {
  if (panel.videoItemId === item.id) return;
  const video = preloadCache.videos.get(item.url);
  if (video && video !== panel.video) {
    panel.video.pause();
    panel.video.replaceWith(video);
    panel.video = video;
    panel.videoItemId = item.id;
  }
}

function renderEvent(source, panel, time) {
  preloadUpcoming(source, time);
  const item = itemAt(source, time);
  if (!item) {
    panel.video.pause();
    show(panel, null, null);
    return;
  }
  const elapsed = (time - item.start) / 1000;
  const fadeStart = (item.contentEnd - item.start) / 1000;
  const opacity = elapsed <= fadeStart ? 1 : Math.max(0, 1 - (elapsed - fadeStart) / source.fadeSeconds);
  if (item.type === "image") {
    adoptImage(panel, item);
    show(panel, "image", item);
    panel.image.style.opacity = opacity;
  } else {
    adoptVideo(panel, item);
    show(panel, "video", item);
    const desired = Math.min(item.duration, elapsed);
    loadVideo(panel, item, desired);
    panel.video.style.opacity = opacity;
    panel.video.playbackRate = state.speed;
  }
}

function render() {
  const { manifest, time } = state;
  prunePreloads(time);
  $("#clock").textContent = formatter.format(time);
  const progress = (time - manifest.start) / (manifest.end - manifest.start);
  $("#timeline").value = String(time - manifest.start);
  $(".timeline-wrap").style.setProperty("--playhead", `${Math.max(0, Math.min(1, progress)) * 100}%`);
  for (const source of manifest.sources) {
    const panel = state.panels.get(source.id);
    if (source.kind === "continuous") renderContinuous(source, panel, time);
    else renderEvent(source, panel, time);
  }
}

function tick(now) {
  if (!state.playing) return;
  state.time = state.timeStarted + (now - state.wallStarted) * state.speed;
  if (state.time >= state.manifest.end) {
    state.time = state.manifest.end;
    setPlaying(false);
  }
  render();
  state.frame = requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
  $("#play").textContent = playing ? "❚❚" : "▶";
  $("#play").ariaLabel = playing ? "Pause" : "Play";
  if (playing) {
    state.wallStarted = performance.now();
    state.timeStarted = state.time;
    state.frame = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(state.frame);
    for (const panel of state.panels.values()) panel.video.pause();
  }
}

function seek(time) {
  state.time = Math.max(state.manifest.start, Math.min(state.manifest.end, time));
  if (state.playing) { state.wallStarted = performance.now(); state.timeStarted = state.time; }
  render();
}

function buildPanels() {
  const grid = $("#grid");
  for (const source of state.manifest.sources) {
    const fragment = $("#panel-template").content.cloneNode(true);
    const article = fragment.querySelector("article");
    const panel = {
      article,
      video: article.querySelector("video"), image: article.querySelector("img"),
      empty: article.querySelector(".empty"), imageItemId: null, videoItemId: null, loadingId: null
    };
    grid.append(fragment);
    state.panels.set(source.id, panel);
  }
}

function buildLanes() {
  const lanes = $("#lanes");
  const span = state.manifest.end - state.manifest.start;
  for (const source of state.manifest.sources) {
    const lane = document.createElement("div");
    lane.className = "lane";
    for (const item of source.items) {
      const mark = document.createElement("i");
      mark.className = source.kind === "continuous" ? "coverage" : "marker";
      mark.style.left = `${(item.start - state.manifest.start) / span * 100}%`;
      if (source.kind === "continuous") mark.style.width = `${(item.end - item.start) / span * 100}%`;
      lane.append(mark);
    }
    lanes.append(lane);
  }
}

async function initialize() {
  let trips;
  try {
    const response = await fetch("data/trips/index.json");
    if (!response.ok) throw new Error("No static trip index");
    trips = await response.json();
  } catch {
    trips = await fetch("api/trips").then((response) => response.json());
  }
  if (!trips.length) throw new Error("No generated trips. Run npm run manifest.");
  state.manifest = await fetch(`data/trips/${trips.at(-1)}.json`).then((response) => response.json());
  state.time = state.manifest.initialTime ?? state.manifest.start;
  $("#title").textContent = state.manifest.title;
  $("#date").textContent = dateFormatter.format(state.manifest.start);
  $("#timeline").max = String(state.manifest.end - state.manifest.start);
  $("#timeline-start").textContent = formatter.format(state.manifest.start);
  $("#timeline-end").textContent = formatter.format(state.manifest.end);
  const visibleWarnings = state.manifest.warnings.filter((warning) => warning.includes("overlap"));
  if (state.manifest.warnings.length) console.warn("Manifest warnings:", ...state.manifest.warnings);
  if (visibleWarnings.length) {
    $("#warnings").hidden = false;
    $("#warnings").textContent = visibleWarnings.join(" · ");
  }
  buildPanels();
  buildLanes();
  render();
}

$("#play").addEventListener("click", () => setPlaying(!state.playing));
for (const button of document.querySelectorAll("[data-skip]")) {
  button.addEventListener("click", () => seek(state.time + Number(button.dataset.skip) * 1000));
}
$("#speed").addEventListener("change", (event) => {
  if (state.playing) { state.time = state.timeStarted + (performance.now() - state.wallStarted) * state.speed; }
  state.speed = Number(event.target.value);
  state.wallStarted = performance.now();
  state.timeStarted = state.time;
});
$("#timeline").addEventListener("input", (event) => seek(state.manifest.start + Number(event.target.value)));
window.addEventListener("keydown", (event) => {
  if (event.code === "Space") { event.preventDefault(); setPlaying(!state.playing); }
  if (event.code === "ArrowLeft") seek(state.time - (event.shiftKey ? 60_000 : 5_000));
  if (event.code === "ArrowRight") seek(state.time + (event.shiftKey ? 60_000 : 5_000));
});

initialize().catch((error) => {
  console.error(error);
  $("#date").textContent = error.message;
});
