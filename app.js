"use strict";

const $ = id => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const SAMPLE = {
  head: { text: "AXI4-Lite 写响应示例", tick: 0 },
  signal: [
    { name: "ACLK", wave: "p..............." },
    { name: "ARESETn", wave: "0.1............." },
    { name: "AWVALID", wave: "0..1..0........." },
    { name: "AWREADY", wave: "0....10........." },
    { name: "WVALID", wave: "0...1...0......." },
    { name: "WREADY", wave: "0......10......." },
    { name: "WDATA", wave: "x...=...x.......", data: ["0x2A"] },
    { name: "BVALID", wave: "0........1...0.." },
    { name: "BREADY", wave: "1...0.......1..." }
  ]
};

let model;
let tool = "select";
let selected = { row: -1, cell: -1 };
let selectedAnnotation = -1;
let selectedRange = null;
let internalClipboard = null;
let clipboardWritePending = Promise.resolve();
let clipboardFallbackOnce = false;
let scale = 1;
let history = [];
let future = [];
let drag = null;
let codeDirty = false;
let currentView = "canvas";
let rowId = 1;
let tabs = [];
let activeTabId = 0;
let nextTabId = 1;
let closedTabs = [];
let annotationEditor = null;
let lastAnnotationClick = null;
let lastBusClick = null;

const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function parseWaveJSON(source) {
  const doc = typeof source === "string" ? JSON.parse(source) : source;
  if (!doc || !Array.isArray(doc.signal)) throw Error("需要包含 signal 数组的 WaveJSON 对象。 ");
  if (doc.edge?.length) throw Error("当前版本尚未绘制 WaveDrom edge 箭头，请先移除 edge。 ");
  const rows = [];
  const savedCycles = Number(doc._timingStudio?.cycles);
  let maxCycles = Number.isInteger(savedCycles) && savedCycles >= 2 ? savedCycles : 2;
  for (const item of doc.signal) {
    if (Array.isArray(item)) throw Error("当前版本暂不支持 WaveDrom 分组数组。 ");
    if (!item || typeof item !== "object" || !item.name) throw Error("每一行需要 name 和 wave。 ");
    if (typeof item.wave !== "string" || !item.wave.length) throw Error(`${item.name} 缺少 wave 字符串。`);
    const clock = /^[pPnN]/.test(item.wave);
    const raw = [];
    const labels = [];
    const busBreaks = {};
    const data = Array.isArray(item.data) ? item.data.map(String) : typeof item.data === "string" ? item.data.trim().split(/\s+/) : [];
    let di = 0;
    let previous = clock ? "clock" : "x";
    for (const char of item.wave) {
      if (clock && "pPnN".includes(char)) { raw.push("clock"); labels.push(""); continue; }
      if (char === ".") { raw.push(previous); labels.push(raw.length > 1 ? labels[labels.length - 1] : ""); continue; }
      if (!"01xzud=23456789".includes(char)) throw Error(`${item.name} 含暂不支持的 wave 字符：${char}`);
      previous = "=23456789".includes(char) ? "bus" : char;
      if (previous === "bus" && raw.at(-1) === "bus") busBreaks[raw.length] = true;
      raw.push(previous);
      labels.push(previous === "bus" ? (data[di++] ?? "") : "");
    }
    if (clock && raw.some(s => s !== "clock")) throw Error(`${item.name} 的时钟行请只使用 p/n 和句点。`);
    const kind = clock ? "clock" : raw.some(s => s === "bus") ? "bus" : "signal";
    const row = { id: rowId++, name: String(item.name), kind, cells: raw, labels, busBreaks, edgeOffsets: {},
      period: Number(item.period) > 0 ? Number(item.period) : 1,
      phase: Number.isFinite(Number(item.phase)) ? Number(item.phase) : 0,
      polarity: /^[nN]/.test(item.wave) ? "n" : "p" };
    rows.push(row);
    maxCycles = Math.max(maxCycles, raw.length);
  }
  if (maxCycles > 256) throw Error("当前最多支持 256 个时间格。 ");
  const cycles = clamp(maxCycles, 2, 256);
  for (const row of rows) fillRow(row, cycles);
  const preciseEdges = doc._timingStudio?.preciseEdges ?? [];
  if (!Array.isArray(preciseEdges)) throw Error("_timingStudio.preciseEdges 必须是数组。 ");
  for (const item of preciseEdges) {
    const ri = Number(item.row), edge = Number(item.edge), offset = Number(item.offset);
    if (!Number.isInteger(ri) || !rows[ri] || rows[ri].kind === "clock" || !Number.isInteger(edge) || !isEdge(rows[ri], edge) || !Number.isFinite(offset) || Math.abs(offset) >= 1)
      throw Error("精细边沿的 row、edge 或 offset 无效。 ");
    rows[ri].edgeOffsets[edge] = offset;
  }
  const annotations = doc._timingStudio?.annotations ?? [];
  if (!Array.isArray(annotations)) throw Error("_timingStudio.annotations 必须是数组。 ");
  const notes = annotations.map((note, index) => {
    if (!note || typeof note.text !== "string" || !Number.isFinite(Number(note.x)) || !Number.isFinite(Number(note.y)))
      throw Error(`第 ${index + 1} 条批注需要 text、x、y。`);
    return { text: note.text, x: Number(note.x), y: Number(note.y) };
  });
  return { title: String(doc.head?.text || "时序图"), cycles, rows, annotations: notes };
}

function fillRow(row, cycles) {
  const state = row.cells.at(-1) || (row.kind === "clock" ? "clock" : "x");
  const label = row.labels.at(-1) || "";
  row.cells = row.cells.slice(0, cycles);
  row.labels = row.labels.slice(0, cycles);
  while (row.cells.length < cycles) { row.cells.push(state); row.labels.push(label); }
  pruneOffsets(row);
}

function isEdge(row, i) {
  return i > 0 && i < row.cells.length && (row.cells[i] !== row.cells[i - 1] || row.labels[i] !== row.labels[i - 1] || row.busBreaks?.[i]);
}
function pruneOffsets(row) {
  row.busBreaks ||= {};
  for (const edge of Object.keys(row.busBreaks)) {
    const i = Number(edge);
    if (i <= 0 || i >= row.cells.length || row.cells[i - 1] !== "bus" || row.cells[i] !== "bus") delete row.busBreaks[edge];
  }
  row.edgeOffsets ||= {};
  for (const edge of Object.keys(row.edgeOffsets)) if (!isEdge(row, Number(edge))) delete row.edgeOffsets[edge];
}

function toWaveJSON(sourceModel = model) {
  const result = {
    head: { text: sourceModel.title, tick: 0 },
    signal: sourceModel.rows.map(row => {
      if (row.kind === "clock") {
        const out = { name: row.name, wave: row.polarity + ".".repeat(sourceModel.cycles - 1) };
        if (row.period !== 1) out.period = row.period;
        if (row.phase !== 0) out.phase = row.phase;
        return out;
      }
      let wave = "";
      const data = [];
      for (let i = 0; i < sourceModel.cycles; i++) {
        const state = row.cells[i];
        const label = row.labels[i] || "";
        const changed = i === 0 || isEdge(row, i);
        if (!changed) wave += ".";
        else if (state === "bus") { wave += "="; data.push(label); }
        else wave += state;
      }
      const out = { name: row.name, wave };
      if (data.some(Boolean)) out.data = data;
      return out;
    })
  };
  const preciseEdges = sourceModel.rows.flatMap((row, ri) => Object.entries(row.edgeOffsets || {}).map(([edge, offset]) => ({ row: ri, edge: Number(edge), offset })));
  result._timingStudio = { cycles: sourceModel.cycles };
  if (sourceModel.annotations.length) result._timingStudio.annotations = sourceModel.annotations.map(note => ({ text: note.text, x: note.x, y: note.y }));
  if (preciseEdges.length) result._timingStudio.preciseEdges = preciseEdges;
  return result;
}

function checkpoint() {
  history.push(clone(model));
  if (history.length > 80) history.shift();
  future = [];
}

function setStatus(message) { $("status").textContent = message; }
function setCodeMessage(message, error = false) {
  $("codeMessage").textContent = message;
  $("codeMessage").classList.toggle("error", error);
}
function syncCode() {
  $("code").value = JSON.stringify(toWaveJSON(), null, 2);
  codeDirty = false;
  setCodeMessage("代码与画布已同步。修改后切回“画布”或点击“应用并查看画布”。");
}
function makeTab(tabModel, id = nextTabId++) {
  return {
    id, model: tabModel, history: [], future: [],
    selected: { row: -1, cell: -1 }, selectedAnnotation: -1, selectedRange: null,
    scale: 1, codeText: JSON.stringify(toWaveJSON(tabModel), null, 2), codeDirty: false,
    scrollLeft: 0, scrollTop: 0, view: "canvas"
  };
}
function activeTab() { return tabs.find(tab => tab.id === activeTabId); }
function captureActiveTab() {
  const tab = activeTab(); if (!tab) return;
  Object.assign(tab, {
    model, history, future, selected, selectedAnnotation, selectedRange, scale, codeDirty,
    codeText: $("code").value, view: currentView,
    scrollLeft: currentView === "canvas" ? $("canvasScroll").scrollLeft : tab.scrollLeft,
    scrollTop: currentView === "canvas" ? $("canvasScroll").scrollTop : tab.scrollTop
  });
}
function restoreTab(tab) {
  activeTabId = tab.id;
  model = tab.model; history = tab.history; future = tab.future;
  selected = tab.selected; selectedAnnotation = tab.selectedAnnotation;
  selectedRange = tab.selectedRange; scale = tab.scale;
  codeDirty = tab.codeDirty; drag = null;
  updateView(tab.view || "canvas");
  $("code").value = tab.codeText;
  setCodeMessage(codeDirty ? "代码尚未应用。切回“画布”或点击“应用并查看画布”。" : "代码与画布已同步。修改后切回“画布”或点击“应用并查看画布”。");
  render();
  $("canvasScroll").scrollLeft = tab.scrollLeft || 0;
  $("canvasScroll").scrollTop = tab.scrollTop || 0;
  $("undoBtn").disabled = history.length === 0;
  $("redoBtn").disabled = future.length === 0;
  renderTabs();
}
function renderTabs() {
  const list = $("tabList"); list.replaceChildren();
  for (const tab of tabs) {
    const wrapper = document.createElement("div");
    wrapper.className = `canvas-tab${tab.id === activeTabId ? " active" : ""}`;
    wrapper.setAttribute("role", "presentation");
    const name = document.createElement("button");
    name.type = "button"; name.className = "tab-name";
    name.textContent = tab.model.title + (tab.codeDirty ? " •" : "");
    name.title = `切换到 ${tab.model.title}（双击重命名）`;
    name.setAttribute("role", "tab"); name.setAttribute("aria-selected", String(tab.id === activeTabId));
    name.addEventListener("click", () => switchTab(tab.id));
    name.addEventListener("dblclick", () => { switchTab(tab.id); $("canvasName").focus(); $("canvasName").select(); });
    const close = document.createElement("button");
    close.type = "button"; close.className = "tab-close"; close.textContent = "×";
    close.title = `关闭 ${tab.model.title}`; close.setAttribute("aria-label", `关闭 ${tab.model.title}`);
    close.addEventListener("click", () => closeTab(tab.id));
    wrapper.append(name, close); list.append(wrapper);
  }
}
function switchTab(id) {
  if (id === activeTabId) return;
  finishAnnotationEdit();
  const tab = tabs.find(item => item.id === id); if (!tab) return;
  captureActiveTab(); restoreTab(tab); setStatus("已切换画布"); saveLocal();
}
function newTab(tabModel, focusName = !tabModel) {
  finishAnnotationEdit();
  captureActiveTab();
  const blank = tabModel || { title: `新画布 ${nextTabId}`, cycles: 16, rows: [], annotations: [] };
  const tab = makeTab(blank); tabs.push(tab); restoreTab(tab);
  setStatus("已新建画布"); saveLocal();
  if (focusName) { $("canvasName").focus(); $("canvasName").select(); }
}
function closeTab(id) {
  finishAnnotationEdit();
  captureActiveTab();
  const index = tabs.findIndex(tab => tab.id === id); if (index < 0) return;
  closedTabs.push(tabs.splice(index, 1)[0]);
  if (closedTabs.length > 10) closedTabs.shift();
  if (!tabs.length) tabs.push(makeTab({ title: `新画布 ${nextTabId}`, cycles: 16, rows: [], annotations: [] }));
  if (id === activeTabId) restoreTab(tabs[Math.min(index, tabs.length - 1)]);
  else renderTabs();
  setStatus("画布已关闭（Ctrl+Shift+T 可恢复）"); saveLocal();
}
function reopenClosedTab() {
  finishAnnotationEdit();
  const tab = closedTabs.pop(); if (!tab) return;
  captureActiveTab(); tabs.push(tab); restoreTab(tab); setStatus("已恢复画布"); saveLocal();
}
function renameActiveTab() {
  const name = $("canvasName").value.trim().slice(0, 80);
  if (!name || name === model.title) { $("canvasName").value = model.title; return; }
  if (!canVisualEdit()) { $("canvasName").value = model.title; return; }
  checkpoint(); model.title = name; refresh("画布已重命名");
}
function refresh(message = "已更新") {
  render(); syncCode(); setStatus(message); saveLocal(); renderTabs();
  $("undoBtn").disabled = history.length === 0;
  $("redoBtn").disabled = future.length === 0;
}
function saveLocal() {
  captureActiveTab();
  try {
    localStorage.setItem("timing-studio-tabs-v1", JSON.stringify({
      activeTabId,
      tabs: tabs.map(tab => ({ id: tab.id, doc: toWaveJSON(tab.model), codeText: tab.codeDirty ? tab.codeText : undefined, codeDirty: tab.codeDirty, view: tab.view }))
    }));
  } catch {}
}
function canVisualEdit() {
  if (!codeDirty) return true;
  if (!confirm("代码区有尚未应用的修改。继续绘制会覆盖这些修改，确定继续吗？")) return false;
  codeDirty = false; return true;
}

function svg(tag, attrs = {}, parent = $("diagram")) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  parent.appendChild(el);
  return el;
}

function render() {
  const root = $("diagram");
  root.replaceChildren();
  if (document.activeElement !== $("canvasName")) $("canvasName").value = model.title;
  const cellW = 44 * scale, nameW = 150, top = 80, rowH = 62;
  const bounds = model.annotations.map(note => ({
    right: nameW + note.x * cellW + annotationWidth(note.text) + 20,
    bottom: note.y + (note.text.split("\n").length - 1) * 18 + 25
  }));
  const width = Math.max(nameW + model.cycles * cellW + 30, $("canvasScroll").clientWidth - 36, ...bounds.map(b => b.right));
  const height = Math.max(top + model.rows.length * rowH + 35, $("canvasScroll").clientHeight - 36, ...bounds.map(b => b.bottom));
  root.setAttribute("width", width);
  root.setAttribute("height", height);
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg("rect", { x: 0, y: 0, width, height, fill: "#fff", rx: 10 });
  svg("text", { x: 18, y: 30, fill: "#253653", "font-size": 16, "font-weight": 700 }).textContent = model.title;
  svg("line", { x1: nameW, x2: nameW, y1: 45, y2: height - 17, stroke: "#d8e1ee" });
  for (let i = 0; i <= model.cycles; i++) {
    const x = nameW + i * cellW;
    svg("line", { x1: x, x2: x, y1: 54, y2: height - 18, stroke: i % 2 ? "#f0f3f8" : "#e7edf5", "stroke-dasharray": i ? "3 5" : "none" });
    if (i < model.cycles) svg("text", { x: x + cellW / 2, y: 64, fill: "#91a1b5", "font-size": 10, "text-anchor": "middle" }).textContent = String(i);
  }
  model.rows.forEach((row, ri) => {
    const busLabelHits = [];
    const edgeX = i => nameW + (i + (row.edgeOffsets?.[i] || 0)) * cellW;
    const y = top + ri * rowH;
    if (ri === selected.row) svg("rect", { x: 0, y: y - 7, width, height: rowH, fill: "#f4f8ff", "data-export-ignore": "" });
    svg("line", { x1: 0, x2: width, y1: y + rowH - 7, y2: y + rowH - 7, stroke: "#edf1f6" });
    svg("rect", { x: 0, y: y - 7, width: nameW, height: rowH, fill: "transparent", "data-row": ri, "data-part": "name", style: "cursor:grab" });
    const label = svg("text", { x: 17, y: y + 29, fill: "#253653", "font-size": 12, "font-weight": 600, "data-row": ri, "data-part": "name", style: "cursor:grab" });
    label.textContent = row.name;
    svg("text", { x: 17, y: y + 44, fill: "#9aa9ba", "font-size": 10 }).textContent = row.kind === "clock" ? "CLK" : row.kind === "bus" ? "BUS" : "SIGNAL";
    const cy = y + 26, high = cy - 13, low = cy + 13;
    if (row.kind === "clock") {
      const periodPx = row.period * cellW;
      const half = periodPx / 2;
      const offset = row.phase * cellW;
      let path = "";
      let prevY = null;
      for (let x = nameW; x <= nameW + model.cycles * cellW; x += Math.max(1, Math.min(half, cellW / 10))) {
        const t = ((x - nameW - offset) % periodPx + periodPx) % periodPx;
        const h = row.polarity === "p" ? t < half : t >= half;
        const yy = h ? high : low;
        if (prevY === null) path += `M${x} ${yy}`;
        else if (yy !== prevY) path += ` L${x} ${prevY} L${x} ${yy}`;
        else path += ` L${x} ${yy}`;
        prevY = yy;
      }
      svg("path", { d: path, fill: "none", stroke: "#356ecc", "stroke-width": 2.4, "stroke-linejoin": "round" });
    } else {
      const busWing = i => {
        if (row.kind !== "bus" || !isEdge(row, i) || (row.cells[i - 1] !== "bus" && row.cells[i] !== "bus")) return 0;
        return Math.min(8, (edgeX(i) - edgeX(i - 1)) / 3, (edgeX(i + 1) - edgeX(i)) / 3);
      };
      const envelope = state => row.kind === "bus" && (state === "bus" || state === "x");
      const levelY = state => state === "1" || state === "u" ? high : state === "0" || state === "d" ? low : cy;
      for (let i = 0; i < model.cycles; i++) {
        const x = edgeX(i), end = edgeX(i + 1), span = end - x, state = row.cells[i], prev = i ? row.cells[i - 1] : state;
        const color = state === "bus" ? "#148b89" : state === "x" ? "#c38130" : state === "z" ? "#8b72ae" : "#376fca";
        const start = x + (envelope(state) ? busWing(i) : 0), stop = end - (envelope(state) ? busWing(i + 1) : 0);
        if (row.kind === "bus" && (state === "bus" || state === "x")) {
          if (state === "bus") {
            const leftY = envelope(prev) ? cy : levelY(prev);
            const next = row.cells[i + 1] || state;
            const rightY = envelope(next) ? cy : levelY(next);
            svg("path", { d: `M${start} ${high} L${stop} ${high} L${end} ${rightY} L${stop} ${low} L${start} ${low} L${x} ${leftY} Z`, fill: "#effaf8", "data-bus-fill": "" });
          }
          if (state === "x") svg("rect", { x, y: high, width: span, height: low - high, fill: "#fff5e8" });
          svg("line", { x1: start, x2: stop, y1: high, y2: high, stroke: color, "stroke-width": 2.3 });
          svg("line", { x1: start, x2: stop, y1: low, y2: low, stroke: color, "stroke-width": 2.3 });
        } else if (state === "x") {
          svg("rect", { x, y: high + 1, width: span, height: low - high - 2, fill: "#fff5e8" });
          svg("path", { d: `M${x} ${high + 1} L${end} ${low - 1} M${x} ${low - 1} L${end} ${high + 1}`, stroke: color, "stroke-width": 1.3 });
        } else {
          const yy = state === "1" || state === "u" ? high : state === "0" || state === "d" ? low : cy;
          svg("line", { x1: start, x2: stop, y1: yy, y2: yy, stroke: color, "stroke-width": 2.3, "stroke-dasharray": "zud".includes(state) ? "5 4" : "none" });
        }
        const wing = busWing(i);
        if (wing) {
          let d;
          if (envelope(prev) && envelope(state)) d = `M${x - wing} ${high} L${x + wing} ${low} M${x - wing} ${low} L${x + wing} ${high}`;
          else if (envelope(state)) d = `M${x + wing} ${high} L${x} ${levelY(prev)} L${x + wing} ${low}`;
          else d = `M${x - wing} ${high} L${x} ${levelY(state)} L${x - wing} ${low}`;
          svg("path", { d, fill: "none", stroke: "#148b89", "stroke-width": 2.3, "stroke-linejoin": "round", "data-bus-boundary": i });
        }
        if (i > 0 && prev !== state && "01".includes(prev) && "01".includes(state)) {
          svg("line", { x1: x, x2: x, y1: levelY(prev), y2: levelY(state), stroke: "#376fca", "stroke-width": 2.3 });
        }
        if (selectedRange?.row === ri && i >= Math.min(selectedRange.start, selectedRange.end) && i <= Math.max(selectedRange.start, selectedRange.end))
          svg("rect", { x: x + 2, y: y + 1, width: Math.max(1, span - 4), height: 47, rx: 5, fill: "#cfe0ff55", stroke: "#80a8ec", "stroke-width": 1.5, "stroke-dasharray": "4 3", "data-export-ignore": "" });
      }
      // Center each value in its continuous bus segment, including moved edges.
      for (let start = 0; start < model.cycles;) {
        let end = start + 1;
        while (end < model.cycles && !isEdge(row, end)) end++;
        if (row.cells[start] === "bus" && row.labels[start]) {
          const left = edgeX(start) + busWing(start) + 3;
          const right = edgeX(end) - busWing(end) - 3;
          const text = svg("text", { x: (left + right) / 2, y: cy + 4, fill: "#116c6b", "font-size": 12, "text-anchor": "middle", "pointer-events": "none", "data-bus-label": "", "data-full-value": row.labels[start] });
          text.textContent = row.labels[start];
          const available = Math.max(1, right - left);
          if (text.getComputedTextLength() > available) {
            const characters = [...row.labels[start]];
            do { characters.pop(); text.textContent = characters.join("") + "…"; } while (characters.length && text.getComputedTextLength() > available);
            if (text.getComputedTextLength() > available) text.textContent = "";
          }
          busLabelHits.push({ left, width: Math.max(1, right - left), value: row.labels[start] });
        }
        start = end;
      }
    }
    svg("rect", { x: nameW, y: y - 5, width: model.cycles * cellW, height: 52, fill: "transparent", "data-row": ri, "data-part": "wave", style: tool === "select" ? "cursor:crosshair" : "cursor:cell" });
    for (const hit of busLabelHits) {
      const area = svg("rect", { x: hit.left, y: high + 1, width: hit.width, height: low - high - 2, fill: "transparent", "data-row": ri, "data-part": "wave" });
      svg("title", {}, area).textContent = hit.value;
    }
    // Edge hit areas must be above the row's general hit area.
    if (row.kind !== "clock" && tool === "select") for (let i = 1; i < model.cycles; i++) {
      if (!isEdge(row, i)) continue;
      svg("rect", { x: edgeX(i) - 7, y: y - 5, width: 14, height: 52, fill: "transparent", "data-row": ri, "data-edge": i, style: "cursor:ew-resize" });
    }
  });
  model.annotations.forEach((note, index) => {
    const x = nameW + note.x * cellW;
    const y = note.y;
    const width = annotationWidth(note.text);
    const lines = note.text.split("\n");
    const group = svg("g", { "data-annotation": index, style: "cursor:move" });
    svg("rect", { x, y: y - 18, width, height: 27 + (lines.length - 1) * 18, rx: 5, fill: "#fff8df", stroke: selectedAnnotation === index ? "#d38c1c" : "#e4c988", "stroke-width": selectedAnnotation === index ? 2 : 1 }, group);
    const text = svg("text", { x: x + 8, y, fill: "#76521d", "font-size": 12, "pointer-events": "none" }, group);
    lines.forEach((line, i) => svg("tspan", { x: x + 8, y: y + i * 18 }, text).textContent = line);
  });
  $("zoomLabel").textContent = `${Math.round(scale * 100)}%`;
  $("cyclesInput").value = model.cycles;
  updateProperties();
}

function updateProperties() {
  const box = $("properties");
  if (selectedAnnotation >= 0) {
    const note = model.annotations[selectedAnnotation];
    box.innerHTML = `<div class="row-meta">独立批注 · 第 ${selectedAnnotation + 1} 条</div><label>批注文字<input id="propAnnotation" value="${esc(note.text)}"></label><p class="muted">使用选择工具拖动批注。批注不改变任何总线值或波形。</p>`;
    box.querySelector("input").addEventListener("change", onPropertyChange);
    $("selectionInfo").textContent = `批注：${note.text}`;
    $("deleteBtn").textContent = "删除批注";
    $("moveUpBtn").disabled = true; $("moveDownBtn").disabled = true;
    return;
  }
  $("deleteBtn").textContent = selected.cell >= 0 && model.rows[selected.row]?.kind !== "clock" ? "清空选中波形" : "删除行";
  $("moveUpBtn").disabled = selected.row <= 0;
  $("moveDownBtn").disabled = selected.row < 0 || selected.row >= model.rows.length - 1;
  const row = model.rows[selected.row];
  if (!row) { box.innerHTML = '<p class="muted">点击信号名或波形段以编辑属性。</p>'; $("selectionInfo").textContent = "未选择"; return; }
  const rangeText = selectedRange?.row === selected.row && selectedRange.start !== selectedRange.end
    ? ` · 时间格 ${Math.min(selectedRange.start, selectedRange.end)}–${Math.max(selectedRange.start, selectedRange.end)}`
    : selected.cell >= 0 ? ` · 时间格 ${selected.cell}` : "";
  $("selectionInfo").textContent = `${row.name}${rangeText}`;
  let html = `<div class="row-meta">${row.kind === "clock" ? "时钟" : row.kind === "bus" ? "总线" : "数字信号"} · 第 ${selected.row + 1} 行</div><label>名称<input id="propName" value="${esc(row.name)}"></label>`;
  if (row.kind === "clock") html += `<label>周期（格）<input id="propPeriod" type="number" min="0.5" max="64" step="0.5" value="${row.period}"></label><label>相位（格）<input id="propPhase" type="number" step="0.25" value="${row.phase}"></label><label>起始边沿<select id="propPolarity"><option value="p" ${row.polarity === "p" ? "selected" : ""}>上升</option><option value="n" ${row.polarity === "n" ? "selected" : ""}>下降</option></select></label>`;
  else if (selected.cell >= 0) {
    const state = row.cells[selected.cell];
    html += `<label>当前状态<select id="propState">${["0", "1", "x", "z", "u", "d", "bus"].map(s => `<option value="${s}" ${state === s ? "selected" : ""}>${({ 0: "0 低", 1: "1 高", x: "X 未知", z: "Z 高阻", u: "U 弱高", d: "D 弱低", bus: "总线燕尾" })[s]}</option>`).join("")}</select></label>`;
    if (state === "bus") {
      const bounds = busValueBounds(row);
      html += `<label>总线值（时间格 ${bounds.start}–${bounds.end}）<input id="propBusValue" value="${esc(row.labels[selected.cell] || "")}" placeholder="例如 0x2A、DATA0"></label><p class="muted">默认修改整段总线，可跨多个时钟。需要中途换值时先添加分界；拖选区间可只修改该区间。</p>`;
      if (selected.cell > 0 && row.cells[selected.cell - 1] === "bus") html += `<button id="toggleBusBreak">${row.busBreaks?.[selected.cell] ? "取消" : "添加"}本格前的手动分界</button>`;
    }
  }
  box.innerHTML = html;
  box.querySelectorAll("input,select").forEach(input => input.addEventListener("change", onPropertyChange));
  if ($("toggleBusBreak")) $("toggleBusBreak").onclick = () => toggleBusBreak(selected.row, selected.cell);
}

function toggleBusBreak(ri, edge) {
  const row = model.rows[ri];
  if (!row || edge <= 0 || edge >= model.cycles || row.cells[edge - 1] !== "bus" || row.cells[edge] !== "bus") { setStatus("请在相邻总线格的边界处添加分界"); return; }
  if (!canVisualEdit()) return;
  checkpoint(); row.busBreaks ||= {};
  if (row.busBreaks[edge]) delete row.busBreaks[edge]; else row.busBreaks[edge] = true;
  pruneOffsets(row); refresh("总线分界已修改；不同值仍保留自动分界");
}

function editBusValue(ri, cell) {
  const row = model.rows[ri];
  if (row?.cells[cell] !== "bus" || !canVisualEdit()) return;
  let start = cell, end = cell;
  while (start > 0 && !isEdge(row, start)) start--;
  while (end + 1 < model.cycles && !isEdge(row, end + 1)) end++;
  selected = { row: ri, cell }; selectedAnnotation = -1;
  selectedRange = { row: ri, start, end }; drag = null; render();
  $("propBusValue").focus(); $("propBusValue").select();
}

function busValueBounds(row) {
  if (selectedRange?.row === selected.row && selectedRange.start !== selectedRange.end) {
    return { start: Math.min(selectedRange.start, selectedRange.end), end: Math.max(selectedRange.start, selectedRange.end) };
  }
  let start = selected.cell, end = selected.cell;
  while (start > 0 && !isEdge(row, start)) start--;
  while (end + 1 < model.cycles && !isEdge(row, end + 1)) end++;
  return { start, end };
}

function onPropertyChange(event) {
  if (!canVisualEdit()) { updateProperties(); return; }
  if (selectedAnnotation >= 0 && event.target.id === "propAnnotation") {
    checkpoint(); model.annotations[selectedAnnotation].text = event.target.value.trim() || "批注"; refresh("批注已修改"); return;
  }
  const row = model.rows[selected.row]; if (!row) return;
  checkpoint();
  const id = event.target.id, value = event.target.value;
  if (id === "propName") row.name = value.trim() || row.name;
  if (id === "propPeriod") row.period = clamp(Number(value) || 1, .5, 64);
  if (id === "propPhase") row.phase = Number(value) || 0;
  if (id === "propPolarity") row.polarity = value;
  if (id === "propState") { row.cells[selected.cell] = value; row.labels[selected.cell] = ""; if (value === "bus") row.kind = "bus"; pruneOffsets(row); }
  if (id === "propBusValue") {
    const { start, end } = busValueBounds(row);
    for (let i = start; i <= end; i++) if (row.cells[i] === "bus") row.labels[i] = value;
    pruneOffsets(row);
  }
  refresh("属性已修改");
}

function annotationWidth(text) {
  return Math.max(42, ...text.split("\n").map(line => [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 13 : 7), 0) + 16));
}
function finishAnnotationEdit(cancel = false) {
  if (!annotationEditor) return;
  const edit = annotationEditor;
  annotationEditor = null;
  const text = edit.input.value.trim().slice(0, 300);
  edit.panel.remove();
  if (cancel || !text) { setStatus("已取消批注输入"); return; }
  if (edit.index >= 0 && text === model.annotations[edit.index]?.text) return;
  checkpoint();
  if (edit.index >= 0) { model.annotations[edit.index].text = text; selectedAnnotation = edit.index; }
  else { model.annotations.push({ text, x: edit.x, y: edit.y }); selectedAnnotation = model.annotations.length - 1; }
  selected = { row: -1, cell: -1 }; selectedRange = null;
  refresh(edit.index >= 0 ? "批注已修改" : "批注已添加");
}
function editAnnotation(clientX, clientY, index = -1) {
  finishAnnotationEdit();
  if (!canVisualEdit()) return;
  const rect = $("diagram").getBoundingClientRect();
  const note = model.annotations[index];
  const x = note ? note.x : Math.max(-150 / (44 * scale), (clientX - rect.left - 150) / (44 * scale));
  const y = note ? note.y : Math.max(18, clientY - rect.top + 18);
  const scroll = $("canvasScroll"), area = scroll.getBoundingClientRect();
  const input = document.createElement("textarea");
  const panel = document.createElement("div");
  panel.className = "annotation-editor-panel";
  input.id = "annotationEditor"; input.className = "annotation-editor";
  input.setAttribute("aria-label", "批注文字输入"); input.placeholder = "输入批注，Enter 确认";
  input.maxLength = 300; input.value = note?.text || "";
  panel.style.left = `${rect.left - area.left + scroll.scrollLeft + 150 + x * 44 * scale}px`;
  panel.style.top = `${rect.top - area.top + scroll.scrollTop + y - 18}px`;
  const actions = document.createElement("div"); actions.className = "annotation-editor-actions";
  const confirmButton = document.createElement("button"), cancelButton = document.createElement("button");
  confirmButton.type = cancelButton.type = "button";
  confirmButton.textContent = "确认"; cancelButton.textContent = "取消";
  confirmButton.setAttribute("aria-label", "确认批注"); cancelButton.setAttribute("aria-label", "取消批注");
  confirmButton.addEventListener("click", () => finishAnnotationEdit());
  cancelButton.addEventListener("click", () => finishAnnotationEdit(true));
  actions.append(confirmButton, cancelButton); panel.append(input, actions);
  annotationEditor = { input, panel, index, x, y };
  scroll.append(panel); input.focus(); input.select();
  panel.addEventListener("pointerdown", event => event.stopPropagation());
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finishAnnotationEdit(true); }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); finishAnnotationEdit(); }
  });
  setStatus("输入批注：Enter 确认，Shift+Enter 换行，Esc 取消");
}
function cellFromX(clientX) {
  const rect = $("diagram").getBoundingClientRect();
  return clamp(Math.floor((clientX - rect.left - 150) / (44 * scale)), 0, model.cycles - 1);
}
function timeFromX(clientX) {
  const rect = $("diagram").getBoundingClientRect();
  return (clientX - rect.left - 150) / (44 * scale);
}
function paint(rowIndex, a, b, state) {
  const row = model.rows[rowIndex]; if (!row || row.kind === "clock") return;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { row.cells[i] = state; row.labels[i] = ""; }
  if (state === "bus") row.kind = "bus";
  pruneOffsets(row);
}
function moveEdge(rowIndex, originalEdge, time, snapshot) {
  const row = model.rows[rowIndex], old = snapshot.rows[rowIndex];
  let left = originalEdge - 1, right = originalEdge;
  while (left > 0 && !isEdge(old, left)) left--;
  while (right + 1 < model.cycles && !isEdge(old, right + 1)) right++;
  const preciseTime = clamp(time, left + (old.edgeOffsets?.[left] || 0) + 0.2, right + 1 + (old.edgeOffsets?.[right + 1] || 0) - 0.2);
  const next = clamp(Math.round(preciseTime), left + 1, right);
  for (let i = left; i <= right; i++) {
    const source = i < next ? originalEdge - 1 : originalEdge;
    row.cells[i] = old.cells[source]; row.labels[i] = old.labels[source];
  }
  row.edgeOffsets = clone(old.edgeOffsets || {});
  row.busBreaks = clone(old.busBreaks || {});
  delete row.busBreaks[originalEdge];
  if (old.busBreaks?.[originalEdge]) row.busBreaks[next] = true;
  delete row.edgeOffsets[originalEdge];
  row.edgeOffsets[next] = Number((preciseTime - next).toFixed(3));
  pruneOffsets(row);
}

$("diagram").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  $("diagram").focus({ preventScroll: true });
  const annotation = event.target.closest("[data-annotation]");
  if (annotation) {
    if (tool === "annotation") { event.preventDefault(); editAnnotation(event.clientX, event.clientY, Number(annotation.dataset.annotation)); return; }
    const index = Number(annotation.dataset.annotation);
    if (tool === "select" && lastAnnotationClick?.index === index && performance.now() - lastAnnotationClick.time < 500 && Math.hypot(event.clientX - lastAnnotationClick.x, event.clientY - lastAnnotationClick.y) < 5) {
      event.preventDefault(); lastAnnotationClick = null;
      editAnnotation(event.clientX, event.clientY, index); return;
    }
    lastAnnotationClick = { index, time: performance.now(), x: event.clientX, y: event.clientY };
    selectedAnnotation = Number(annotation.dataset.annotation);
    selected = { row: -1, cell: -1 };
    selectedRange = null;
    if (tool === "select" && canVisualEdit()) {
      checkpoint(); drag = { type: "annotation", index: selectedAnnotation, startX: event.clientX, startY: event.clientY, snapshot: clone(model) };
    }
    render(); return;
  }
  if (tool === "annotation") {
    event.preventDefault();
    editAnnotation(event.clientX, event.clientY); return;
  }
  const hit = event.target.closest("[data-row]"); if (!hit) return;
  const ri = Number(hit.dataset.row), row = model.rows[ri];
  const edge = hit.dataset.edge === undefined ? null : Number(hit.dataset.edge);
  const cell = cellFromX(event.clientX);
  selected = { row: ri, cell: hit.dataset.part === "name" ? -1 : cell };
  selectedAnnotation = -1;
  if (hit.dataset.part === "name") {
    event.preventDefault(); selectedRange = null;
    drag = { type: "row", startX: event.clientX, startY: event.clientY, moved: false };
    render(); return;
  }
  if (tool === "busBreak") {
    selectedRange = null;
    const edge = clamp(Math.round(timeFromX(event.clientX)), 1, model.cycles - 1);
    selected.cell = edge; toggleBusBreak(ri, edge); render(); return;
  }
  if (tool === "select") {
    if (edge === null && row.cells[cell] === "bus") {
      if (lastBusClick?.row === row.id && lastBusClick.cell === cell && performance.now() - lastBusClick.time < 500 && Math.hypot(event.clientX - lastBusClick.x, event.clientY - lastBusClick.y) < 5) {
        event.preventDefault(); lastBusClick = null; editBusValue(ri, cell); return;
      }
      lastBusClick = { row: row.id, cell, time: performance.now(), x: event.clientX, y: event.clientY };
    } else lastBusClick = null;
    if (edge !== null && row.kind !== "clock" && canVisualEdit()) {
      selectedRange = null;
      checkpoint(); drag = { type: "edge", row: ri, edge, snapshot: clone(model) };
    } else {
      const start = event.shiftKey && selectedRange?.row === ri ? selectedRange.start : cell;
      selectedRange = { row: ri, start, end: cell };
      drag = { type: "select", row: ri, start };
      render();
    }
    return;
  }
  selectedRange = null;
  if (row.kind === "clock" || !canVisualEdit()) { render(); return; }
  const state = tool === "=" ? "bus" : tool;
  checkpoint(); drag = { type: "paint", row: ri, start: cell, state, snapshot: clone(model) };
  paint(ri, cell, cell, state); render();
});
document.addEventListener("pointermove", event => {
  if (!drag) return;
  if (drag.type === "row") {
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    if (!drag.moved) {
      if (!canVisualEdit()) { drag = null; return; }
      checkpoint(); drag.moved = true;
    }
    const scroll = $("canvasScroll"), bounds = scroll.getBoundingClientRect();
    if (event.clientY < bounds.top + 30) scroll.scrollTop -= 18;
    if (event.clientY > bounds.bottom - 30) scroll.scrollTop += 18;
    const rect = $("diagram").getBoundingClientRect();
    const to = clamp(Math.floor((event.clientY - rect.top - 73) / 62), 0, model.rows.length - 1);
    const from = selected.row;
    if (to !== from) { const [row] = model.rows.splice(from, 1); model.rows.splice(to, 0, row); selected.row = to; }
    render(); setStatus(`正在移动 ${model.rows[selected.row].name}`); return;
  }
  if (drag.type === "select") {
    selectedRange = { row: drag.row, start: drag.start, end: cellFromX(event.clientX) };
    selected.cell = selectedRange.end;
    render(); return;
  }
  if (drag.type === "annotation") {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) lastAnnotationClick = null;
    const note = model.annotations[drag.index], original = drag.snapshot.annotations[drag.index];
    note.x = Math.max(-150 / (44 * scale), original.x + (event.clientX - drag.startX) / (44 * scale));
    note.y = Math.max(18, original.y + event.clientY - drag.startY);
  }
  else if (drag.type === "edge") moveEdge(drag.row, drag.edge, timeFromX(event.clientX), drag.snapshot);
  else { model.rows[drag.row] = clone(drag.snapshot.rows[drag.row]); paint(drag.row, drag.start, cellFromX(event.clientX), drag.state); }
  render();
});
document.addEventListener("pointerup", () => {
  if (!drag) return;
  const type = drag.type, moved = drag.moved; drag = null;
  if (type === "row") { if (moved) refresh("信号顺序已修改"); else render(); return; }
  if (type === "select") { render(); setStatus("已选择波形区间"); return; }
  refresh(type === "annotation" ? "批注位置已修改" : "波形已修改");
});
$("diagram").addEventListener("dblclick", event => {
  const annotation = event.target.closest("[data-annotation]");
  if (annotation) { event.preventDefault(); editAnnotation(event.clientX, event.clientY, Number(annotation.dataset.annotation)); return; }
  if (tool === "annotation" || tool === "busBreak") return;
  const hit = event.target.closest("[data-row]"); if (!hit || hit.dataset.part === "name" || hit.dataset.edge !== undefined) return;
  const ri = Number(hit.dataset.row), row = model.rows[ri]; if (row.kind === "clock" || !canVisualEdit()) return;
  const cell = cellFromX(event.clientX); selected = { row: ri, cell };
  selectedAnnotation = -1;
  selectedRange = { row: ri, start: cell, end: cell };
  if (row.kind === "bus") {
    editBusValue(ri, cell);
  } else {
    checkpoint(); paint(ri, cell, cell, row.cells[cell] === "1" ? "0" : "1"); refresh("电平已切换");
  }
});
$("canvasScroll").addEventListener("pointerdown", event => {
  if (event.target === $("canvasScroll") && tool === "annotation") { event.preventDefault(); editAnnotation(event.clientX, event.clientY); }
});

function selectTool(value) {
  if (drag) return;
  finishAnnotationEdit();
  tool = value;
  $("tools").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.tool === value));
  const names = { select: "选择／拖边沿", "1": "高电平", "0": "低电平", x: "未知", z: "高阻", "=": "总线", annotation: "独立批注" };
  render(); setStatus(names[value]);
}
$("tools").addEventListener("click", event => {
  const button = event.target.closest("[data-tool]"); if (!button) return;
  selectTool(button.dataset.tool);
});

function addRow(kind) {
  if (!canVisualEdit()) return;
  checkpoint();
  const name = kind === "clock" ? `clk${model.rows.filter(r => r.kind === kind).length + 1}` : kind === "bus" ? `data${model.rows.filter(r => r.kind === kind).length + 1}` : `sig${model.rows.filter(r => r.kind === kind).length + 1}`;
  const state = kind === "clock" ? "clock" : kind === "bus" ? "bus" : "0";
  model.rows.push({ id: rowId++, name, kind, cells: Array(model.cycles).fill(state), labels: Array(model.cycles).fill(""), edgeOffsets: {}, period: 1, phase: 0, polarity: "p" });
  selected = { row: model.rows.length - 1, cell: -1 }; selectedAnnotation = -1; selectedRange = null; refresh("已添加行");
}
$("addClock").onclick = () => addRow("clock");
$("addSignal").onclick = () => addRow("signal");
$("addBus").onclick = () => addRow("bus");
$("cyclesInput").addEventListener("change", event => {
  const cycles = clamp(Math.round(Number(event.target.value) || model.cycles), 2, 256);
  if (cycles === model.cycles || !canVisualEdit()) { render(); return; }
  checkpoint(); model.cycles = cycles; model.rows.forEach(row => fillRow(row, cycles)); selected.cell = clamp(selected.cell, -1, cycles - 1);
  if (selectedRange) { selectedRange.start = clamp(selectedRange.start, 0, cycles - 1); selectedRange.end = clamp(selectedRange.end, 0, cycles - 1); }
  refresh("周期数已修改");
});
$("zoomIn").onclick = () => { scale = clamp(scale + .25, .5, 2.5); render(); };
$("zoomOut").onclick = () => { scale = clamp(scale - .25, .5, 2.5); render(); };
$("undoBtn").onclick = undo;
$("redoBtn").onclick = redo;
function undo() { if (!history.length) return; future.push(clone(model)); model = history.pop(); selected = { row: -1, cell: -1 }; selectedAnnotation = -1; selectedRange = null; refresh("已撤销"); }
function redo() { if (!future.length) return; history.push(clone(model)); model = future.pop(); selected = { row: -1, cell: -1 }; selectedAnnotation = -1; selectedRange = null; refresh("已重做"); }
$("moveUpBtn").onclick = () => moveSelected(-1);
$("moveDownBtn").onclick = () => moveSelected(1);
function moveSelected(delta) {
  const from = selected.row, to = from + delta;
  if (from < 0 || to < 0 || to >= model.rows.length || !canVisualEdit()) return;
  checkpoint(); [model.rows[from], model.rows[to]] = [model.rows[to], model.rows[from]]; selected.row = to;
  if (selectedRange?.row === from) selectedRange.row = to;
  refresh("行顺序已修改");
}
function deleteSelection() {
  if (!canVisualEdit()) return false;
  if (selectedAnnotation >= 0) {
    checkpoint(); model.annotations.splice(selectedAnnotation, 1); selectedAnnotation = -1; refresh("批注已删除"); return true;
  }
  const row = model.rows[selected.row]; if (!row) return false;
  if (selected.cell >= 0 && row.kind !== "clock") {
    const start = selectedRange?.row === selected.row ? Math.min(selectedRange.start, selectedRange.end) : selected.cell;
    const end = selectedRange?.row === selected.row ? Math.max(selectedRange.start, selectedRange.end) : selected.cell;
    checkpoint();
    for (let i = start; i <= end; i++) { row.cells[i] = row.kind === "bus" ? "x" : "0"; row.labels[i] = ""; }
    for (let i = start; i <= end + 1; i++) delete row.edgeOffsets[i];
    pruneOffsets(row); refresh("选中波形已清空"); return true;
  }
  checkpoint(); model.rows.splice(selected.row, 1); selected = { row: -1, cell: -1 }; selectedRange = null; refresh("已删除行"); return true;
}
$("deleteBtn").onclick = deleteSelection;

const CLIPBOARD_PREFIX = "TIMING_STUDIO_CLIPBOARD_V1:";
function selectionPayload() {
  if (selectedAnnotation >= 0) return { kind: "annotation", value: clone(model.annotations[selectedAnnotation]) };
  const row = model.rows[selected.row]; if (!row) return null;
  if (selected.cell < 0 || row.kind === "clock") return { kind: "row", value: clone(row) };
  const start = selectedRange?.row === selected.row ? Math.min(selectedRange.start, selectedRange.end) : selected.cell;
  const end = selectedRange?.row === selected.row ? Math.max(selectedRange.start, selectedRange.end) : selected.cell;
  const cells = row.cells.slice(start, end + 1).map((state, index) => ({ state, label: row.labels[start + index] || "", busBreak: !!row.busBreaks?.[start + index] }));
  const offsets = Object.entries(row.edgeOffsets || {}).filter(([edge]) => Number(edge) >= start && Number(edge) <= end)
    .map(([edge, offset]) => ({ edge: Number(edge) - start, offset }));
  return { kind: "cells", value: { cells, offsets } };
}
async function copySelection() {
  const payload = selectionPayload(); if (!payload) return false;
  internalClipboard = clone(payload);
  const content = CLIPBOARD_PREFIX + JSON.stringify(payload);
  try {
    clipboardWritePending = navigator.clipboard.writeText(content);
    await clipboardWritePending; clipboardFallbackOnce = false; setStatus("已复制到系统剪贴板");
  } catch {
    clipboardWritePending = Promise.resolve(); clipboardFallbackOnce = true; setStatus("已复制，可在画布内粘贴");
  }
  return true;
}
async function pasteSelection() {
  let payload = internalClipboard;
  try { await clipboardWritePending; } catch {}
  try {
    if (clipboardFallbackOnce && internalClipboard) { clipboardFallbackOnce = false; throw Error("使用内部剪贴板"); }
    const text = await navigator.clipboard.readText();
    if (text.startsWith(CLIPBOARD_PREFIX)) payload = JSON.parse(text.slice(CLIPBOARD_PREFIX.length));
    else if (text.trim()) payload = { kind: "annotation", value: { text: text.slice(0, 300), x: selected.cell >= 0 ? selected.cell : 1, y: selected.row >= 0 ? 100 + selected.row * 62 : 80 } };
  } catch {}
  if (!payload || !canVisualEdit()) return false;
  if (payload.kind === "row") {
    const row = clone(payload.value);
    if (!row || !["clock", "signal", "bus"].includes(row.kind) || !Array.isArray(row.cells) || !Array.isArray(row.labels)) return false;
    checkpoint(); row.id = rowId++; row.name = `${String(row.name || "signal")} 副本`; row.edgeOffsets ||= {}; fillRow(row, model.cycles);
    const index = selected.row >= 0 ? selected.row + 1 : model.rows.length;
    model.rows.splice(index, 0, row); selected = { row: index, cell: -1 }; selectedAnnotation = -1; selectedRange = null; refresh("行已粘贴"); return true;
  }
  if (payload.kind === "annotation") {
    const note = payload.value;
    if (!note || typeof note.text !== "string" || !note.text.trim()) return false;
    checkpoint(); model.annotations.push({ text: note.text.slice(0, 300), x: Math.max(-150 / (44 * scale), (Number(note.x) || 0) + .5), y: Math.max(18, (Number(note.y) || 60) + 26) });
    selectedAnnotation = model.annotations.length - 1; selected = { row: -1, cell: -1 }; selectedRange = null; refresh("批注已粘贴"); return true;
  }
  if (payload.kind === "cells") {
    const row = model.rows[selected.row], value = payload.value;
    if (!row || row.kind === "clock" || !value || !Array.isArray(value.cells) || value.cells.length < 1 || value.cells.length > 256) return false;
    if (value.cells.some(cell => !cell || !["0", "1", "x", "z", "u", "d", "bus"].includes(cell.state))) return false;
    const start = selected.cell >= 0 ? selected.cell : 0;
    checkpoint();
    row.busBreaks ||= {};
    value.cells.forEach((cell, i) => { if (start + i < model.cycles) { row.cells[start + i] = cell.state; row.labels[start + i] = String(cell.label || ""); delete row.busBreaks[start + i]; if (cell.busBreak === true) row.busBreaks[start + i] = true; } });
    if (value.cells.some(cell => cell.state === "bus")) row.kind = "bus";
    for (let i = start; i <= Math.min(start + value.cells.length, model.cycles); i++) delete row.edgeOffsets[i];
    for (const item of value.offsets || []) if (Number.isInteger(item.edge) && Number.isFinite(item.offset)) row.edgeOffsets[start + item.edge] = item.offset;
    pruneOffsets(row); selectedRange = { row: selected.row, start, end: Math.min(model.cycles - 1, start + value.cells.length - 1) }; selected.cell = selectedRange.end;
    refresh("波形已粘贴"); return true;
  }
  return false;
}
$("code").addEventListener("input", () => { codeDirty = true; setCodeMessage("代码尚未应用。切回“画布”或点击“应用并查看画布”。"); saveLocal(); renderTabs(); });
function applyCode() {
  try { const parsed = parseWaveJSON($("code").value); checkpoint(); model = parsed; selected = { row: -1, cell: -1 }; selectedAnnotation = -1; selectedRange = null; refresh("代码已应用"); return true; }
  catch (error) { setCodeMessage(`代码错误：${error.message}`, true); setStatus("代码未应用，请先修正代码"); return false; }
}
function updateView(view) {
  currentView = view === "code" ? "code" : "canvas";
  document.querySelector(".layout").dataset.view = currentView;
  $("canvasViewBtn").setAttribute("aria-pressed", String(currentView === "canvas"));
  $("codeViewBtn").setAttribute("aria-pressed", String(currentView === "code"));
}
function setView(view, applyDraft = false) {
  finishAnnotationEdit();
  if (view === "canvas" && applyDraft && codeDirty && !applyCode()) { $("code").focus(); return; }
  captureActiveTab();
  const tab = activeTab();
  const scrollLeft = tab?.scrollLeft || 0, scrollTop = tab?.scrollTop || 0;
  updateView(view); render();
  if (view === "canvas") {
    $("canvasScroll").scrollLeft = scrollLeft; $("canvasScroll").scrollTop = scrollTop;
    $("diagram").focus({ preventScroll: true });
  } else $("code").focus({ preventScroll: true });
  saveLocal();
}
$("canvasViewBtn").onclick = () => setView("canvas", true);
$("codeViewBtn").onclick = () => setView("code");
$("applyBtn").onclick = () => { if (applyCode()) setView("canvas"); };
$("newBtn").onclick = () => newTab();
$("addTabBtn").onclick = () => newTab();
$("canvasName").addEventListener("change", renameActiveTab);
$("canvasName").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); $("canvasName").blur(); }
  if (event.key === "Escape") { $("canvasName").value = model.title; $("canvasName").blur(); }
});
$("openBtn").onclick = () => $("fileInput").click();
let fileOpenQueue = Promise.resolve();
function queueWaveFiles(files) {
  const selectedFiles = Array.from(files);
  fileOpenQueue = fileOpenQueue.then(async () => {
    let opened = 0;
    const errors = [];
    for (const file of selectedFiles) {
      if (!/\.(json|wavejson)$/i.test(file.name)) {
        errors.push(`${file.name}：仅支持 .wavejson 或 .json 文件`);
        continue;
      }
      try {
        const parsed = parseWaveJSON(await file.text());
        newTab(parsed);
        opened++;
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    if (opened) setStatus(`已打开 ${opened} 个文件，每个文件对应一张新画布`);
    if (errors.length) {
      setCodeMessage(`打开失败：${errors.join("；")}`, true);
      if (!opened) setStatus("文件未打开，原画布已保留");
    }
  }).catch(error => {
    setCodeMessage(`打开失败：${error.message}`, true);
    setStatus("文件未打开，原画布已保留");
  });
  return fileOpenQueue;
}
$("fileInput").onchange = async event => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (files.length) await queueWaveFiles(files);
};
let fileDragDepth = 0;
const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes("Files");
function clearFileDrag() {
  fileDragDepth = 0;
  document.body.classList.remove("dragging-files");
}
document.addEventListener("dragenter", event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  fileDragDepth++;
  document.body.classList.add("dragging-files");
});
document.addEventListener("dragover", event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", event => {
  if (!isFileDrag(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) clearFileDrag();
});
document.addEventListener("drop", event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  clearFileDrag();
  const files = Array.from(event.dataTransfer.files || []);
  if (files.length) void queueWaveFiles(files);
  else setStatus("请拖入 .wavejson 或 .json 文件");
});
document.addEventListener("dragend", clearFileDrag);
window.addEventListener("blur", clearFileDrag);
function download(name, blob) {
  const link = document.createElement("a"), url = URL.createObjectURL(blob);
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function currentFilename(extension) {
  const base = model.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "timing-diagram";
  return `${base}.${extension}`;
}
$("saveBtn").onclick = () => download(currentFilename("json"), new Blob([JSON.stringify(toWaveJSON(), null, 2)], { type: "application/json" }));
function svgText() {
  const source = $("diagram").cloneNode(true);
  source.querySelectorAll("[data-export-ignore],rect[data-part],rect[data-edge]").forEach(el => el.remove());
  source.querySelectorAll("[data-part]").forEach(el => { el.removeAttribute("style"); el.removeAttribute("data-part"); });
  return new XMLSerializer().serializeToString(source);
}
$("svgBtn").onclick = () => download(currentFilename("svg"), new Blob([svgText()], { type: "image/svg+xml;charset=utf-8" }));
$("pngBtn").onclick = () => {
  const source = svgText(), blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" }), url = URL.createObjectURL(blob), img = new Image();
  img.onload = () => { const canvas = document.createElement("canvas"); canvas.width = img.width * 2; canvas.height = img.height * 2; const ctx = canvas.getContext("2d"); ctx.scale(2, 2); ctx.drawImage(img, 0, 0); canvas.toBlob(png => { if (png) download(currentFilename("png"), png); URL.revokeObjectURL(url); }); };
  img.onerror = () => { setStatus("PNG 导出失败"); URL.revokeObjectURL(url); };
  img.src = url;
};
document.addEventListener("keydown", event => {
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (modifier && !event.altKey && key === "t" && !event.shiftKey) { event.preventDefault(); newTab(); return; }
  if (modifier && !event.altKey && key === "w") { event.preventDefault(); closeTab(activeTabId); return; }
  if (modifier && !event.altKey && (key === "tab" || key === "pageup" || key === "pagedown")) {
    event.preventDefault();
    const direction = key === "pageup" || event.shiftKey ? -1 : 1;
    const index = tabs.findIndex(tab => tab.id === activeTabId);
    switchTab(tabs[(index + direction + tabs.length) % tabs.length].id);
    return;
  }
  if (modifier && event.shiftKey && key === "t") { event.preventDefault(); reopenClosedTab(); return; }
  if (event.target.closest?.("input,textarea,select,[contenteditable='true']")) return;
  const toolKeys = { "1": "1", "2": "0", x: "x", z: "z", c: "annotation", b: "=", f: "busBreak", s: "select" };
  const physicalKey = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : /^Digit[12]$/.test(event.code) ? event.code.slice(5) : key;
  const toolKey = Object.hasOwn(toolKeys, key) ? key : physicalKey;
  if (!modifier && !event.altKey && !event.shiftKey && Object.hasOwn(toolKeys, toolKey)) {
    event.preventDefault(); if (!event.repeat) selectTool(toolKeys[toolKey]); return;
  }
  if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (modifier && key === "y") { event.preventDefault(); redo(); return; }
  if (modifier && key === "a" && selected.row >= 0 && selected.cell >= 0 && model.rows[selected.row]?.kind !== "clock") {
    event.preventDefault(); selectedRange = { row: selected.row, start: 0, end: model.cycles - 1 }; selected.cell = model.cycles - 1; render(); return;
  }
  if (modifier && key === "c" && selectionPayload()) { event.preventDefault(); void copySelection(); return; }
  if (modifier && key === "x" && selectionPayload()) { event.preventDefault(); void copySelection(); deleteSelection(); return; }
  if (modifier && key === "v") { event.preventDefault(); void pasteSelection(); return; }
  if (!modifier && !event.altKey && (key === "delete" || key === "backspace") && selectionPayload()) { event.preventDefault(); deleteSelection(); }
});

try {
  const stored = JSON.parse(localStorage.getItem("timing-studio-tabs-v1") || "null");
  if (stored && Array.isArray(stored.tabs) && stored.tabs.length) {
    for (const saved of stored.tabs.slice(0, 40)) {
      try {
        const parsed = parseWaveJSON(saved.doc);
        const tab = makeTab(parsed, nextTabId++);
        tab.view = saved.view === "code" ? "code" : "canvas";
        if (saved.codeDirty && typeof saved.codeText === "string") { tab.codeDirty = true; tab.codeText = saved.codeText; }
        if (saved.id === stored.activeTabId) activeTabId = tab.id;
        tabs.push(tab);
      } catch {}
    }
    if (tabs.length && !tabs.some(tab => tab.id === activeTabId)) activeTabId = tabs[0].id;
  }
} catch {}
if (!tabs.length) {
  try { tabs.push(makeTab(parseWaveJSON(localStorage.getItem("timing-studio-v1") || SAMPLE))); }
  catch { tabs.push(makeTab(parseWaveJSON(SAMPLE))); }
  activeTabId = tabs[0].id;
}
restoreTab(activeTab());
setStatus("画布已载入");
saveLocal();
