"use strict";

/* ============================================================
 * BBox Captioner — frontend logic
 * Boxes are stored internally in ORIGINAL-image pixel coords.
 * The image is shown fit-to-view; we scale between display and
 * natural coords on the fly.
 * ============================================================ */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  sourceDir: $("sourceDir"), outputDir: $("outputDir"), openBtn: $("openBtn"),
  browseSource: $("browseSource"), browseOutput: $("browseOutput"),
  chooseBtn: $("chooseBtn"), settingsBtn: $("settingsBtn"),
  toggleBoxesBtn: $("toggleBoxesBtn"), randomColors: $("randomColors"),
  progressFill: $("progressFill"), progressText: $("progressText"),
  stage: $("canvasStage"), imageWrap: $("imageWrap"), mainImage: $("mainImage"),
  overlay: $("overlay"), pendingControls: $("pendingControls"),
  confirmBox: $("confirmBox"), cancelBox: $("cancelBox"),
  emptyHint: $("emptyHint"), imageMeta: $("imageMeta"),
  boxList: $("boxList"), boxListEmpty: $("boxListEmpty"), boxCount: $("boxCount"),
  prevBtn: $("prevBtn"), skipBtn: $("skipBtn"), saveBtn: $("saveBtn"),
  saveNextBtn: $("saveNextBtn"), saveStatus: $("saveStatus"),
  pickerModal: $("pickerModal"), pickerClose: $("pickerClose"),
  pickerFilter: $("pickerFilter"), pickerList: $("pickerList"),
  settingsModal: $("settingsModal"), settingsClose: $("settingsClose"),
  themeSelect: $("themeSelect"), lineColor: $("lineColor"),
  lineWidth: $("lineWidth"), lineWidthVal: $("lineWidthVal"),
};
const ctx = els.overlay.getContext("2d");

// ---------- State ----------
const state = {
  images: [],          // [{name, processed, num_boxes}]
  index: -1,           // index into images of the current image
  boxes: [],           // [{id, name, bbox:[x1,y1,x2,y2]}] (natural px)
  natW: 0, natH: 0,    // natural image size
  dispW: 0, dispH: 0,  // displayed image size
  selectedId: null,
  redrawTarget: null,  // box id being re-drawn, or null
  dirty: false,        // unsaved changes for current image
  showBoxes: true,     // toggle overlay visibility of committed boxes
  drawColor: "#ff3b30",// current line color used for the next drawn box
};
let nextBoxId = 1;

// A random, pleasant color for random-color mode.
function randomColor() {
  return `hsl(${Math.floor(Math.random() * 360)}, 72%, 58%)`;
}

// pending (in-progress) drawing, in DISPLAY coords
let drag = null;       // {x0,y0,x1,y1}
let pending = null;    // committed-but-unconfirmed rect in DISPLAY coords

// ---------- Settings (persisted in localStorage) ----------
const settings = {
  theme: localStorage.getItem("bbox.theme") || "dark",
  lineColor: localStorage.getItem("bbox.lineColor") || "#ff3b30",
  lineWidth: parseInt(localStorage.getItem("bbox.lineWidth") || "2", 10),
  randomColors: localStorage.getItem("bbox.randomColors") === "1",
};

function applySettings() {
  document.documentElement.setAttribute("data-theme", settings.theme);
  els.themeSelect.value = settings.theme;
  els.lineColor.value = settings.lineColor;
  els.lineWidth.value = settings.lineWidth;
  els.lineWidthVal.textContent = settings.lineWidth;
  els.randomColors.checked = settings.randomColors;
  // Color picker is meaningless while colors are randomized.
  els.lineColor.disabled = settings.randomColors;
  refreshDrawColor();
  redraw();
}

// Decide the color to use for the next box drawn.
function refreshDrawColor() {
  state.drawColor = settings.randomColors ? randomColor() : settings.lineColor;
}

// ============================================================
// Coordinate helpers
// ============================================================
const scale = () => (state.natW ? state.dispW / state.natW : 1);
const toNat = (d) => Math.round(d / scale());
const toDisp = (n) => n * scale();

// ============================================================
// API
// ============================================================
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// ============================================================
// Open directories
// ============================================================
async function openDirs() {
  const source = els.sourceDir.value.trim();
  const output = els.outputDir.value.trim();
  if (!source || !output) { setStatus("Enter both source and output paths.", true); return; }
  els.openBtn.disabled = true;
  try {
    const data = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_dir: source, output_dir: output }),
    });
    applyImageList(data);
    els.chooseBtn.disabled = state.images.length === 0;
    if (state.images.length === 0) {
      setStatus("No images found in source directory.", true);
    } else {
      setStatus(`Opened — ${state.images.length} images.`);
      // Jump to the first unprocessed image (or the first image).
      const firstTodo = state.images.findIndex((i) => !i.processed);
      loadImageAt(firstTodo === -1 ? 0 : firstTodo);
    }
  } catch (e) {
    setStatus("Open failed: " + e.message, true);
  } finally {
    els.openBtn.disabled = false;
  }
}

function applyImageList(data) {
  state.images = data.images;
  els.sourceDir.value = data.source_dir;
  els.outputDir.value = data.output_dir;
  updateProgress(data.done, data.total);
}

function updateProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = pct + "%";
  els.progressText.textContent = `${done} / ${total} processed (${pct}%)`;
}

async function refreshImages() {
  try {
    const data = await api("/api/images");
    applyImageList(data);
  } catch (e) { /* ignore */ }
}

// ============================================================
// Load an image
// ============================================================
async function loadImageAt(idx) {
  if (idx < 0 || idx >= state.images.length) return;
  if (state.dirty && !confirm("Discard unsaved changes on the current image?")) return;

  state.index = idx;
  const img = state.images[idx];
  resetCurrent();

  // Load existing boxes if this image was already processed.
  if (img.processed) {
    try {
      const r = await api(`/api/result?name=${encodeURIComponent(img.name)}`);
      state.boxes = (r.boxes || []).map((b) => ({
        id: nextBoxId++, name: b.name || "Object", bbox: b.bbox,
        color: settings.randomColors ? randomColor() : settings.lineColor,
      }));
    } catch (e) { /* ignore */ }
  }

  // Load the image bitmap.
  els.emptyHint.classList.add("hidden");
  els.mainImage.onload = () => {
    state.natW = els.mainImage.naturalWidth;
    state.natH = els.mainImage.naturalHeight;
    syncCanvasSize();
    renderBoxList();
    els.imageMeta.textContent =
      `${img.name}  ·  ${state.natW}×${state.natH}px  ·  image ${idx + 1}/${state.images.length}` +
      (img.processed ? "  ·  (previously processed)" : "");
    updateNavButtons();
  };
  els.mainImage.src = `/api/image?name=${encodeURIComponent(img.name)}&t=${Date.now()}`;
}

function resetCurrent() {
  state.boxes = [];
  state.selectedId = null;
  state.redrawTarget = null;
  state.dirty = false;
  pending = null; drag = null;
  els.pendingControls.classList.add("hidden");
  setStatus("");
}

function syncCanvasSize() {
  // The <img> is fit-to-view via CSS; read its rendered size.
  state.dispW = els.mainImage.clientWidth;
  state.dispH = els.mainImage.clientHeight;
  els.overlay.width = state.dispW;
  els.overlay.height = state.dispH;
  els.overlay.style.width = state.dispW + "px";
  els.overlay.style.height = state.dispH + "px";
  redraw();
}

// ============================================================
// Drawing on the overlay canvas
// ============================================================
function relPos(e) {
  const r = els.overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(e.clientX - r.left, state.dispW)),
    y: Math.max(0, Math.min(e.clientY - r.top, state.dispH)),
  };
}

els.overlay.addEventListener("mousedown", (e) => {
  if (!state.natW) return;
  // A confirmed-but-pending box must be resolved first.
  if (pending) return;
  const p = relPos(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const p = relPos(e);
  drag.x1 = p.x; drag.y1 = p.y;
  redraw();
});

window.addEventListener("mouseup", () => {
  if (!drag) return;
  const rect = normRect(drag);
  drag = null;
  if (rect.w < 4 || rect.h < 4) { redraw(); return; } // ignore tiny boxes
  pending = rect;
  showPendingControls(rect);
  redraw();
});

function normRect(d) {
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
  return { x, y, w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
}

function showPendingControls(rect) {
  const pc = els.pendingControls;
  pc.classList.remove("hidden");
  // Anchor to the image-wrap; place at bottom-right corner of the rect.
  pc.style.left = (rect.x + rect.w - 56) + "px";
  pc.style.top = (rect.y + rect.h + 4) + "px";
}

els.confirmBox.addEventListener("click", () => {
  if (!pending) return;
  const bbox = [
    toNat(pending.x), toNat(pending.y),
    toNat(pending.x + pending.w), toNat(pending.y + pending.h),
  ];
  if (state.redrawTarget != null) {
    const b = state.boxes.find((x) => x.id === state.redrawTarget);
    if (b) b.bbox = bbox;
    state.redrawTarget = null;
  } else {
    state.boxes.push({ id: nextBoxId++, name: "Object", bbox, color: state.drawColor });
  }
  pending = null;
  els.pendingControls.classList.add("hidden");
  refreshDrawColor();   // next box gets a new random color (if enabled)
  markDirty();
  renderBoxList();
  redraw();
});

els.cancelBox.addEventListener("click", () => {
  pending = null;
  state.redrawTarget = null;
  els.pendingControls.classList.add("hidden");
  redraw();
});

function redraw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  ctx.lineWidth = settings.lineWidth;
  ctx.font = "12px Segoe UI, sans-serif";

  // committed boxes (skipped entirely when hidden)
  if (state.showBoxes) {
    state.boxes.forEach((b, i) => {
      const x = toDisp(b.bbox[0]), y = toDisp(b.bbox[1]);
      const w = toDisp(b.bbox[2] - b.bbox[0]), h = toDisp(b.bbox[3] - b.bbox[1]);
      const sel = b.id === state.selectedId;
      const col = settings.randomColors ? (b.color || settings.lineColor) : settings.lineColor;
      ctx.strokeStyle = col;
      ctx.globalAlpha = sel ? 1 : 0.9;
      ctx.strokeRect(x, y, w, h);
      // label chip
      const label = `${i + 1} ${b.name}`;
      const tw = ctx.measureText(label).width + 8;
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.fillRect(x, Math.max(0, y - 16), tw, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 4, Math.max(11, y - 4));
      if (sel) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      }
    });
    ctx.globalAlpha = 1;
  }

  // live drag rectangle (always shown while drawing)
  const live = drag ? normRect(drag) : pending;
  if (live) {
    ctx.strokeStyle = state.drawColor;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(live.x, live.y, live.w, live.h);
    ctx.setLineDash([]);
  }
}

// ============================================================
// Right-hand box list
// ============================================================
function renderBoxList() {
  els.boxCount.textContent = state.boxes.length;
  els.boxList.innerHTML = "";
  els.boxListEmpty.classList.toggle("hidden", state.boxes.length > 0);

  state.boxes.forEach((b, i) => {
    const item = document.createElement("div");
    item.className = "box-item" + (b.id === state.selectedId ? " selected" : "");
    if (settings.randomColors && b.color) {
      item.style.borderLeft = `4px solid ${b.color}`;
    }

    const idx = document.createElement("div");
    idx.className = "idx";
    idx.textContent = i + 1;

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = makeThumb(b.bbox);

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameInput = document.createElement("input");
    nameInput.className = "name-input";
    nameInput.value = b.name;
    nameInput.addEventListener("input", () => { b.name = nameInput.value; markDirty(); redraw(); });
    const coords = document.createElement("div");
    coords.className = "coords";
    coords.textContent = `[${b.bbox.join(", ")}]`;
    meta.append(nameInput, coords);

    const actions = document.createElement("div");
    actions.className = "actions";
    const modBtn = document.createElement("button");
    modBtn.className = "btn";
    modBtn.textContent = "Redraw";
    modBtn.title = "Re-draw this box on the image";
    modBtn.addEventListener("click", () => startRedraw(b.id));
    const delBtn = document.createElement("button");
    delBtn.className = "btn del";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteBox(b.id));
    actions.append(modBtn, delBtn);

    item.append(idx, thumb, meta, actions);
    item.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      state.selectedId = (state.selectedId === b.id ? null : b.id);
      renderBoxList(); redraw();
    });
    els.boxList.appendChild(item);
  });
}

function makeThumb(bbox) {
  const [x1, y1, x2, y2] = bbox;
  const sw = Math.max(1, x2 - x1), sh = Math.max(1, y2 - y1);
  const max = 56;
  const r = Math.min(max / sw, max / sh, 1);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * r));
  c.height = Math.max(1, Math.round(sh * r));
  try {
    c.getContext("2d").drawImage(els.mainImage, x1, y1, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } catch (e) { return ""; }
}

function startRedraw(id) {
  state.redrawTarget = id;
  state.selectedId = id;
  pending = null;
  els.pendingControls.classList.add("hidden");
  setStatus("Draw a new rectangle to replace box " +
    (state.boxes.findIndex((b) => b.id === id) + 1) + ".");
  renderBoxList(); redraw();
}

function deleteBox(id) {
  state.boxes = state.boxes.filter((b) => b.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.redrawTarget === id) state.redrawTarget = null;
  markDirty();
  renderBoxList(); redraw();
}

// ============================================================
// Saving & navigation
// ============================================================
function markDirty() { state.dirty = true; updateNavButtons(); }

function updateNavButtons() {
  const hasImg = state.index >= 0;
  els.prevBtn.disabled = !hasImg || state.index <= 0;
  els.skipBtn.disabled = !hasImg || state.index >= state.images.length - 1;
  els.saveBtn.disabled = !hasImg;
  els.saveNextBtn.disabled = !hasImg;
  els.toggleBoxesBtn.disabled = !hasImg;
}

async function saveCurrent(moveNext) {
  if (state.index < 0) return;
  const name = state.images[state.index].name;
  const payload = {
    name,
    boxes: state.boxes.map((b, i) => ({ index: i + 1, name: b.name || "Object", bbox: b.bbox })),
  };
  els.saveBtn.disabled = els.saveNextBtn.disabled = true;
  try {
    const data = await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    applyImageList(data);
    state.dirty = false;
    setStatus(`Saved ${payload.boxes.length} box(es) for ${name}.`);
    if (moveNext) {
      const next = nextUnprocessedAfter(state.index);
      if (next !== -1) loadImageAt(next);
      else setStatus("All images processed. 🎉");
    }
  } catch (e) {
    setStatus("Save failed: " + e.message, true);
  } finally {
    updateNavButtons();
  }
}

function nextUnprocessedAfter(idx) {
  for (let i = idx + 1; i < state.images.length; i++) {
    if (!state.images[i].processed) return i;
  }
  return idx + 1 < state.images.length ? idx + 1 : -1;
}

// ============================================================
// Image picker modal
// ============================================================
function openPicker() {
  els.pickerModal.classList.remove("hidden");
  els.pickerFilter.value = "";
  renderPicker("");
  els.pickerFilter.focus();
}
function renderPicker(filter) {
  const f = filter.toLowerCase();
  els.pickerList.innerHTML = "";
  state.images.forEach((img, i) => {
    if (f && !img.name.toLowerCase().includes(f)) return;
    const row = document.createElement("div");
    row.className = "picker-item" + (i === state.index ? " current" : "");
    row.innerHTML =
      `<span class="status ${img.processed ? "done" : "todo"}">${img.processed ? "✓" : "○"}</span>` +
      `<span class="pname">${img.name}</span>` +
      `<span class="pcount">${img.processed ? img.num_boxes + " boxes" : "todo"}</span>`;
    row.addEventListener("click", () => {
      els.pickerModal.classList.add("hidden");
      loadImageAt(i);
    });
    els.pickerList.appendChild(row);
  });
}

// ============================================================
// Wiring
// ============================================================
function setStatus(msg, isErr) {
  els.saveStatus.textContent = msg;
  els.saveStatus.style.color = isErr ? "var(--no)" : "var(--text-dim)";
}

els.openBtn.addEventListener("click", openDirs);
[els.sourceDir, els.outputDir].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") openDirs(); }));

// Native folder picker (server-side tkinter dialog).
async function browseInto(input, btn) {
  btn.disabled = true;
  setStatus("Opening folder picker… (check for a dialog window)");
  try {
    const r = await api("/api/browse");
    if (r.path) { input.value = r.path; setStatus("Folder selected."); }
    else setStatus("");
  } catch (e) {
    setStatus("Folder picker unavailable — type the path instead.", true);
  } finally {
    btn.disabled = false;
  }
}
els.browseSource.addEventListener("click", () => browseInto(els.sourceDir, els.browseSource));
els.browseOutput.addEventListener("click", () => browseInto(els.outputDir, els.browseOutput));

// Show / hide committed boxes on the image.
els.toggleBoxesBtn.addEventListener("click", () => {
  state.showBoxes = !state.showBoxes;
  els.toggleBoxesBtn.textContent = state.showBoxes ? "Hide Boxes" : "Show Boxes";
  redraw();
});

els.chooseBtn.addEventListener("click", openPicker);
els.pickerClose.addEventListener("click", () => els.pickerModal.classList.add("hidden"));
els.pickerFilter.addEventListener("input", () => renderPicker(els.pickerFilter.value));
els.pickerModal.addEventListener("click", (e) => {
  if (e.target === els.pickerModal) els.pickerModal.classList.add("hidden");
});

els.prevBtn.addEventListener("click", () => loadImageAt(state.index - 1));
els.skipBtn.addEventListener("click", () => loadImageAt(state.index + 1));
els.saveBtn.addEventListener("click", () => saveCurrent(false));
els.saveNextBtn.addEventListener("click", () => saveCurrent(true));

// Settings
els.settingsBtn.addEventListener("click", () => els.settingsModal.classList.remove("hidden"));
els.settingsClose.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
els.settingsModal.addEventListener("click", (e) => {
  if (e.target === els.settingsModal) els.settingsModal.classList.add("hidden");
});
els.themeSelect.addEventListener("change", () => {
  settings.theme = els.themeSelect.value;
  localStorage.setItem("bbox.theme", settings.theme);
  applySettings();
});
els.lineColor.addEventListener("input", () => {
  settings.lineColor = els.lineColor.value;
  localStorage.setItem("bbox.lineColor", settings.lineColor);
  refreshDrawColor();
  redraw();
});
els.randomColors.addEventListener("change", () => {
  settings.randomColors = els.randomColors.checked;
  localStorage.setItem("bbox.randomColors", settings.randomColors ? "1" : "0");
  els.lineColor.disabled = settings.randomColors;
  // Re-color existing boxes so the display is consistent with the new mode.
  state.boxes.forEach((b) => {
    b.color = settings.randomColors ? randomColor() : settings.lineColor;
  });
  refreshDrawColor();
  renderBoxList();
  redraw();
});
els.lineWidth.addEventListener("input", () => {
  settings.lineWidth = parseInt(els.lineWidth.value, 10);
  els.lineWidthVal.textContent = settings.lineWidth;
  localStorage.setItem("bbox.lineWidth", settings.lineWidth);
  redraw();
});

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "Enter" && pending) { els.confirmBox.click(); }
  else if (e.key === "Escape" && pending) { els.cancelBox.click(); }
  else if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCurrent(false); }
});

// Keep canvas aligned with the image when the window resizes.
window.addEventListener("resize", () => { if (state.natW) syncCanvasSize(); });

// Restore remembered dirs on startup.
(async function init() {
  applySettings();
  try {
    const s = await api("/api/state");
    if (s.source_dir) els.sourceDir.value = s.source_dir;
    if (s.output_dir) els.outputDir.value = s.output_dir;
  } catch (e) { /* ignore */ }
})();
