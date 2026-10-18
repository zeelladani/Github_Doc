/* ─── PWA SERVICE WORKER REGISTRATION ─── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.log('Service Worker registration failed: ', err);
    });
  });
}

/* ─── CONFIG ────────────────────────────────────────────────────────── */
const CFG    = window.GH_CONFIG || {};
const TOKEN  = (CFG.TOKEN  || "").trim();
const OWNER  = (CFG.OWNER  || "").trim();
const REPO   = (CFG.REPO   || "").trim();
const BRANCH = (CFG.BRANCH || "main").trim();
const BASE   = (CFG.BASE_PATH || "docs").replace(/^\/+|\/+$/g, "");
const EXPIRES = CFG.EXPIRES || ""; 
const EXT_MAP = CFG.EXTENSIONS || {};
const FALLBACK = CFG.FALLBACK_FOLDER || "other";

const API = "https://api.github.com";
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

const KIND = {
  jpg:"image", jpeg:"image", png:"image", gif:"image", webp:"image", svg:"image", bmp:"image", ico:"image",
  mp3:"audio", wav:"audio", m4a:"audio", ogg:"audio", flac:"audio",
  mp4:"video", mov:"video", webm:"video", mkv:"video",
  pdf:"pdf",
  txt:"text", md:"text", csv:"text", json:"text", log:"text", xml:"text",
};

let state = { files: [], activeType: "all" };
let favourites = JSON.parse(localStorage.getItem("doc_favourites") || "[]");
let lastLoadTime = Date.now();
let selectedFiles = [];

/* ─── CONFIG CHECK & EXPIRY ─────────────────────────────────────────── */
(function initApp() {
  const problems = [];
  
  if (!TOKEN) {
    problems.push("TOKEN is undefined in config.js");
  } else if (TOKEN === "PASTE_YOUR_NEW_TOKEN_HERE") {
    problems.push("TOKEN still has placeholder text");
  } else if (!TOKEN.startsWith("github_pat_") && !TOKEN.startsWith("ghp_")) {
    problems.push("TOKEN format is invalid");
  }

  if (!OWNER) problems.push("OWNER empty");
  if (!REPO)  problems.push("REPO empty");

  const repoLine = document.getElementById("repoLine");
  if (problems.length) {
    repoLine.textContent = "Config problem: " + problems.join(" • ");
    repoLine.style.color = "var(--danger)";
  } else {
    repoLine.textContent = `${OWNER}/${REPO} • ${BRANCH}`;
    repoLine.style.color = "var(--muted)";
  }

  if (EXPIRES) {
    const expiryDate = new Date(EXPIRES);
    const today = new Date();
    today.setHours(0,0,0,0);

    const diffTime = expiryDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const badge = document.createElement("div");
    badge.className = "expiry-badge";
    badge.title = `Token expires: ${expiryDate.toLocaleDateString()}`;
    
    let text = "";
    if (diffDays < 0) {
      badge.classList.add("expired");
      text = "Expired";
    } else if (diffDays === 0) {
      badge.classList.add("warning");
      text = "Today";
    } else if (diffDays <= 30) {
      badge.classList.add("warning");
      text = `${diffDays} days left`;
    } else {
      text = `${diffDays} days left`;
    }

    badge.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
      ${text}
    `;
    document.getElementById("expiryContainer").appendChild(badge);
  }
})();

function extOf(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}
function folderFor(fileName) {
  const ext = extOf(fileName);
  return EXT_MAP[ext] || ext || FALLBACK;
}
function destPath(fileName) {
  const folder = folderFor(fileName);
  return BASE ? `${BASE}/${folder}/${fileName}` : `${folder}/${fileName}`;
}

/* ─── UPLOAD UI LOGIC ───────────────────────────────────────────────── */
function openUploadModal() {
  document.getElementById("uploadModal").classList.add("show");
}
function closeUploadModal(e) {
  if (e && e.target.id !== "uploadModal" && e.target.tagName !== "BUTTON") return;
  document.getElementById("uploadModal").classList.remove("show");
  
  document.getElementById("file").value = "";
  selectedFiles = [];
  renderSelectedFiles();
  document.getElementById("progress").classList.remove("show");
}

function handleFileSelect(event) {
  const files = Array.from(event.target.files);
  selectedFiles = [...selectedFiles, ...files];
  event.target.value = ""; 
  renderSelectedFiles();
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const el = document.getElementById("dest");
  const label = document.getElementById("fileLabel");
  
  if (selectedFiles.length === 0) { 
    el.style.display = "none"; 
    el.innerHTML = ""; 
    label.textContent = "Click to browse files";
    return; 
  }
  
  label.textContent = `${selectedFiles.length} file(s) selected`;
  el.style.display = "block";
  
  el.innerHTML = selectedFiles.map((f, i) => {
    const p = destPath(f.name);
    const warn = f.size > 20 * 1024 * 1024 ? ' <span style="color:#ef4444;">(>20 MB)</span>' : '';
    return `
      <div class="file-item">
        <div class="file-item-info">
          <div class="file-item-name">${escapeHtml(f.name)} ${warn}</div>
          <div class="file-item-path">→ ${escapeHtml(p)}</div>
        </div>
        <button type="button" class="file-item-remove" onclick="removeFile(${i})" title="Remove file">×</button>
      </div>
    `;
  }).join("");
}

/* ─── UPLOAD ACTION ─────────────────────────────────────────────────── */
async function upload() {
  if (selectedFiles.length === 0) return toast("Pick at least one file", true);

  const btn   = document.getElementById("uploadBtn");
  const mode  = document.getElementById("overwrite").value;
  const prog  = document.getElementById("progress");
  const bar   = document.getElementById("progressBar");

  btn.disabled = true;
  btn.textContent = "Uploading...";
  prog.classList.add("show");
  bar.style.width = "0%";

  let done = 0, errors = [];
  const filesToUpload = [...selectedFiles]; 

  for (const file of filesToUpload) {
    try {
      await uploadOne(file, mode);
      done++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
      console.error("Upload error:", err);
    }
    bar.style.width = Math.round((done / filesToUpload.length) * 100) + "%";
  }

  prog.classList.remove("show");
  bar.style.width = "0%";
  btn.disabled = false;
  btn.textContent = "Start Upload";
  
  if (errors.length) toast(`Uploaded ${done}/${filesToUpload.length}. Errors`, true);
  else               toast(`Uploaded ${done} file(s) ✓`, false);

  closeUploadModal();
  lastLoadTime = Date.now();
  await load();
}

async function uploadOne(file, mode) {
  const path = destPath(file.name);
  const b64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  const headers = {
    "Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  let sha;
  if (mode === "overwrite") {
    const head = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}?ref=${BRANCH}`, { headers });
    if (head.ok) {
      const info = await head.json();
      sha = info.sha;
    }
  }

  const body = {
    message: `Upload ${file.name}`,
    content: b64,
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`, {
    method: "PUT", headers, body: JSON.stringify(body),
  });
  
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status})`);
  }
  return res.json();
}

/* ─── LOAD TREE ─────────────────────────────────────────────────────── */
async function load() {
  if (!TOKEN || !OWNER || !REPO) return;

  try {
    const res = await fetch(
      `${API}/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1&t=${Date.now()}`,
      {
        headers: {
          "Authorization": `Bearer ${TOKEN}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) throw new Error(`Tree API failed (${res.status})`);
    
    const data = await res.json();
    const prefix = BASE ? `${BASE}/` : "";
    
    const rawFiles = (data.tree || []).filter(n => {
      const isFile = n.type === "blob";
      const matchesPath = n.path.startsWith(prefix);
      const notManifest = !n.path.endsWith("manifest.json");
      return isFile && matchesPath && notManifest;
    });

    state.files = rawFiles.map(n => {
      const name = n.path.split("/").pop();
      const ext  = extOf(name);
      return {
        name,
        path: n.path,
        size: n.size || 0,
        ext,
        kind: KIND[ext] || "other",
        url: `${RAW}/${encodeURI(n.path)}?t=${lastLoadTime}`,
        date: n.date ? new Date(n.date) : new Date(),
      };
    });

    buildTypeNav();
    render();
    
  } catch (err) {
    toast("Load failed: " + err.message, true);
  }
}

/* ─── TYPE NAV ──────────────────────────────────────────────────────── */
function buildTypeNav() {
  const counts = { all: state.files.length, favourites: 0, image: 0, audio: 0, video: 0, pdf: 0, text: 0, other: 0 };
  
  for (const f of state.files) {
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    if (favourites.includes(f.path)) counts.favourites++;
  }

  const labels = { all:"All", favourites:"Favourites", image:"Images", audio:"Audio", video:"Video", pdf:"PDFs", text:"Text", other:"Other" };
  const order  = ["all", "favourites", "image", "audio", "video", "pdf", "text", "other"];
  const nav    = document.getElementById("typeNav");
  nav.innerHTML = "";

  for (const k of order) {
    if (k !== "all" && k !== "favourites" && !counts[k]) continue;
    
    const b = document.createElement("button");
    b.innerHTML = k === "favourites" 
      ? `<svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg> ${labels[k]} (${counts[k]})`
      : `${labels[k]} (${counts[k]})`;
      
    b.className = state.activeType === k ? "active" : "";
    b.onclick = () => { state.activeType = k; buildTypeNav(); render(); };
    nav.appendChild(b);
  }
}

/* ─── RENDER LIST ───────────────────────────────────────────────────── */
let visibleFiles = []; 

function render() {
  const q    = document.getElementById("q").value.trim().toLowerCase();
  const sort = document.getElementById("sort").value;

  let files = state.files.slice();
  
  if (state.activeType === "favourites") {
    files = files.filter(f => favourites.includes(f.path));
  } else if (state.activeType !== "all") {
    files = files.filter(f => f.kind === state.activeType);
  }
  
  if (q) files = files.filter(f => f.name.toLowerCase().includes(q));

  files.sort((a,b) => {
    if (sort === "name")      return a.name.localeCompare(b.name);
    if (sort === "name-desc") return b.name.localeCompare(a.name);
    if (sort === "size")      return a.size - b.size;
    if (sort === "size-desc") return b.size - a.size;
    if (sort === "date-asc")  return a.date - b.date;
    return b.date - a.date;
  });

  const root = document.getElementById("groups");
  root.innerHTML = "";
  
  visibleFiles = files; 

  if (!files.length) {
    root.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
      <h3>No files found</h3>
      <p>${state.activeType === 'favourites' ? "You haven't starred any files yet." : "Upload a document to get started."}</p>
    </div>`;
    return;
  }

  const groups = {};
  
  if (state.activeType === "all") {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const lastWeek = today - (86400000 * 7);

    for (const f of files) {
      const t = f.date.getTime();
      let key = "Earlier";
      if (t >= today) key = "Today";
      else if (t >= yesterday) key = "Yesterday";
      else if (t >= lastWeek) key = "This Week";
      (groups[key] = groups[key] || []).push(f);
    }
  } else {
    for (const f of files) {
      const key = (f.ext || "other").toUpperCase();
      (groups[key] = groups[key] || []).push(f);
    }
  }

  const keys = Object.keys(groups).sort();
  if (state.activeType === "all") {
    const order = ["Today", "Yesterday", "This Week", "Earlier"];
    keys.sort((a,b) => order.indexOf(a) - order.indexOf(b));
  }

  for (const key of keys) {
    const items = groups[key];
    const group = document.createElement("div");
    group.className = "group";
    group.innerHTML = `
      <div class="group-head">
        <h2>${escapeHtml(key)}</h2>
        <span class="count">${items.length}</span>
      </div>
      <div class="grid"></div>
    `;

    const grid = group.querySelector(".grid");
    for (const f of items) grid.appendChild(cardFor(f));
    root.appendChild(group);
  }
}

/* ─── CARD ──────────────────────────────────────────────────────────── */
function toggleFav(path, event) {
  event.stopPropagation();
  if (favourites.includes(path)) {
    favourites = favourites.filter(p => p !== path);
  } else {
    favourites.push(path);
  }
  localStorage.setItem("doc_favourites", JSON.stringify(favourites));
  buildTypeNav();
  render();
}

function cardFor(f) {
  const isFav = favourites.includes(f.path);
  const el = document.createElement("div");
  el.className = "card";
  el.onclick = (e) => {
    if (e.target.closest('.actions') || e.target.closest('.star-btn')) return;
    openViewer(f);
  };

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.innerHTML = `
    <button class="star-btn ${isFav ? 'active' : ''}" onclick="toggleFav('${escapeHtml(f.path)}', event)" title="${isFav ? 'Remove from Favourites' : 'Add to Favourites'}">
      <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
    </button>
    ${previewHtml(f)}
  `;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `
    <div class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
    <div class="detail">${humanSize(f.size)}</div>
    <div class="actions">
      <div class="group-left">
        <a href="${f.url}" download="${escapeHtml(f.name)}">Download</a>
      </div>
      <button class="danger" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}">Delete</button>
    </div>
  `;
  meta.querySelector(".danger").onclick = (e) => { e.stopPropagation(); del(f); };

  el.appendChild(preview);
  el.appendChild(meta);
  return el;
}

function previewHtml(f) {
  const u = f.url, nameEsc = escapeHtml(f.name);
  switch (f.kind) {
    case "image":
      return `<img src="${u}" alt="${nameEsc}" loading="lazy">`;
    case "audio":
      return `<div class="icon" title="Audio">🎵</div>`;
    case "video":
      return `<video src="${u}" preload="metadata"></video>`;
    case "pdf":  return `<div class="icon" title="PDF">📄</div>`;
    case "text": return `<div class="icon" title="Text">📝</div>`;
    default:     return `<div class="icon" title="${escapeHtml(f.ext || "file")}">📦</div>`;
  }
}

/* ─── DELETE ────────────────────────────────────────────────────────── */
async function del(f) {
  if (!confirm(`Delete "${f.name}"?`)) return;

  try {
    const head = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURI(f.path)}?ref=${BRANCH}`, {
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!head.ok) throw new Error(`Read failed (${head.status})`);
    const info = await head.json();

    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURI(f.path)}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Delete ${f.name}`,
        sha: info.sha,
        branch: BRANCH,
      }),
    });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);

    toast(`Deleted ${f.name}`);
    
    if (favourites.includes(f.path)) {
      favourites = favourites.filter(p => p !== f.path);
      localStorage.setItem("doc_favourites", JSON.stringify(favourites));
    }

    lastLoadTime = Date.now();
    await load();
  } catch (err) {
    toast("Delete failed: " + err.message, true);
  }
}

/* ─── GOOGLE DRIVE VIEWER MODAL ─────────────────────────────────────── */
let currentViewIndex = -1;
let touchStartX = 0;
let touchEndX = 0;

function openViewer(f) {
  currentViewIndex = visibleFiles.findIndex(file => file.path === f.path);
  if (currentViewIndex === -1) return;

  loadViewerFile(visibleFiles[currentViewIndex]);
  document.getElementById("viewerModal").classList.add("show");
}

function loadViewerFile(f) {
  const title = document.getElementById("modalTitle");
  const body  = document.getElementById("modalBody");
  const dlBtn = document.getElementById("modalDownload");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");

  title.textContent = f.name;
  dlBtn.href = f.url;
  dlBtn.setAttribute("download", f.name);
  
  prevBtn.style.visibility = currentViewIndex > 0 ? "visible" : "hidden";
  nextBtn.style.visibility = currentViewIndex < visibleFiles.length - 1 ? "visible" : "hidden";

  if (f.kind === "image") {
    body.innerHTML = `<img src="${f.url}" alt="${f.name}">`;
  } 
  else if (f.kind === "video") {
    body.innerHTML = `<video controls autoplay src="${f.url}" style="max-width:100%; max-height:100%;"></video>`;
  }
  else if (f.kind === "audio") {
    body.innerHTML = `<audio controls autoplay src="${f.url}" style="width:100%; padding:20px;"></audio>`;
  }
  else if (f.kind === "text") {
    // Text files are small, so direct fetch usually works
    fetch(f.url)
      .then(r => r.text())
      .then(txt => {
        body.innerHTML = `<pre style="width:100%; height:100%; margin:0; padding:20px; background:#fff; overflow:auto; border-radius:0; color: #0f172a;">${escapeHtml(txt)}</pre>`;
      })
      .catch(() => {
        body.innerHTML = getDownloadNotice(f, "Text preview unavailable.");
      });
  } 
  else {
    // PDFs and all other unsupported documents (docx, xlsx, zip, etc.)
    // Show a clean notice instead of failing to fetch or auto-downloading.
    body.innerHTML = getDownloadNotice(f, "To view this document, you must download it first.");
  }
}

// Generates the UI notice for files that cannot be previewed
function getDownloadNotice(f, message) {
  return `<div style="text-align:center; color: white; padding: 40px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
    <div style="font-size:64px; margin-bottom:16px;">📄</div>
    <h3 style="margin: 0 0 8px 0; font-size: 20px;">Preview Not Available</h3>
    <p style="color:#cbd5e1; margin-bottom: 24px; max-width: 300px;">${message}</p>
    <a href="${f.url}" download="${f.name}" style="background: var(--primary); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Download File</a>
  </div>`;
}

function navigateViewer(dir) {
  const newIndex = currentViewIndex + dir;
  if (newIndex >= 0 && newIndex < visibleFiles.length) {
    currentViewIndex = newIndex;
    loadViewerFile(visibleFiles[currentViewIndex]);
  }
}

function closeViewerModal(e) {
  if (e && e.target.id !== "viewerModal" && e.target.tagName !== "BUTTON" && e.target.tagName !== "DIV") return;
  document.getElementById("viewerModal").classList.remove("show");
  document.getElementById("modalBody").innerHTML = "";
  currentViewIndex = -1;
}

// Touch Swipe Logic
const modalBody = document.getElementById("modalBody");
if(modalBody) {
  modalBody.addEventListener("touchstart", e => {
    touchStartX = e.changedTouches[0].screenX;
  }, {passive: true});

  modalBody.addEventListener("touchend", e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, {passive: true});
}

function handleSwipe() {
  const swipeThreshold = 50;
  if (touchEndX < touchStartX - swipeThreshold) navigateViewer(1);
  if (touchEndX > touchStartX + swipeThreshold) navigateViewer(-1);
}

// Keyboard Navigation
document.addEventListener("keydown", e => {
  if (document.getElementById("viewerModal").classList.contains("show")) {
    if (e.key === "Escape") closeViewerModal();
    if (e.key === "ArrowRight") navigateViewer(1);
    if (e.key === "ArrowLeft") navigateViewer(-1);
  }
});

/* ─── UTIL ──────────────────────────────────────────────────────────── */
function humanSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024*1024) return (b/1024).toFixed(1) + " KB";
  return (b/(1024*1024)).toFixed(1) + " MB";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]
  ));
}
let toastTimer;
function toast(msg, isError=false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 4000);
}

load();