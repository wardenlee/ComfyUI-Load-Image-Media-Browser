import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "comfyui.load-image-media-browser";
const SETTINGS = {
  thumbs: "Load Image Media Browser.Show Thumbnails",
  names: "Load Image Media Browser.Show File Names",
  size: "Load Image Media Browser.Thumbnail Size",
  columns: "Load Image Media Browser.Grid Columns",
  deleteEnabled: "Load Image Media Browser.Enable Delete",
  fit: "Load Image Media Browser.Preview Fit",
  previewHeight: "Load Image Media Browser.Preview Height",
  autoResizeNode: "Load Image Media Browser.Auto Resize Node To Media",
  autoRefreshFolder: "Load Image Media Browser.Auto Refresh Folder",
  autoplayVideos: "Load Image Media Browser.Autoplay Video Previews",
  sortMode: "Load Image Media Browser.Sort Mode",
};

let styleInjected = false;
let dialog = null;
let currentNode = null;
let currentData = null;
let currentFolder = ".";
let currentRoot = "input";
let currentSearch = "";
let currentShowImages = true;
let currentShowVideos = true;
let multiSelect = false;
const selectedSet = new Set();
// cut/paste (move) state: [{root, relpath}]
let cutBuffer = [];
const cutSet = new Set();
let refreshTimer = null;
const REFRESH_INTERVAL_MS = 5000;
// 可写根：ComfyUI input 与左侧「输入」(/tmp/code/input)；output 保持只读
const WRITE_ROOTS = ["input", "code_input"];
const STORAGE_KEY_LAST_FOLDER = "thumbnailsModern.lastFolder";
const STORAGE_KEY_LAST_ROOT = "thumbnailsModern.lastRoot";
const DEFAULT_ROOT_ID = "code_input"; // 默认显示「输入」(/tmp/code/input)
// 缩略图宽度档位：按卡片显示尺寸向上取档，避免为每张图生成多份缓存
const THUMB_WIDTHS = [256, 384, 512, 768, 1024];
// 网格分批渲染：首批 RENDER_BATCH 张，滚到接近底部再追加
const RENDER_BATCH = 60;
let gridState = { images: [], rendered: 0 };
let focusedIndex = -1; // 键盘/工具栏当前高亮的卡片（索引针对 filteredImages() 结果）
let rangeAnchor = -1; // Shift 连选锚点
let lazyObserver = null; // 卡片缩略图懒加载
let contextMenu = null; // 卡片右键菜单

function getSettingValue(id, fallback) {
  try {
    const value = app.ui?.settings?.getSettingValue?.(id);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function widgetForNode(node) {
  const preferred = mediaModeForNode(node) === "video" ? ["video", "file"] : ["image", "file"];
  for (const name of preferred) {
    const found = node?.widgets?.find((w) => w.name === name);
    if (found) return found;
  }
  return node?.widgets?.find((w) => ["image", "video", "file"].includes(w.name));
}

function mediaModeForNode(node) {
  return node?.comfyClass === "LoadVideo" ? "video" : "image";
}

function normalizeFolder(value) {
  return value && value !== "" ? value : ".";
}

// ComfyUI's mask editor / painter use "<file> [input]"; this browser also writes
// "<file> [<root>]" for output / 输入, and the backend resolves any browse root.
const ANNOTATION_SUFFIX_RE = /\s*\[([A-Za-z0-9_]+)\]\s*$/;

function stripAnnotation(value) {
  return String(value || "").replace(ANNOTATION_SUFFIX_RE, "");
}

function hasAnnotation(value) {
  return ANNOTATION_SUFFIX_RE.test(String(value || "").trim());
}

function annotationOf(value) {
  const match = String(value || "").match(ANNOTATION_SUFFIX_RE);
  return match ? match[1].toLowerCase() : null;
}

// Widget value for an item: files outside the input root carry the root
// annotation suffix ("<file> [output]", "<file> [code_input]").
function itemValue(item) {
  const rel = String(item?.relpath || "");
  const root = item?.root || "input";
  return root === "input" ? rel : `${rel} [${root}]`;
}

function splitRelpath(relpath) {
  const v = stripAnnotation(relpath).replace(/\\/g, "/");
  const m = v.match(/^(input|r\d+):/);
  if (m) return { root: m[1], rel: v.slice(m[0].length) };
  return { root: "input", rel: v };
}

function folderFromRelpath(relpath) {
  const { rel } = splitRelpath(relpath);
  const normalized = String(rel || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : ".";
}

function getRememberedFolder(node) {
  const nodeFolder = normalizeFolder(node?.properties?.tmCurrentFolder);
  if (nodeFolder) return nodeFolder;
  try {
    return normalizeFolder(localStorage.getItem(STORAGE_KEY_LAST_FOLDER) || ".");
  } catch {
    return ".";
  }
}

function hasExplicitRememberedFolder(node) {
  return typeof node?.properties?.tmCurrentFolder === "string" && node.properties.tmCurrentFolder.length >= 0;
}

function rememberFolder(node, folder) {
  const normalized = normalizeFolder(folder);
  if (node) {
    node.properties = node.properties || {};
    node.properties.tmCurrentFolder = normalized;
  }
  try {
    localStorage.setItem(STORAGE_KEY_LAST_FOLDER, normalized);
  } catch {}
}

// ---- 记住「最近一次浏览的根目录」（默认「输入」） ----
function getRememberedRoot(node) {
  const nodeRoot = node?.properties?.tmCurrentRoot;
  if (typeof nodeRoot === "string" && nodeRoot) return nodeRoot;
  try {
    return localStorage.getItem(STORAGE_KEY_LAST_ROOT) || "";
  } catch {
    return "";
  }
}

function rememberRoot(node, rootId) {
  if (!rootId) return;
  if (node) {
    node.properties = node.properties || {};
    node.properties.tmCurrentRoot = rootId;
  }
  try {
    localStorage.setItem(STORAGE_KEY_LAST_ROOT, rootId);
  } catch {}
}

function listImagesForFolder(data, folder, node = currentNode, rootId = currentRoot) {
  const normalized = normalizeFolder(folder);
  return (data?.images || []).filter((item) => item.folder === normalized && (!item.root || item.root === rootId) && canSelectItem(item, node));
}

function updateWidgetChoicesForFolder(node, folder, data = currentData, opts = {}) {
  const rootId = opts.root || currentRoot || "input";
  const widget = widgetForNode(node);
  if (!widget || !data) return;
  const items = listImagesForFolder(data, folder, node, rootId);
  const values = items.map((item) => itemValue(item));
  const currentValue = widget.value;
  const keepValue = typeof opts.keepValue === "string" && opts.keepValue ? opts.keepValue : "";
  widget.options = widget.options || {};
  if (!values.length) {
    if (keepValue) widget.options.values = [keepValue, ...(widget.options.values || [])];
    return;
  }
  // Keep annotated values ("<file> [input]", written by the mask editor and the
  // painter after saving an edit) and freshly uploaded values instead of
  // replacing them with the first file of the folder.
  const annotated = hasAnnotation(currentValue);
  const preserve = annotated || (keepValue && currentValue === keepValue);
  if (preserve) {
    widget.options.values = values.includes(currentValue) ? values : values.concat([currentValue]);
  } else {
    widget.options.values = values;
    if (currentValue && !values.includes(currentValue)) {
      widget.value = values[0];
    }
  }
}

// 原生上传/外部改值后：先把新值放进下拉选项（不覆盖），再强制刷新列表补齐
function keepWidgetChoice(node, value) {
  const widget = widgetForNode(node);
  if (!widget || !value) return;
  widget.options = widget.options || {};
  const values = Array.isArray(widget.options.values) ? widget.options.values.slice() : [];
  if (!values.includes(value)) widget.options.values = [value, ...values];
}

async function refreshChoicesAfterValueChange(node, value) {
  try {
    const valueRoot = annotationOf(value) || "input";
    const plain = stripAnnotation(value);
    updateWidgetChoicesForFolder(node, folderFromRelpath(value), currentData, { keepValue: value, root: valueRoot });
    keepWidgetChoice(node, value);
    // 新值还不在缓存里（刚上传/刚粘贴）才强制重扫，避免每次选择都重扫目录
    const known = (currentData?.images || []).some((item) => item.relpath === plain && (item.root || "input") === valueRoot);
    if (known) return;
    const data = await fetchListing(true);
    currentData = data;
    updateWidgetChoicesForFolder(node, folderFromRelpath(value), data, { keepValue: value, root: valueRoot });
    keepWidgetChoice(node, value);
  } catch (err) {
    console.warn("Media Browser: refresh after value change failed", err);
  }
}

function syncNodeFolderFromValue(node, data = currentData) {
  const widget = widgetForNode(node);
  const value = widget?.value;
  if (!value) return;
  const folder = folderFromRelpath(value);
  rememberFolder(node, folder);
  updateWidgetChoicesForFolder(node, folder, data);
}

function ensureStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .tm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:inherit}
    .tm-dialog{width:min(1180px,94vw);height:min(82vh,900px);background:var(--comfy-menu-bg, #1f1f1f);color:var(--input-text, #f2f2f2);border:1px solid var(--border-color, #444);border-radius:16px;display:flex;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.45);position:relative}
    .tm-dialog.tm-dragover{border-color:#4a9eff;box-shadow:0 0 0 2px rgba(74,158,255,.55),0 24px 80px rgba(0,0,0,.45)}
    .tm-sidebar{width:280px;border-right:1px solid var(--border-color, #444);display:flex;flex-direction:column;background:rgba(255,255,255,.02)}
    .tm-main{flex:1;display:flex;flex-direction:column;min-width:0}
    .tm-head{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border-color, #444);flex-wrap:wrap}
    .tm-btn{border:1px solid var(--border-color, #555);background:var(--comfy-input-bg, #2c2c2c);color:inherit;border-radius:10px;padding:8px 12px;cursor:pointer}
    .tm-btn:hover{filter:brightness(1.08)}
    .tm-search{width:100%;box-sizing:border-box;border:1px solid var(--border-color, #555);background:var(--comfy-input-bg, #2c2c2c);color:inherit;border-radius:10px;padding:8px 10px}
    .tm-sidebar-top{display:flex;flex-direction:column;gap:8px;padding:10px 8px;border-bottom:1px solid var(--border-color, #444)}
    .tm-folder-list{overflow:auto;padding:8px;flex:1;min-height:0}
    .tm-sidebar-footer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border-color, #444)}
    .tm-sidebar-footer .tm-btn{flex:1 1 30%;padding:5px 4px;font-size:11px;line-height:1.2;text-align:center;white-space:normal}
    .tm-btn:disabled{opacity:.45;cursor:not-allowed}
    .tm-btn:disabled:hover{filter:none}
    .tm-root-select{width:100%;box-sizing:border-box;margin:0;padding:8px 10px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tm-folder{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:10px;cursor:pointer}
    .tm-folder:hover,.tm-folder.active{background:rgba(255,255,255,.08)}
    .tm-grid{padding:14px;overflow:auto;display:grid;gap:12px;grid-template-columns:repeat(var(--tm-cols, 4), minmax(0,1fr))}
    .tm-card{display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px;cursor:pointer;min-width:0}
    .tm-card:hover{background:rgba(255,255,255,.06)}
    .tm-card.tm-selected{border-color:#4a9eff;background:rgba(74,158,255,.10);box-shadow:0 0 0 1px rgba(74,158,255,.45)}
    .tm-card.tm-current{outline:2px solid #f0b45a;outline-offset:1px}
    .tm-card.tm-cut{opacity:.45;outline:1px dashed #d9a441;outline-offset:1px}
    .tm-card.tm-focused{outline:2px dashed #4a9eff;outline-offset:2px}
    .tm-grid-status{padding:6px 14px;font-size:12px;opacity:.75;border-top:1px solid var(--border-color, #444);display:flex;gap:10px;align-items:center;min-height:20px}
    .tm-grid-status .tm-btn{padding:4px 8px;font-size:11px}
    .tm-menu{position:fixed;z-index:10020;min-width:200px;background:var(--comfy-menu-bg, #1f1f1f);border:1px solid var(--border-color, #555);border-radius:10px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px}
    .tm-menu-item{text-align:left;border:0;background:transparent;color:inherit;border-radius:8px;padding:8px 10px;font-size:13px;cursor:pointer}
    .tm-menu-item:hover{background:rgba(255,255,255,.10)}
    .tm-menu-item.tm-danger{color:#ff9d9d}
    .tm-menu-sep{height:1px;background:var(--border-color, #444);margin:4px 6px}
    .tm-selmark{position:absolute;top:8px;left:8px;width:24px;height:24px;border-radius:50%;background:#4a9eff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;z-index:2}
    .tm-multi.active{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28)}
    .tm-preview{position:relative;width:100%;height:var(--tm-preview-height, 160px);border-radius:10px;background:#111;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .tm-preview img,.tm-preview video{width:100%;height:100%;object-fit:var(--tm-fit, contain);border-radius:10px;background:#111}
    .tm-badge{position:absolute;top:8px;right:8px;font-size:11px;padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.14)}
    .tm-card.not-selectable{cursor:default;opacity:.95}
    .tm-meta{font-size:12px;opacity:.8;display:flex;justify-content:space-between;gap:8px}
    .tm-name{font-size:12px;line-height:1.35;word-break:break-word}
    .tm-empty{padding:20px;opacity:.75}
    .tm-actions{display:flex;gap:8px;justify-content:flex-start}
    .tm-danger{border-color:#8f3d3d}
    .tm-toggle.active{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28)}
    .tm-toggle.inactive{opacity:.65}
    .tm-spacer{flex:1}
    /* large preview: fills the whole dialog, nav arrows sit in the gutters next to the panel edges */
    .tm-zoom{position:absolute;inset:0;z-index:6;background:rgba(8,8,8,.96);display:none;align-items:center;justify-content:center;padding:16px 84px}
    .tm-zoom.open{display:flex}
    .tm-zoom-media{width:100%;height:100%;display:flex;align-items:center;justify-content:center;min-width:0}
    .tm-zoom-media img,.tm-zoom-media video{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;background:#000}
    .tm-zoom-nav{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:48px;padding:0;font-size:22px;line-height:1;border-radius:50%;z-index:2}
    .tm-zoom-nav.prev{left:16px}
    .tm-zoom-nav.next{right:16px}
    .tm-zoom-bar{position:absolute;top:12px;right:16px;display:flex;gap:10px;align-items:center;z-index:2}
    .tm-zoom-count{font-size:12px;opacity:.85}
    .tm-zoom-close{width:34px;height:34px;padding:0;border-radius:50%}
  `;
  document.head.appendChild(style);
}

function ensureDialog() {
  ensureStyles();
  if (dialog) return dialog;

  const overlay = document.createElement("div");
  overlay.className = "tm-overlay";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <div class="tm-dialog" role="dialog" aria-modal="true">
      <div class="tm-sidebar">
        <div class="tm-sidebar-top">
          <select class="tm-btn tm-root-select" title="Media root"></select>
          <input class="tm-search" type="search" placeholder="Search file or folder" />
        </div>
        <div class="tm-folder-list"></div>
        <div class="tm-sidebar-footer">
          <button class="tm-btn tm-upload-folder" title="Upload an entire folder (subfolders preserved)">Upload folder</button>
          <button class="tm-btn tm-copy-path" title="Copy the absolute path of the selected folder">Copy path</button>
          <button class="tm-btn tm-danger tm-folder-delete" title="Delete the selected folder and everything inside it">Delete folder</button>
        </div>
      </div>
      <div class="tm-main">
        <div class="tm-head">
          <button class="tm-btn tm-toggle tm-toggle-images active" type="button">Images</button>
          <button class="tm-btn tm-toggle tm-toggle-videos active" type="button">Videos</button>
          <select class="tm-btn tm-sort">
            <option value="date_desc">Date ↓</option>
            <option value="date_asc">Date ↑</option>
            <option value="name_asc">Name A–Z</option>
            <option value="name_desc">Name Z–A</option>
          </select>
          <button class="tm-btn tm-nav-prev" type="button" title="上一张放进节点（←）">‹</button>
          <button class="tm-btn tm-nav-next" type="button" title="下一张放进节点（→）">›</button>
          <button class="tm-btn tm-nav-random" type="button" title="随机一张放进节点（R）">🎲</button>
          <button class="tm-btn tm-multi" title="Toggle multi-select mode (pick several files, then press Delete)">Multi</button>
          <button class="tm-btn tm-upload" title="Upload multiple files to the input folder">Upload</button>
          <button class="tm-btn tm-cut" title="Cut the selected file(s), then open a target folder and press Paste">Cut</button>
          <button class="tm-btn tm-paste" disabled title="Move the cut file(s) into the current folder">Paste</button>
          <button class="tm-btn tm-danger tm-delete" disabled title="Delete the selected files">Delete</button>
          <button class="tm-btn tm-refresh">Refresh</button>
          <button class="tm-btn tm-close">Close</button>
        </div>
        <div class="tm-grid"></div>
        <div class="tm-grid-status"></div>
      </div>
      <div class="tm-zoom">
        <div class="tm-zoom-media"></div>
        <button class="tm-btn tm-zoom-nav prev" type="button" title="Previous">‹</button>
        <button class="tm-btn tm-zoom-nav next" type="button" title="Next">›</button>
        <div class="tm-zoom-bar"><span class="tm-zoom-count"></span><button class="tm-btn tm-zoom-close" type="button" title="Close">✕</button></div>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  overlay.querySelector(".tm-close").addEventListener("click", closeDialog);
  overlay.querySelector(".tm-refresh").addEventListener("click", () => openDialog(currentNode, true));
  overlay.querySelector(".tm-upload").addEventListener("click", triggerUpload);
  overlay.querySelector(".tm-upload-folder").addEventListener("click", uploadFolder);
  overlay.querySelector(".tm-multi").addEventListener("click", toggleMultiSelect);
  overlay.querySelector(".tm-cut").addEventListener("click", cutFiles);
  overlay.querySelector(".tm-paste").addEventListener("click", pasteCutFiles);
  overlay.querySelector(".tm-delete").addEventListener("click", deleteSelected);
  overlay.querySelector(".tm-folder-delete").addEventListener("click", deleteCurrentFolder);
  overlay.querySelector(".tm-copy-path").addEventListener("click", copyCurrentFolderPath);
  overlay.querySelector(".tm-zoom-nav.prev").addEventListener("click", () => stepZoom(-1));
  overlay.querySelector(".tm-zoom-nav.next").addEventListener("click", () => stepZoom(1));
  overlay.querySelector(".tm-zoom-close").addEventListener("click", closeZoom);
  overlay.querySelector(".tm-nav-prev").addEventListener("click", () => stepFocused(-1, true));
  overlay.querySelector(".tm-nav-next").addEventListener("click", () => stepFocused(1, true));
  overlay.querySelector(".tm-nav-random").addEventListener("click", () => jumpRandom());
  // 面板外点击/右键：关掉右键菜单
  overlay.addEventListener("mousedown", (event) => {
    if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu();
  });
  for (const sel of [".tm-upload", ".tm-upload-folder"]) {
    const btn = overlay.querySelector(sel);
    if (btn) btn.dataset.tip = btn.title;
  }
  enableDragDrop(overlay);
  overlay.querySelector(".tm-root-select").addEventListener("change", (event) => {
    currentRoot = event.target.value || "input";
    currentFolder = ".";
    rememberRoot(currentNode, currentRoot);
    rememberFolder(currentNode, currentFolder);
    updateRootActions();
    renderFolders();
    renderGrid();
  });
  overlay.querySelector(".tm-search").addEventListener("input", (event) => {
    currentSearch = event.target.value?.toLowerCase?.() || "";
    renderGrid();
  });
  overlay.querySelector(".tm-sort").addEventListener("change", (event) => {
    try {
      app.ui?.settings?.setSettingValue?.(SETTINGS.sortMode, event.target.value);
    } catch {}
    renderGrid();
  });
  overlay.querySelector(".tm-toggle-images").addEventListener("click", () => {
    currentShowImages = !currentShowImages;
    renderGrid();
  });
  overlay.querySelector(".tm-toggle-videos").addEventListener("click", () => {
    currentShowVideos = !currentShowVideos;
    renderGrid();
  });
  document.body.appendChild(overlay);
  dialog = overlay;
  updateCutButtons();
  return dialog;
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function onDialogKeydown(event) {
  if (isZoomOpen()) {
    if (event.key === "Escape") { closeZoom(); return; }
    if (event.key === "ArrowLeft") { event.preventDefault?.(); stepZoom(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault?.(); stepZoom(1); return; }
    return;
  }
  if (event.key === "Escape") {
    if (contextMenu) { closeContextMenu(); return; }
    closeDialog();
    return;
  }
  const target = event.target;
  const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  if (typing) return;

  const columns = Math.max(1, Number(getSettingValue(SETTINGS.columns, 4)) || 4);
  if (event.ctrlKey && (event.key === "a" || event.key === "A")) { event.preventDefault?.(); selectAllVisible(); return; }
  if (event.key === "Enter") {
    event.preventDefault?.();
    const item = focusedItem();
    if (item && canSelectItem(item)) {
      setNodeMedia(currentNode, item);
      closeDialog();
    }
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault?.(); deleteSelected(); return; }
  if (event.key === "ArrowLeft") { event.preventDefault?.(); stepFocused(-1); return; }
  if (event.key === "ArrowRight") { event.preventDefault?.(); stepFocused(1); return; }
  if (event.key === "ArrowUp") { event.preventDefault?.(); stepFocused(-columns); return; }
  if (event.key === "ArrowDown") { event.preventDefault?.(); stepFocused(columns); return; }
  if (event.key === " " || event.key === "Spacebar") {
    event.preventDefault?.();
    const item = focusedItem();
    if (item) openZoom(item);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return; // 别抢 Ctrl+C / Ctrl+V / Ctrl+R 这类浏览器组合键
  if (event.key === "r" || event.key === "R") { jumpRandom(); return; }
  if (event.key === "c" || event.key === "C") { cutFiles(); return; }
  if (event.key === "v" || event.key === "V") { pasteCutFiles(); return; }
  if (event.key === "/") { event.preventDefault?.(); dialog?.querySelector(".tm-search")?.focus(); return; }
}

function closeDialog() {
  stopAutoRefresh();
  closeZoom();
  closeContextMenu();
  document.removeEventListener("keydown", onDialogKeydown);
  if (dialog) dialog.style.display = "none";
}

async function fetchListing(refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  const response = await api.fetchApi(`/thumbnails-modern/list${query}`);
  if (response.status === 304) {
    // 中间层可能替我们发了 If-None-Match：304 表示列表没变，直接用现有数据
    return currentData || { images: [], folders: [], roots: [] };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ---- 上传：统一走插件自己的 /thumbnails-modern/upload（确定性目录 + 重名跳过） ----
const UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.bmp,.mp4,.webm,.mov,.m4v,.mkv,.avi";

// 落点规则（修「同一文件夹的图散到两个不同文件夹」）：
// - 带相对路径的条目（上传文件夹 / 拖入文件夹）→ 直接用 rel 的目录部分：
//   顶层目录 = 源文件夹名，固定落在当前根下，**不再叠加当前浏览的文件夹**
// - 单个文件（多选上传 / 拖入文件）→ 仍落在当前浏览的文件夹，保持原有手感
function uploadSubfolderFor(rel) {
  const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  if (relDir) return relDir;
  return currentFolder === "." ? "" : normalizeFolder(currentFolder);
}

function uploadTopFolder(subfolder) {
  const rel = String(subfolder || "").replace(/^\/+|\/+$/g, "");
  return rel ? rel.split("/")[0] : ".";
}

async function uploadOneFile(file, subfolder, idx, total, progressBtn) {
  const rootId = currentRoot || "input";
  const formData = new FormData();
  formData.append("image", file);
  if (progressBtn) progressBtn.textContent = total > 1 ? `Uploading ${idx + 1}/${total}` : "Uploading…";
  try {
    const qs = new URLSearchParams({ root: rootId, subfolder: subfolder || "" });
    const response = await api.fetchApi(`/thumbnails-modern/upload?${qs.toString()}`, { method: "POST", body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
    if (data && data.skipped) return { skipped: true, name: file.name };
    if (!data || !data.ok) throw new Error((data && data.error) || "upload failed");
    return { ok: true, name: file.name };
  } catch (err) {
    console.warn("Thumbnails Modern: upload failed:", file.name, err);
    return { ok: false, name: file.name, error: err.message || err };
  }
}

// ---- 按「相对路径」批量写入当前根（文件、文件夹、拖拽共用） ----
async function uploadFileEntries(picked, buttonSelector = ".tm-upload") {
  const total = picked.length;
  if (!total) return { ok: 0, skipped: 0, failed: 0, tops: [] };
  const btn = dialog?.querySelector(buttonSelector);
  const originalText = btn ? btn.textContent : "Upload";
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const tops = new Set();
  for (let i = 0; i < total; i++) {
    const { rel, file } = picked[i];
    const carriesRelativeDir = rel.includes("/"); // 文件夹上传 / 拖入文件夹才有相对路径
    const subfolder = uploadSubfolderFor(rel);
    const result = await uploadOneFile(file, subfolder, i, total, btn);
    if (result.ok) okCount++;
    else if (result.skipped) skipCount++;
    else failCount++;
    if ((result.ok || result.skipped) && carriesRelativeDir) tops.add(uploadTopFolder(subfolder));
  }
  if (btn) btn.textContent = originalText;
  const rootId = currentRoot || "input";
  const topsList = [...tops].filter((top) => top && top !== ".").sort();
  const landing = topsList.length
    ? topsList.map((top) => `${rootId}/${top}/`).join(" , ")
    : `${rootId}${currentFolder === "." ? "/" : `/${normalizeFolder(currentFolder)}/`}`;
  alert(`Upload finished: ${okCount} ok, ${skipCount} skipped (already exists), ${failCount} failed\n写入目录：${landing}`);
  // 文件夹上传后把面板切到刚写入的顶层目录：否则用户看不到新图，
  // 再传一次就会叠成 <目录>/<目录>/（此前"散到两个文件夹"最可能的成因）
  if (topsList.length === 1 && normalizeFolder(currentFolder) !== topsList[0]) {
    currentFolder = topsList[0];
    rememberFolder(currentNode, currentFolder);
  }
  if (okCount > 0 || skipCount > 0) await refreshListingInPlace(true);
  return { ok: okCount, skipped: skipCount, failed: failCount, tops: topsList };
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  await uploadFileEntries(files.map((file) => ({ rel: file.name, file })), ".tm-upload");
}

// ---- Folder upload: File System Access API (preserves subfolder tree), fallback webkitdirectory ----
async function pickFolderFiles() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker();
      if (!dir) return [];
      const out = [];
      async function walk(handle, prefix) {
        for await (const [name, child] of handle.entries()) {
          if (child.kind === "file") {
            const ext = "." + name.slice(name.lastIndexOf(".") + 1).toLowerCase();
            if (UPLOAD_ACCEPT.includes(ext)) {
              const file = await child.getFile();
              out.push({ rel: prefix ? `${prefix}/${name}` : name, file });
            }
          } else if (child.kind === "directory") {
            await walk(child, prefix ? `${prefix}/${name}` : name);
          }
        }
      }
      await walk(dir, dir.name); // keep the picked folder's own name so the tree is preserved
      return out;
    } catch (err) {
      if (err && err.name === "AbortError") return [];
      console.warn("Thumbnails Modern: folder pick failed:", err);
      return [];
    }
  }
  // Fallback: webkitdirectory input (Firefox / older browsers)
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      const out = files.map((f) => ({ rel: f.webkitRelativePath || f.name, file: f }));
      input.value = "";
      resolve(out);
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function uploadFolder() {
  const picked = await pickFolderFiles();
  if (!picked || !picked.length) {
    alert("No supported media files found in the selected folder.");
    return;
  }
  await uploadFileEntries(picked, ".tm-upload-folder");
}

// ---- Drag & drop files / folders onto the dialog ----
function entryAsFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const out = [];
    const next = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    };
    next();
  });
}

async function walkDroppedEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    try {
      const file = await entryAsFile(entry);
      out.push({ rel: prefix ? `${prefix}/${entry.name}` : entry.name, file });
    } catch (err) {
      console.warn("Media Browser: dropped file unreadable:", entry.name, err);
    }
    return;
  }
  if (entry.isDirectory) {
    try {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of children) await walkDroppedEntry(child, nextPrefix, out);
    } catch (err) {
      console.warn("Media Browser: dropped folder unreadable:", entry.name, err);
    }
  }
}

function enableDragDrop(overlayEl) {
  let dragDepth = 0;
  const setDragActive = (on) => {
    const dialogEl = overlayEl.querySelector(".tm-dialog");
    if (dialogEl) dialogEl.classList.toggle("tm-dragover", on);
  };
  const onDragOver = (event) => {
    if (!overlayEl.querySelector(".tm-dialog")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDragEnter = (event) => {
    if (!overlayEl.querySelector(".tm-dialog")) return;
    event.preventDefault();
    dragDepth += 1;
    setDragActive(true);
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragActive(false);
  };
  const onDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    setDragActive(false);
    if (!WRITE_ROOTS.includes(currentRoot || "input")) {
      alert("当前根目录是只读的（output），请先切到 input 或 输入 再拖入。");
      return;
    }
    const dt = event.dataTransfer;
    if (!dt) return;
    const allowed = UPLOAD_ACCEPT.split(",");
    const entries = [];
    for (const item of Array.from(dt.items || [])) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    let picked = [];
    if (entries.length) {
      for (const entry of entries) await walkDroppedEntry(entry, "", picked);
    } else {
      picked = Array.from(dt.files || []).map((file) => ({ rel: file.name, file }));
    }
    picked = picked.filter(({ rel }) => {
      const dot = rel.lastIndexOf(".");
      if (dot < 0) return false;
      return allowed.includes(rel.slice(dot).toLowerCase());
    });
    if (!picked.length) {
      alert("No supported media files dropped.");
      return;
    }
    await uploadFileEntries(picked, ".tm-upload");
  };
  overlayEl.addEventListener("dragover", onDragOver);
  overlayEl.addEventListener("dragenter", onDragEnter);
  overlayEl.addEventListener("dragleave", onDragLeave);
  overlayEl.addEventListener("drop", onDrop);
}

// ---- Multi-select delete ----
function toggleMultiSelect(force) {
  multiSelect = typeof force === "boolean" ? force : !multiSelect;
  if (!multiSelect) selectedSet.clear();
  rangeAnchor = -1;
  const multiBtn = dialog?.querySelector(".tm-multi");
  if (multiBtn) multiBtn.classList.toggle("active", multiSelect);
  updateDeleteButton();
  renderGrid();
}

function updateDeleteButton() {
  const btn = dialog?.querySelector(".tm-delete");
  if (!btn) return;
  const count = multiSelect && WRITE_ROOTS.includes((currentRoot || "input")) ? selectedSet.size : 0;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `Delete (${count})` : "Delete";
}

function updateFolderDeleteButton() {
  const btn = dialog?.querySelector(".tm-folder-delete");
  if (!btn) return;
  const isRoot = normalizeFolder(currentFolder) === ".";
  btn.disabled = isRoot;
  const rootId = currentRoot || "input";
  btn.title = isRoot
    ? "Select a folder first (the media root itself cannot be deleted)"
    : `Delete the selected folder and everything inside it (${rootId})`;
}

function updateRootActions() {
  const isWritable = WRITE_ROOTS.includes((currentRoot || "input"));
  for (const sel of [".tm-upload", ".tm-upload-folder"]) {
    const btn = dialog?.querySelector(sel);
    if (!btn) continue;
    btn.disabled = !isWritable;
    btn.title = isWritable ? (btn.dataset.tip || "Upload") : "Only available in the input / 输入 roots";
  }
  updateFolderDeleteButton();
  updateDeleteButton();
  updateCutButtons();
}

// ---- Cut / paste (move files between folders / roots) ----
function cutCandidates() {
  const rootId = currentRoot || "input";
  if (selectedSet.size) return [...selectedSet].map((relpath) => ({ root: rootId, relpath }));
  const value = widgetForNode(currentNode)?.value || "";
  const plain = stripAnnotation(value);
  const valueRoot = annotationOf(value) || "input";
  if (plain && valueRoot === rootId) return [{ root: rootId, relpath: plain }];
  return [];
}

function updateCutButtons() {
  const cut = dialog?.querySelector(".tm-cut");
  const paste = dialog?.querySelector(".tm-paste");
  if (cut) cut.textContent = cutBuffer.length ? `Cut (${cutBuffer.length})` : "Cut";
  if (paste) {
    paste.disabled = cutBuffer.length === 0;
    paste.textContent = cutBuffer.length ? `Paste (${cutBuffer.length})` : "Paste";
  }
}

function cutFiles() {
  const targets = cutCandidates();
  if (!targets.length) {
    alert("先勾选要剪切的图片（Multi 模式），或先在节点里选中一张属于当前目录的图片。");
    return;
  }
  cutBuffer = targets;
  cutSet.clear();
  for (const target of targets) cutSet.add(`${target.root}:${target.relpath}`);
  updateCutButtons();
  renderGrid();
}

async function pasteCutFiles() {
  if (!cutBuffer.length) return;
  const toRoot = currentRoot || "input";
  const toFolder = normalizeFolder(currentFolder);
  const label = `${toRoot}${toFolder === "." ? "" : "/" + toFolder}`;
  if (!confirm(`Move ${cutBuffer.length} file(s) into "${label}"?`)) return;

  const groups = new Map();
  for (const item of cutBuffer) {
    if (!groups.has(item.root)) groups.set(item.root, []);
    groups.get(item.root).push(item.relpath);
  }
  let moved = 0;
  const failed = [];
  try {
    for (const [fromRoot, relpaths] of groups) {
      const response = await api.fetchApi("/thumbnails-modern/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_root: fromRoot, relpaths, to_root: toRoot, to_folder: toFolder }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      moved += (payload.moved || []).length;
      failed.push(...(payload.failed || []));
    }
    cutBuffer = [];
    cutSet.clear();
    updateCutButtons();
    await refreshListingInPlace(true);
    if (failed.length) alert(`Moved ${moved} file(s), ${failed.length} failed:\n${failed.join("\n")}`);
  } catch (err) {
    alert(`Paste failed: ${err.message || err}`);
  }
}

async function deleteMany(relpaths, root = "input") {
  const ok = [];
  const failed = [];
  for (const relpath of relpaths) {
    try {
      await deleteImage(relpath, root);
      ok.push(relpath);
    } catch (err) {
      failed.push(`${relpath} (${err.message || err})`);
    }
  }
  return { ok, failed };
}

async function deleteSelected() {
  if (!selectedSet.size) return;
  const rootId = currentRoot || "input";
  const targets = Array.from(selectedSet);
  if (!confirm(`Delete ${targets.length} selected file(s)?\n${targets.join("\n")}`)) return;
  const { ok, failed } = await deleteMany(targets, rootId);
  for (const rel of ok) selectedSet.delete(rel);
  updateDeleteButton();
  await refreshListingInPlace(true);
  const msg = `Deleted ${ok.length} file(s)` + (failed.length ? `, ${failed.length} failed:\n${failed.join("\n")}` : "");
  alert(msg);
}

// ---- Delete the whole selected folder (sidebar bottom button) ----
async function deleteCurrentFolder() {
  const folder = normalizeFolder(currentFolder);
  if (folder === ".") return;
  const rootId = (currentRoot || "input").toLowerCase();
  const count = (currentData?.images || []).filter((item) => item.folder === folder || String(item.folder || "").startsWith(folder + "/")).length;
  const label = rootId === "input" ? folder : `${rootId}/${folder}`;
  if (!confirm(`Delete folder "${label}"${count ? ` and all ${count} file(s) inside` : ""}?\nThis cannot be undone.`)) return;

  const btn = dialog?.querySelector(".tm-folder-delete");
  if (btn) btn.disabled = true;
  try {
    const response = await api.fetchApi("/thumbnails-modern/delete_folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpath: folder, root: rootId }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ".";
    multiSelect = false;
    selectedSet.clear();
    const multiBtn = dialog?.querySelector(".tm-multi");
    if (multiBtn) multiBtn.classList.remove("active");

    currentFolder = parent;
    rememberFolder(currentNode, currentFolder);
    await refreshListingInPlace(true);
    const parentExists = (currentData?.folders || []).some((item) => item.path === currentFolder);
    if (!parentExists) currentFolder = ".";
    rememberFolder(currentNode, currentFolder);
    updateWidgetChoicesForFolder(currentNode, currentFolder, currentData);
    renderFolders();
    renderGrid();
    updateDeleteButton();
    const extra = payload.files != null ? ` (${payload.files} file(s))` : "";
    alert(`Deleted folder "${label}"${extra}`);
  } catch (err) {
    alert(`Delete folder failed: ${err.message || err}`);
  } finally {
    updateFolderDeleteButton();
  }
}

// ---- Refresh in place (keeps search/folder/selection) ----
async function refreshListingInPlace(force = false) {
  try {
    const data = await fetchListing(force);
    currentData = data;
    renderFolders();
    renderGrid();
  } catch (err) {
    console.warn("Thumbnails Modern: refresh failed", err);
  }
}

function triggerUpload() {
  if (dialog.__tmUploadInput) {
    dialog.__tmUploadInput.remove();
    dialog.__tmUploadInput = null;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = UPLOAD_ACCEPT;
  input.style.display = "none";
  input.addEventListener("change", () => {
    uploadFiles(input.files);
    input.value = "";
  });
  document.body.appendChild(input);
  dialog.__tmUploadInput = input;
  input.click();
}

function canSelectItem(item, node = currentNode) {
  // 三个根（input / output / 输入）的图都能直接选进节点：
  // 非 input 根会写成 "<file> [<root>]"，由后端 _resolve_input_file 解析
  const mode = mediaModeForNode(node);
  if (mode === "video") return item?.media_type === "video";
  return item?.media_type === "image" && item?.selectable !== false;
}


function inferMediaTypeFromPath(relpath) {
  const value = String(relpath || "").toLowerCase();
  if (/\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(value)) return "video";
  return "image";
}

function resizeNodeForAspect(node, width, height) {
  const mediaWidth = Math.max(1, Number(width || 1));
  const mediaHeight = Math.max(1, Number(height || 1));
  const aspect = Math.max(0.05, mediaWidth / mediaHeight);

  const currentWidth = Math.max(320, Math.round(node?.size?.[0] || 320));
  const chromeWidth = 56;
  const chromeHeight = 170;

  const is169 = Math.abs(aspect - 16 / 9) < 0.12;
  const is916 = Math.abs(aspect - 9 / 16) < 0.08;
  const is11 = Math.abs(aspect - 1) < 0.08;
  const is43 = Math.abs(aspect - 4 / 3) < 0.08;
  const is34 = Math.abs(aspect - 3 / 4) < 0.08;

  let targetPreviewWidth;
  let targetPreviewHeight;

  if (is169) {
    targetPreviewWidth = 820;
    targetPreviewHeight = Math.round(targetPreviewWidth * 9 / 16);
  } else if (is916) {
    targetPreviewHeight = 640;
    targetPreviewWidth = Math.round(targetPreviewHeight * 9 / 16);
  } else if (is11) {
    targetPreviewWidth = 620;
    targetPreviewHeight = 620;
  } else if (is43) {
    targetPreviewWidth = 760;
    targetPreviewHeight = Math.round(targetPreviewWidth * 3 / 4);
  } else if (is34) {
    targetPreviewHeight = 620;
    targetPreviewWidth = Math.round(targetPreviewHeight * 3 / 4);
  } else if (aspect >= 1) {
    targetPreviewWidth = Math.max(620, Math.min(980, Math.round(mediaWidth * 0.42)));
    targetPreviewHeight = Math.round(targetPreviewWidth / aspect);
  } else {
    targetPreviewHeight = Math.max(360, Math.min(760, Math.round(mediaHeight * 0.42)));
    targetPreviewWidth = Math.round(targetPreviewHeight * aspect);
  }

  targetPreviewWidth = Math.max(280, Math.min(980, targetPreviewWidth));
  targetPreviewHeight = Math.max(180, Math.min(760, targetPreviewHeight));

  let targetWidth = Math.max(currentWidth, targetPreviewWidth + chromeWidth);
  let targetHeight = targetPreviewHeight + chromeHeight;

  if (aspect >= 1 && targetWidth < 760) {
    targetWidth = 760;
    targetPreviewWidth = targetWidth - chromeWidth;
    targetPreviewHeight = Math.max(180, Math.min(760, Math.round(targetPreviewWidth / aspect)));
    targetHeight = targetPreviewHeight + chromeHeight;
  }

  if (aspect < 1 && targetWidth < 420) {
    targetWidth = 420;
  }

  node.setSize?.([Math.round(targetWidth), Math.round(targetHeight)]);
  node.setDirtyCanvas?.(true, true);
}

async function fitNodePreviewToMedia(node, relpath, explicitType = null) {
  if (!node || !relpath) return;
  const autoResizeNode = getSettingValue(SETTINGS.autoResizeNode, false);
  if (!autoResizeNode) {
    node.setDirtyCanvas?.(true, true);
    return;
  }
  const mediaType = explicitType || inferMediaTypeFromPath(relpath);
  const url = mediaUrl(relpath);
  try {
    if (mediaType === "video") {
      await new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        video.onloadedmetadata = () => {
          resizeNodeForAspect(node, video.videoWidth || 16, video.videoHeight || 9);
          resolve();
        };
        video.onerror = () => reject(new Error("video metadata could not be loaded"));
        video.src = url;
      });
      return;
    }
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resizeNodeForAspect(node, img.naturalWidth || 1, img.naturalHeight || 1);
        resolve();
      };
      img.onerror = () => reject(new Error("image size could not be loaded"));
      img.src = url;
    });
  } catch (err) {
    console.warn("Media Browser: preview aspect resize failed", err);
  }
}

async function setNodeMedia(node, item, keepOpen = false) {
  const widget = widgetForNode(node);
  if (!widget) return;
  const isItem = item && typeof item === "object";
  const relpath = isItem ? item.relpath : String(item || "");
  const value = isItem ? itemValue(item) : String(item || "");
  const folder = isItem ? (item.folder || ".") : folderFromRelpath(relpath);
  rememberFolder(node, folder);
  updateWidgetChoicesForFolder(node, folder, currentData);
  widget.value = value;
  if (Array.isArray(widget.options?.values) && !widget.options.values.includes(value)) {
    widget.options.values.unshift(value);
  }
  await fitNodePreviewToMedia(node, value);
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  if (!keepOpen) closeDialog();
}

async function deleteImage(relpath, root = "input") {
  const response = await api.fetchApi("/thumbnails-modern/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relpath, root }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  currentData.images = currentData.images.filter((item) => !(item.relpath === relpath && (item.root || "input") === root));
  renderFolders();
  renderGrid();
}

function filteredImages() {
  if (!currentData) return [];
  const sortMode = getSettingValue(SETTINGS.sortMode, "date_desc");
  const items = currentData.images.filter((item) => {
    const inRoot = !item.root || item.root === currentRoot;
    if (!inRoot) return false;
    const inFolder = item.folder === currentFolder;
    if (!inFolder) return false;
    if (item.media_type === "image" && !currentShowImages) return false;
    if (item.media_type === "video" && !currentShowVideos) return false;
    if (!currentSearch) return true;
    const hay = `${item.name} ${item.relpath} ${item.folder}`.toLowerCase();
    return hay.includes(currentSearch);
  });

  items.sort((a, b) => {
    if (sortMode === "name_asc") return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
    if (sortMode === "name_desc") return String(b.name).localeCompare(String(a.name), undefined, { numeric: true, sensitivity: "base" });
    const am = Number(a.mtime_ns || 0);
    const bm = Number(b.mtime_ns || 0);
    if (sortMode === "date_asc") return am - bm || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
    return bm - am || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
  });

  return items;
}

function mediaUrl(relpath, rootHint) {
  const { root, rel } = splitRelpath(relpath);
  const effectiveRoot = rootHint || annotationOf(relpath) || root;
  if (effectiveRoot !== "input") {
    const params = new URLSearchParams({ root: effectiveRoot, relpath: rel });
    return api.apiURL(`/thumbnails-modern/media?${params.toString()}`);
  }
  const normalized = String(rel || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const filename = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  const subfolder = idx >= 0 ? normalized.slice(0, idx) : "";
  const params = new URLSearchParams({ filename, type: "input" });
  if (subfolder) params.set("subfolder", subfolder);
  return api.apiURL(`/view?${params.toString()}`);
}

// ---- 缩略图（后端生成 + 磁盘缓存；失败自动回落原图） ----
function thumbWidthFor(thumbSize) {
  const wanted = Math.max(64, Number(thumbSize || 120) * 2);
  for (const width of THUMB_WIDTHS) if (wanted <= width) return width;
  return THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
}

function thumbUrl(relpath, rootHint, width) {
  const { root, rel } = splitRelpath(relpath);
  const effectiveRoot = rootHint || annotationOf(relpath) || root;
  const params = new URLSearchParams({ root: effectiveRoot, relpath: rel, w: String(width || 256) });
  return api.apiURL(`/thumbnails-modern/thumb?${params.toString()}`);
}

function ensureLazyObserver() {
  if (lazyObserver) return lazyObserver;
  if (typeof IntersectionObserver !== "function") return null;
  const grid = dialog?.querySelector(".tm-grid") || null;
  lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      lazyObserver.unobserve(entry.target);
      const img = entry.target;
      if (!img.dataset || !img.dataset.src) continue;
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  }, { root: grid, rootMargin: "400px 0px" });
  return lazyObserver;
}

// 卡片预览图：可视区才真正请求缩略图；缩略图 404/解码失败时回落原图
function observeCardMedia(card) {
  const img = card.querySelector("img[data-src]");
  if (!img) return;
  img.addEventListener("error", () => {
    if (img.dataset.fallback) return;
    img.dataset.fallback = "1";
    if (img.dataset.full) img.src = img.dataset.full;
  });
  const load = () => {
    if (!img.dataset.src) return;
    img.src = img.dataset.src;
    delete img.dataset.src;
  };
  const observer = ensureLazyObserver();
  if (!observer) { load(); return; }
  observer.observe(img);
}

// 分批渲染：滚到接近底部时再追加，避免一次建几千个 DOM 节点
let gridAppendMore = null;

function ensureGridScrollHook(grid) {
  if (grid.__tmScrollHook) return;
  grid.__tmScrollHook = true;
  grid.addEventListener("scroll", () => {
    closeContextMenu(); // 菜单是 position:fixed，滚动后位置会失真
    if (!gridAppendMore) return;
    if (gridState.rendered >= gridState.images.length) return;
    if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) gridAppendMore();
  });
}

function updateGridStatus() {
  const status = dialog?.querySelector(".tm-grid-status");
  if (!status) return;
  status.innerHTML = "";
  delete status.dataset.hint; // 每次重建状态栏都允许重新提示「当前图还有多远」
  const total = gridState.images.length;
  if (!total) return;
  const label = document.createElement("span");
  label.textContent = gridState.rendered < total
    ? `已加载 ${gridState.rendered} / ${total} 张（滚动自动加载更多；缩略图按需生成并缓存）`
    : `${total} 张`;
  status.appendChild(label);
  if (gridState.rendered < total && typeof gridAppendMore === "function") {
    const more = document.createElement("button");
    more.className = "tm-btn";
    more.textContent = "载入更多";
    more.addEventListener("click", () => gridAppendMore && gridAppendMore());
    status.appendChild(more);
  }
}

function renderFolders() {
  const list = dialog.querySelector(".tm-folder-list");
  list.innerHTML = "";
  const folders = currentData?.folders || [];
  for (const folder of folders) {
    if (folder.root && folder.root !== currentRoot) continue;
    const el = document.createElement("div");
    el.className = `tm-folder ${folder.path === currentFolder ? "active" : ""}`;
    el.innerHTML = `<span>${folder.label}</span><span>${folder.count}</span>`;
    el.addEventListener("click", () => {
      currentFolder = folder.path;
      rememberFolder(currentNode, currentFolder);
      updateWidgetChoicesForFolder(currentNode, currentFolder, currentData);
      renderFolders();
      renderGrid();
    });
    list.appendChild(el);
  }
  updateFolderDeleteButton();
}

function renderGrid() {
  const grid = dialog.querySelector(".tm-grid");
  const showThumbs = getSettingValue(SETTINGS.thumbs, true);
  const showNames = getSettingValue(SETTINGS.names, true);
  const thumbSize = getSettingValue(SETTINGS.size, 120);
  const columns = getSettingValue(SETTINGS.columns, 4);
  const canDelete = getSettingValue(SETTINGS.deleteEnabled, true);
  const fitMode = getSettingValue(SETTINGS.fit, "contain");
  const previewHeight = getSettingValue(SETTINGS.previewHeight, 160);
  const autoplayVideos = getSettingValue(SETTINGS.autoplayVideos, true);
  const currentNodeValue = widgetForNode(currentNode)?.value || "";
  const currentNodeRel = stripAnnotation(currentNodeValue);
  const currentNodeRoot = annotationOf(currentNodeValue) || "input";
  const imagesToggle = dialog.querySelector(".tm-toggle-images");
  const videosToggle = dialog.querySelector(".tm-toggle-videos");
  if (imagesToggle) imagesToggle.className = `tm-btn tm-toggle tm-toggle-images ${currentShowImages ? "active" : "inactive"}`;
  if (videosToggle) videosToggle.className = `tm-btn tm-toggle tm-toggle-videos ${currentShowVideos ? "active" : "inactive"}`;
  const sortSelect = dialog.querySelector(".tm-sort");
  if (sortSelect) sortSelect.value = getSettingValue(SETTINGS.sortMode, "date_desc");
  grid.style.setProperty("--tm-thumb-size", `${thumbSize}px`);
  grid.style.setProperty("--tm-cols", String(columns));
  grid.style.setProperty("--tm-fit", fitMode === "cover" ? "cover" : "contain");
  grid.style.setProperty("--tm-preview-height", `${previewHeight + 45}px`); // 卡片信息从 4 行减到 2 行, 省出的 45px 让给预览图
  if (lazyObserver) lazyObserver.disconnect();
  grid.innerHTML = "";
  closeContextMenu();
  gridState = { images: [], rendered: 0 };
  gridAppendMore = null;
  focusedIndex = -1;
  rangeAnchor = -1;

  const images = filteredImages();
  if (!images.length) {
    grid.innerHTML = `<div class="tm-empty">No matching media found in this folder.</div>`;
    updateGridStatus();
    return;
  }
  gridState = { images, rendered: 0 };

  const buildCard = (item, index) => {
    const card = document.createElement("div");
    card.dataset.index = String(index);
    const isSelected = selectedSet.has(item.relpath);
    card.className = "tm-card" + (isSelected ? " tm-selected" : "");
    if (currentNodeRel && item.relpath === currentNodeRel && (item.root || "input") === currentNodeRoot) {
      card.classList.add("tm-current");
    }
    if (cutSet.has(`${item.root || "input"}:${item.relpath}`)) card.classList.add("tm-cut");
    const escapedName = item.name.replace(/[<>&"]/g, (m) => ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;"}[m]));
    let mediaHtml = "";
    if (showThumbs) {
      if (item.media_type === "video") {
        const autoplay = autoplayVideos ? "autoplay muted loop playsinline" : "controls muted playsinline";
        mediaHtml = `<div class="tm-preview"><video loading="lazy" src="${mediaUrl(item.relpath, item.root)}" ${autoplay}></video><div class="tm-badge">VIDEO</div></div>`;
      } else {
        mediaHtml = `<div class="tm-preview"><img loading="lazy" decoding="async" data-src="${thumbUrl(item.relpath, item.root, thumbWidthFor(thumbSize))}" data-full="${mediaUrl(item.relpath, item.root)}" alt="${escapedName}" /><span class="tm-selmark"${isSelected ? "" : " style=\"display:none\""}>✓</span></div>`;
      }
    } else {
      mediaHtml = `<div class="tm-preview"><span class="tm-selmark"${isSelected ? "" : " style=\"display:none\""}>✓</span></div>`;
    }
    const nameHtml = showNames ? `<div class="tm-name">${escapedName}</div>` : "";
    const usableInNode = canSelectItem(item);
    // 只有两行信息：文件名 + 「文件夹 · 大小」（日期、图片/视频类型、Selectable 均已取消）
    card.innerHTML = `${mediaHtml}${nameHtml}<div class="tm-meta"><span>${item.folder}</span><span>${Math.round(item.size / 1024)} KB</span></div>`;
    if (!usableInNode) card.classList.add("not-selectable");

    // 点击：多选模式切换勾选；Shift+点击 = 连选两点之间全部；普通模式 = 写入节点
    card.addEventListener("click", (event) => handleCardClick(item, index, event));
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        handleCardClick(item, index, { shiftKey: true, stopPropagation: () => {} });
        return;
      }
      openContextMenu(event, item);
    });

    if (!multiSelect) {
      const actions = document.createElement("div");
      actions.className = "tm-actions";
      const view = document.createElement("button");
      view.className = "tm-btn tm-view";
      view.textContent = "View";
      view.title = "Open the large preview";
      view.addEventListener("click", (event) => {
        event.stopPropagation();
        openZoom(item);
      });
      actions.appendChild(view);
      if (canDelete && WRITE_ROOTS.includes(item.root || "input")) {
        const del = document.createElement("button");
        del.className = "tm-btn tm-danger";
        del.textContent = "Delete";
        del.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (!confirm(`Delete file?\n${item.relpath}`)) return;
          try {
            await deleteImage(item.relpath, item.root || "input");
          } catch (err) {
            alert(`Delete failed: ${err.message || err}`);
          }
        });
        actions.appendChild(del);
      }
      card.appendChild(actions);
    }

    observeCardMedia(card);
    return card;
  };

  const appendBatch = () => {
    if (gridState.rendered >= images.length) return;
    const end = Math.min(images.length, gridState.rendered + RENDER_BATCH);
    const frag = document.createDocumentFragment();
    for (let i = gridState.rendered; i < end; i++) frag.appendChild(buildCard(images[i], i));
    grid.appendChild(frag);
    gridState.rendered = end;
    updateGridStatus();
  };
  gridAppendMore = appendBatch;
  appendBatch();
  ensureGridScrollHook(grid);
}

// ---- 卡片交互（点击 / Shift 连选 / 键盘高亮 / 工具栏翻页 / 右键菜单） ----
function gridCardAt(index) {
  return dialog?.querySelector(`.tm-grid .tm-card[data-index="${index}"]`) || null;
}

function focusedItem() {
  return gridState.images[focusedIndex] || null;
}

function setFocused(index, scroll = false) {
  focusedIndex = index;
  const grid = dialog?.querySelector(".tm-grid");
  if (!grid) return;
  for (const card of grid.querySelectorAll(".tm-card")) {
    card.classList.toggle("tm-focused", Number(card.dataset.index) === index);
  }
  if (!scroll) return;
  while (index >= gridState.rendered && gridState.rendered < gridState.images.length) {
    if (typeof gridAppendMore === "function") gridAppendMore();
    else break;
  }
  const card = gridCardAt(index);
  if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
}

function handleCardClick(item, index, event) {
  event?.stopPropagation?.();
  setFocused(index, false);
  const images = gridState.images;
  // Shift+点击：#1 进入多选并选中该卡（设为锚点），#2 起选中锚点与当前卡之间全部
  if (event?.shiftKey && images.length) {
    const anchor = rangeAnchor >= 0 && rangeAnchor < images.length ? rangeAnchor : index;
    if (!multiSelect) toggleMultiSelect(true); // 注意：它会把 rangeAnchor 清成 -1，所以先取本地副本
    const from = Math.min(anchor, index);
    const to = Math.max(anchor, index);
    for (let i = from; i <= to; i++) selectedSet.add(images[i].relpath);
    renderGrid();
    // 必须在 renderGrid 之后设锚点：renderGrid 会把 rangeAnchor 复位成 -1
    rangeAnchor = index;
    setFocused(index, false);
    updateDeleteButton();
    return;
  }
  if (multiSelect) {
    if (selectedSet.has(item.relpath)) selectedSet.delete(item.relpath);
    else selectedSet.add(item.relpath);
    rangeAnchor = index;
    const card = gridCardAt(index);
    if (card) {
      const mark = card.querySelector(".tm-selmark");
      if (mark) mark.style.display = selectedSet.has(item.relpath) ? "" : "none";
      card.classList.toggle("tm-selected", selectedSet.has(item.relpath));
    }
  } else if (canSelectItem(item)) {
    rangeAnchor = index;
    setNodeMedia(currentNode, item);
  }
  updateDeleteButton();
}

function selectAllVisible() {
  const images = gridState.images;
  if (!images.length) return;
  const keepFocus = focusedIndex;
  if (!multiSelect) toggleMultiSelect(true);
  for (const item of images) selectedSet.add(item.relpath);
  renderGrid();
  if (keepFocus >= 0) setFocused(keepFocus, false);
  updateDeleteButton();
}

function refreshCurrentCardMark() {
  const grid = dialog?.querySelector(".tm-grid");
  if (!grid) return;
  const value = widgetForNode(currentNode)?.value || "";
  const rel = stripAnnotation(value);
  const root = annotationOf(value) || "input";
  for (const card of grid.querySelectorAll(".tm-card")) {
    const item = gridState.images[Number(card.dataset.index)];
    card.classList.toggle("tm-current", !!item && item.relpath === rel && (item.root || "input") === root);
  }
}

// 打开面板时把「节点当前图」带进视野：必要时追加批次，但最多追加 20 批（1200 张），
// 免得为了滚到第 9000 张又把整棵树渲染回来；没追到时在状态栏里说明。
function revealCurrentCard() {
  const value = widgetForNode(currentNode)?.value || "";
  const rel = stripAnnotation(value);
  if (!rel) return;
  const root = annotationOf(value) || "input";
  const index = gridState.images.findIndex((item) => item.relpath === rel && (item.root || "input") === root);
  if (index < 0) return;
  let guard = 0;
  while (index >= gridState.rendered && gridState.rendered < gridState.images.length && guard < 5) {
    if (typeof gridAppendMore !== "function") break;
    gridAppendMore();
    guard += 1;
  }
  const card = gridCardAt(index);
  if (card && typeof card.scrollIntoView === "function") {
    card.scrollIntoView({ block: "nearest" });
  } else {
    const status = dialog?.querySelector(".tm-grid-status");
    if (status && !status.dataset.hint) {
      status.dataset.hint = "1";
      const hint = document.createElement("span");
      hint.textContent = `（当前图在列表第 ${index + 1} 张，继续向下滚动或点「载入更多」）`;
      status.appendChild(hint);
    }
  }
}

function stepFocused(delta, applyToNode = false) {
  const images = gridState.images;
  if (!images.length) return;
  const base = focusedIndex < 0 ? (delta > 0 ? -1 : images.length) : focusedIndex;
  const next = ((base + delta) % images.length + images.length) % images.length;
  setFocused(next, true);
  const item = images[next];
  if (applyToNode && item && canSelectItem(item)) {
    // 工具栏「上一张/下一张」：写入节点但**不关面板**，方便连续翻
    setNodeMedia(currentNode, item, true).then(() => {
      refreshCurrentCardMark();
      setFocused(next, false);
    }).catch(() => {});
  }
}

function jumpRandom() {
  const images = gridState.images.filter((item) => canSelectItem(item));
  if (!images.length) return;
  const pick = images[Math.floor(Math.random() * images.length)];
  const index = gridState.images.indexOf(pick);
  if (index >= 0) setFocused(index, true);
  setNodeMedia(currentNode, pick, true).then(() => {
    refreshCurrentCardMark();
    if (index >= 0) setFocused(index, false);
  }).catch(() => {});
}

// ---- 卡片右键菜单 ----
function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
}

async function copyItemAbsolutePath(item) {
  const params = new URLSearchParams({ root: item.root || "input", folder: item.folder === "." ? "" : item.folder });
  const response = await api.fetchApi(`/thumbnails-modern/folder_path?${params.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const sep = String(data.path).includes("\\") ? "\\" : "/";
  const full = String(data.path).endsWith(sep) ? `${data.path}${item.name}` : `${data.path}${sep}${item.name}`;
  if (!(await copyTextToClipboard(full))) window.prompt("Copy the absolute path:", full);
}

function openContextMenu(event, item) {
  closeContextMenu();
  const rootId = item.root || "input";
  const menu = document.createElement("div");
  menu.className = "tm-menu";
  const addItem = (label, handler, opts = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tm-menu-item" + (opts.danger ? " tm-danger" : "");
    btn.textContent = label;
    btn.addEventListener("click", async (clickEvent) => {
      clickEvent.stopPropagation();
      closeContextMenu();
      try {
        await handler();
      } catch (err) {
        alert(`${label} failed: ${err.message || err}`);
      }
    });
    menu.appendChild(btn);
  };
  const addSeparator = () => {
    const line = document.createElement("div");
    line.className = "tm-menu-sep";
    menu.appendChild(line);
  };

  if (canSelectItem(item)) addItem("设为节点图片（Enter）", () => setNodeMedia(currentNode, item));
  addItem("预览（Space）", () => openZoom(item));
  addSeparator();
  addItem("复制文件名", async () => { if (!(await copyTextToClipboard(item.name))) window.prompt("Copy file name:", item.name); });
  addItem("复制相对路径", async () => { if (!(await copyTextToClipboard(item.relpath))) window.prompt("Copy relative path:", item.relpath); });
  addItem("复制绝对路径", () => copyItemAbsolutePath(item));
  addSeparator();
  addItem("剪切（C）", () => {
    cutBuffer = [{ root: rootId, relpath: item.relpath }];
    cutSet.clear();
    cutSet.add(`${rootId}:${item.relpath}`);
    updateCutButtons();
    renderGrid();
  });
  if (getSettingValue(SETTINGS.deleteEnabled, true) && WRITE_ROOTS.includes(rootId)) {
    addItem("删除", async () => {
      if (!confirm(`Delete file?\n${item.relpath}`)) return;
      await deleteImage(item.relpath, rootId);
      await refreshListingInPlace(true);
    }, { danger: true });
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  contextMenu = menu;
}

// ---- Copy the absolute path of the selected folder (sidebar footer button) ----
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand && document.execCommand("copy");
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

function flashButtonLabel(btn, text, fallback) {
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = btn.dataset.label || fallback;
  }, 1400);
}

async function copyCurrentFolderPath() {
  const btn = dialog?.querySelector(".tm-copy-path");
  const rootId = (currentRoot || "input").toLowerCase();
  const folder = normalizeFolder(currentFolder);
  try {
    const params = new URLSearchParams({ root: rootId, folder: folder === "." ? "" : folder });
    const response = await api.fetchApi(`/thumbnails-modern/folder_path?${params.toString()}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (await copyTextToClipboard(data.path)) {
      flashButtonLabel(btn, "Copied", "Copy path");
    } else {
      window.prompt("Copy the folder path:", data.path);
    }
  } catch (err) {
    alert(`Copy path failed: ${err.message || err}`);
  }
}

// ---- Large preview (panel-sized, arrows in the gutters) ----
let zoomItems = [];
let zoomIndex = 0;

function renderZoom() {
  const media = dialog?.querySelector(".tm-zoom-media");
  if (!media) return;
  const item = zoomItems[zoomIndex];
  media.innerHTML = "";
  if (!item) return;
  const url = mediaUrl(item.relpath, item.root);
  if (item.media_type === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    media.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.name || "";
    media.appendChild(img);
  }
  const count = dialog?.querySelector(".tm-zoom-count");
  if (count) count.textContent = `${zoomIndex + 1} / ${zoomItems.length}`;
  const solo = zoomItems.length < 2;
  for (const sel of [".tm-zoom-nav.prev", ".tm-zoom-nav.next"]) {
    const nav = dialog?.querySelector(sel);
    if (nav) nav.style.display = solo ? "none" : "";
  }
}

function openZoom(item) {
  zoomItems = filteredImages();
  const wantedRoot = item?.root || "input";
  const found = zoomItems.findIndex((entry) => entry.relpath === item?.relpath && (entry.root || "input") === wantedRoot);
  if (found < 0 || !zoomItems.length) return;
  zoomIndex = found;
  dialog?.querySelector(".tm-zoom")?.classList.add("open");
  renderZoom();
}

function closeZoom() {
  dialog?.querySelector(".tm-zoom")?.classList.remove("open");
  const media = dialog?.querySelector(".tm-zoom-media");
  if (media) media.innerHTML = "";
}

function stepZoom(delta) {
  if (!zoomItems.length) return;
  zoomIndex = ((zoomIndex + delta) % zoomItems.length + zoomItems.length) % zoomItems.length;
  renderZoom();
}

function isZoomOpen() {
  return !!dialog?.querySelector(".tm-zoom.open");
}

async function openDialog(node, refresh = false) {
  // Check global setting: Auto Refresh Folder
  if (refresh === false) {
    refresh = getSettingValue(SETTINGS.autoRefreshFolder, false);
  }
  ensureDialog();
  currentNode = node;
  currentData = await fetchListing(refresh);

  // 最近上传/编辑的文件可能还没进缓存：节点当前值若不在列表里，强制重扫一次
  const nodeValue = widgetForNode(node)?.value || "";
  const nodePlain = stripAnnotation(nodeValue);
  const nodeRoot = annotationOf(nodeValue) || splitRelpath(nodeValue).root || "input";
  if (nodePlain && !(currentData?.images || []).some((item) => item.relpath === nodePlain && (item.root || "input") === nodeRoot)) {
    try {
      currentData = await fetchListing(true);
    } catch (err) {
      console.warn("Media Browser: forced refresh failed", err);
    }
  }

  const rootSelect = dialog.querySelector(".tm-root-select");
  const roots = currentData?.roots || [{ id: "input", label: "input" }];
  rootSelect.innerHTML = "";
  for (const r of roots) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.label;
    rootSelect.appendChild(opt);
  }
  const widgetValue = widgetForNode(node)?.value || "";
  const widgetValueRoot = annotationOf(widgetValue) || splitRelpath(widgetValue).root;
  // 首次默认「输入」；之后每次进入面板都回到上一次浏览的根目录
  const rememberedRoot = getRememberedRoot(node);
  const preferredRoot = rememberedRoot || DEFAULT_ROOT_ID;
  currentRoot = roots.some((r) => r.id === preferredRoot)
    ? preferredRoot
    : (roots.some((r) => r.id === widgetValueRoot) ? widgetValueRoot : roots[0].id);
  rootSelect.value = currentRoot;
  rememberRoot(node, currentRoot);

  // Important: keep the last browsed folder when reopening the browser.
  // Only fall back to the image value's folder when the node has not remembered one yet.
  if (!hasExplicitRememberedFolder(node)) {
    syncNodeFolderFromValue(node, currentData);
  }

  currentFolder = getRememberedFolder(node);
  const folderInCurrentRoot = (folder) => !folder.root || folder.root === currentRoot;
  const hasFolder = (currentData?.folders || []).some((folder) => folder.path === currentFolder && folderInCurrentRoot(folder));
  if (!hasFolder) {
    currentFolder = folderFromRelpath(widgetForNode(node)?.value || ".") || ".";
  }
  const fallbackExists = (currentData?.folders || []).some((folder) => folder.path === currentFolder && folderInCurrentRoot(folder));
  if (!fallbackExists) currentFolder = ".";
  rememberFolder(node, currentFolder);
  updateWidgetChoicesForFolder(node, currentFolder, currentData);
  currentSearch = "";
  currentShowImages = true;
  currentShowVideos = true;
  multiSelect = false;
  selectedSet.clear();
  const multiBtn = dialog.querySelector(".tm-multi");
  if (multiBtn) multiBtn.classList.remove("active");
  updateDeleteButton();
  updateFolderDeleteButton();
  dialog.querySelector(".tm-search").value = "";
  closeZoom();
  renderFolders();
  renderGrid();
  updateRootActions();
  dialog.style.display = "flex";
  revealCurrentCard();
  // Auto refresh while dialog is open (keeps new uploads visible without manual Refresh)
  stopAutoRefresh();
  if (getSettingValue(SETTINGS.autoRefreshFolder, false)) {
    refreshTimer = setInterval(async () => {
      try {
        await refreshListingInPlace(true);
      } catch (err) {
        console.warn("Thumbnails Modern: auto-refresh failed", err);
      }
    }, REFRESH_INTERVAL_MS);
  }
  document.addEventListener("keydown", onDialogKeydown);
}

function addBrowserButton(node) {
  if (node.__tmBrowserButton) return;
  node.__tmBrowserButton = true;
  if (!hasExplicitRememberedFolder(node)) {
    syncNodeFolderFromValue(node);
  }
  const imageWidget = widgetForNode(node);
  if (imageWidget && !imageWidget.__tmWrappedCallback) {
    const originalCallback = imageWidget.callback;
    imageWidget.callback = function (value, ...args) {
      const folder = folderFromRelpath(value);
      rememberFolder(node, folder);
      // 原生「选择文件上传」/其他扩展改值：先把新值保住并补进下拉，再强制刷新列表，
      // 避免用旧缓存把它覆盖成文件夹里的第一张（否则上传完看不到最新文件）。
      keepWidgetChoice(node, value);
      refreshChoicesAfterValueChange(node, value);
      fitNodePreviewToMedia(node, value, mediaModeForNode(node));
      return typeof originalCallback === "function" ? originalCallback.call(this, value, ...args) : undefined;
    };
    imageWidget.__tmWrappedCallback = true;
  }
  const widget = node.addWidget?.("button", "Browse Media", null, async () => {
    try {
      await openDialog(node, false);
    } catch (err) {
      alert(`Media browser could not be opened: ${err.message || err}`);
    }
  });
  if (widget) widget.serialize = false;
}


async function refreshNodeFolderChoices(node, force = false) {
  try {
    let data = await fetchListing(force);
    const widgetValue = widgetForNode(node)?.value || "";
    const widgetRoot = annotationOf(widgetValue) || splitRelpath(widgetValue).root || "input";
    // 当前值（刚上传/刚选中的文件）若不在缓存列表里，先强制重扫，避免被下拉重建时改掉
    const plain = stripAnnotation(widgetValue);
    const known = (data?.images || []).some((item) => item.relpath === plain && (item.root || "input") === widgetRoot);
    if (plain && !known) {
      try {
        data = await fetchListing(true);
      } catch (err) {
        console.warn("Thumbnails Modern: forced refresh failed", err);
      }
    }
    const folder = getRememberedFolder(node);
    const exists = (data?.folders || []).some((item) => item.path === folder && (!item.root || item.root === widgetRoot));
    const targetFolder = exists ? folder : folderFromRelpath(widgetValue || ".") || ".";
    rememberFolder(node, targetFolder);
    updateWidgetChoicesForFolder(node, targetFolder, data, { keepValue: widgetValue, root: widgetRoot });
    const currentValue = widgetForNode(node)?.value;
    if (currentValue) fitNodePreviewToMedia(node, currentValue, mediaModeForNode(node));
  } catch (err) {
    console.warn("Thumbnails Modern: could not refresh folder choices", err);
  }
}

app.registerExtension({
  name: EXT_NAME,
  settings: [
    { id: SETTINGS.thumbs, name: "Show thumbnails", type: "boolean", defaultValue: true },
    { id: SETTINGS.names, name: "Show file names", type: "boolean", defaultValue: true },
    { id: SETTINGS.size, name: "Thumbnail size", type: "slider", defaultValue: 120, attrs: { min: 72, max: 320, step: 8 } },
    { id: SETTINGS.previewHeight, name: "Preview height", type: "slider", defaultValue: 160, attrs: { min: 96, max: 360, step: 8 } },
    { id: SETTINGS.columns, name: "Grid columns", type: "slider", defaultValue: 4, attrs: { min: 2, max: 8, step: 1 } },
    { id: SETTINGS.fit, name: "Preview fit", type: "combo", options: ["contain", "cover"], defaultValue: "contain" },
    { id: SETTINGS.autoResizeNode, name: "Auto resize node to media", type: "boolean", defaultValue: false },
    { id: SETTINGS.autoRefreshFolder, name: "Auto refresh folder", type: "boolean", defaultValue: true },
    { id: SETTINGS.autoplayVideos, name: "Autoplay video previews", type: "boolean", defaultValue: true },
    { id: SETTINGS.deleteEnabled, name: "Enable delete button", type: "boolean", defaultValue: true },
    { id: SETTINGS.sortMode, name: "Sort mode", type: "combo", options: ["date_desc", "date_asc", "name_asc", "name_desc"], defaultValue: "date_desc" },
  ],
  async nodeCreated(node) {
    if (!["LoadImage", "LoadVideo"].includes(node.comfyClass)) return;
    addBrowserButton(node);
    refreshNodeFolderChoices(node, false);
  },
  async loadedGraphNode(node) {
    if (!["LoadImage", "LoadVideo"].includes(node.comfyClass)) return;
    addBrowserButton(node);
    refreshNodeFolderChoices(node, false);
  },
});
