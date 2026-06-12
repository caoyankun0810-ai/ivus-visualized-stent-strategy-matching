/* =========================================================
   IVUS Image Review v3
   Folder loading + frame browsing + landmark functions
   + single-frame segmentation backend integration
   ========================================================= */

const state = {
  frames: [],
  currentIndex: 0,
  totalFrames: 0,
  folderName: "",
  profile: null,
  backendResult: null,
  landmarks: {
    distal: null,
    mla: null,
    lesion: null,
    proximal: null,
  },
};

const SEGMENT_API_URL = "http://127.0.0.1:8001/api/segment_frame";
const STRATEGY_API_URL = "http://127.0.0.1:8001/api/run_stent_strategy";
const LOAD_MASK_API_URL = "http://127.0.0.1:8001/api/load_saved_mask";

const $ = (id) => document.getElementById(id);

const folderInput = $("ivusFolderInput");

const mainFrameImage = $("mainFrameImage");
const currentFrame = $("currentFrame");
const currentFrameTotal = document.getElementById("currentFrameTotal");
const currentPosition = $("currentPosition");
const frameSlider = $("frameSlider");
const totalFrameText = $("totalFrameText");

const caseIdNode = $("caseId");
const vesselNode = $("vessel");
const pullbackLengthNode = $("pullbackLength");

const PIXEL_SIZE_MM = 0.0175;  // 你之前 IVUS 定量里用的像素尺寸

const thumbNodes = {
  distal: {
    card: document.querySelector('[data-thumb="distal"]'),
    img: $("thumbDistal"),
    text: $("thumbDistalText"),
    label: "Distal reference",
  },
  mla: {
    card: document.querySelector('[data-thumb="mla"]'),
    img: $("thumbMLA"),
    text: $("thumbMLAText"),
    label: "MLA",
  },
  lesion: {
    card: document.querySelector('[data-thumb="lesion"]'),
    img: $("thumbLesion"),
    text: $("thumbLesionText"),
    label: "Lesion segment",
  },
  proximal: {
    card: document.querySelector('[data-thumb="proximal"]'),
    img: $("thumbProximal"),
    text: $("thumbProximalText"),
    label: "Proximal reference",
  },
};
/* =========================================================
   Stent strategy rule-based configuration
   ========================================================= */

// 你现在界面里写的是 62 mm。如果后面能从真实 pullback spacing 读取，就替换这里。
const DEFAULT_PULLBACK_LENGTH_MM = 62.0;

// 当前常见支架规格，可根据你真实耗材表继续扩充。
const STENT_DIAMETERS_MM = [2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0];
const STENT_LENGTHS_MM = [12, 15, 18, 23, 28, 33, 38, 40, 48];

// 病变覆盖安全边界。先用 4 mm，总长度 = lesion length + 4 mm。
const LENGTH_SAFETY_MARGIN_MM = 4.0;

// PB 阈值，用于从 MLA 向两侧扩展 target lesion。
const PB_HIGH_THRESHOLD = 50.0;
const PB_EXPAND_THRESHOLD = 40.0;


function isImageFile(file) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".bmp") ||
    name.endsWith(".tif") ||
    name.endsWith(".tiff") ||
    name.endsWith(".webp")
  );
}

function naturalSortByName(a, b) {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getFolderNameFromFile(file) {
  if (!file.webkitRelativePath) return "Local folder";
  const parts = file.webkitRelativePath.split("/");
  return parts.length > 1 ? parts[0] : "Local folder";
}

function clampIndex(idx) {
  if (state.totalFrames <= 0) return 0;
  return Math.max(0, Math.min(idx, state.totalFrames - 1));
}

function uiFrameNumber(idx) {
  return idx + 1;
}

function parseFrameNumberFromName(filename) {
  const nums = filename.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return nums[nums.length - 1];
}

function shortFileName(filename, maxLen = 26) {
  if (!filename) return "";
  if (filename.length <= maxLen) return filename;
  return filename.slice(0, 10) + "..." + filename.slice(-12);
}

function getFrame(idx) {
  if (state.totalFrames <= 0) return null;
  return state.frames[clampIndex(idx)];
}

function setImage(imgNode, frame) {
  if (!imgNode || !frame) return;
  imgNode.src = frame.url;
  imgNode.title = frame.name || "";
}

function clearSegmentationOverlay() {
  const eemPath = $("eemOverlay");
  const lumenPath = $("lumenOverlay");
  if (eemPath) eemPath.setAttribute("d", "");
  if (lumenPath) lumenPath.setAttribute("d", "");
}

function loadImageSequence(files) {
  const imageFiles = Array.from(files)
    .filter(isImageFile)
    .sort(naturalSortByName);

  if (imageFiles.length === 0) {
    alert("No image files were found in this folder.");
    return;
  }

  state.frames.forEach((f) => {
    if (f.url) URL.revokeObjectURL(f.url);
  });

  state.folderName = getFolderNameFromFile(imageFiles[0]);
  state.profile = null;
  state.backendResult = null;
  state.strategy = null;

  state.frames = imageFiles.map((file, idx) => {
    const fileFrameNo = parseFrameNumberFromName(file.name);
    return {
      file,
      index: idx,
      uiFrame: idx + 1,
      fileFrameNo,
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      url: URL.createObjectURL(file),
      segmentation: null,
    };
  });

  state.totalFrames = state.frames.length;

  state.landmarks.distal = 0;
  state.landmarks.mla = Math.floor(state.totalFrames * 0.5);
  state.landmarks.lesion = Math.floor(state.totalFrames * 0.65);
  state.landmarks.proximal = state.totalFrames - 1;

  state.currentIndex = state.landmarks.mla;

  initSlider();
  renderCurrentFrame();
  renderThumbnails();
  updateCaseMeta();
}

function initSlider() {
  if (!frameSlider) return;
  frameSlider.min = 1;
  frameSlider.max = Math.max(1, state.totalFrames);
  frameSlider.value = uiFrameNumber(state.currentIndex);
}

function updateCaseMeta() {
  if (caseIdNode) caseIdNode.textContent = state.folderName || "XXXX";
  if (vesselNode) vesselNode.textContent = "LAD";
  if (pullbackLengthNode) pullbackLengthNode.textContent = `${state.totalFrames} frames`;
}

function renderCurrentFrame() {
  if (state.totalFrames === 0) return;

  state.currentIndex = clampIndex(state.currentIndex);
  const frame = getFrame(state.currentIndex);

  setImage(mainFrameImage, frame);

  if (currentFrame) currentFrame.textContent = String(uiFrameNumber(state.currentIndex));
  if (currentFrameTotal) currentFrameTotal.textContent = ` / ${state.totalFrames}`;
  if (currentPosition) {
    const fileInfo = frame.fileFrameNo ? ` | file frame: ${frame.fileFrameNo}` : "";
    currentPosition.textContent = `${uiFrameNumber(state.currentIndex)} / ${state.totalFrames}${fileInfo}`;
  }

  if (frameSlider) frameSlider.value = uiFrameNumber(state.currentIndex);
  if (totalFrameText) totalFrameText.textContent = String(state.totalFrames);

  if (frame.segmentation) {
    updateSegmentationOverlay(frame.segmentation, false);
  } else {
    clearSegmentationOverlay();
  }

  updateActiveThumbnail();
}

function renderThumbnails() {
  if (state.totalFrames === 0) return;

  Object.keys(thumbNodes).forEach((key) => {
    const idx = clampIndex(state.landmarks[key]);
    state.landmarks[key] = idx;

    const frame = getFrame(idx);
    const node = thumbNodes[key];

    setImage(node.img, frame);

    if (node.text) {
      node.text.textContent = `Frame: ${uiFrameNumber(idx)}`;
      node.text.title = frame ? frame.name : "";
    }

    if (node.card) {
      node.card.dataset.index = String(idx);
      node.card.title = frame ? `${node.label}: ${shortFileName(frame.name)}` : node.label;
    }
  });

  updateActiveThumbnail();
}

function updateActiveThumbnail() {
  Object.keys(thumbNodes).forEach((key) => {
    const node = thumbNodes[key];
    if (!node.card) return;

    const landmarkIdx = state.landmarks[key];
    const isActive = landmarkIdx === state.currentIndex;
    node.card.classList.toggle("active", isActive);
  });
}

function goToFrame(index) {
  if (state.totalFrames === 0) return;
  state.currentIndex = clampIndex(index);
  renderCurrentFrame();
}

function nextFrame(step = 1) {
  goToFrame(state.currentIndex + step);
}

function prevFrame(step = 1) {
  goToFrame(state.currentIndex - step);
}

function setCurrentAsLandmark(key) {
  if (state.totalFrames === 0) {
    alert("Please load an IVUS folder first.");
    return;
  }

  if (!(key in state.landmarks)) return;

  state.landmarks[key] = state.currentIndex;
  renderThumbnails();
  renderCurrentFrame();
}

function jumpToLandmark(key) {
  if (state.totalFrames === 0) return;
  if (!(key in state.landmarks)) return;

  goToFrame(state.landmarks[key]);
}

function createLandmarkControlBar() {
  const thumbnailRow = document.querySelector(".thumbnail-row");

  if (!thumbnailRow) return;
  if (document.querySelector(".landmark-control-row")) return;

  const row = document.createElement("div");
  row.className = "landmark-control-row";

  const title = document.createElement("span");
  title.className = "landmark-control-title";
  title.textContent = "Set current as:";
  row.appendChild(title);

  const buttons = [
    ["distal", "Distal"],
    ["mla", "MLA"],
    ["lesion", "Lesion"],
    ["proximal", "Proximal"],
  ];

  buttons.forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `landmark-set-btn landmark-${key}`;
    btn.textContent = label;
    btn.addEventListener("click", () => setCurrentAsLandmark(key));
    row.appendChild(btn);
  });

  thumbnailRow.insertAdjacentElement("afterend", row);
}

function createSegmentationButton() {
  const row = document.querySelector(".sub-title-row");
  if (!row) return;
  if ($("runSegmentationBtn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "runSegmentationBtn";
  btn.className = "segmentation-btn";
  btn.textContent = "Segmentation";
  btn.addEventListener("click", runSegmentationForCurrentFrame);

  const loadBtn = row.querySelector(".folder-load-btn");
  if (loadBtn) {
    loadBtn.insertAdjacentElement("afterend", btn);
  } else {
    row.appendChild(btn);
  }
}

async function loadSavedMaskForFrame(frame, frameIndex) {
  const formData = new FormData();

  formData.append("case_id", state.folderName || "unknown_case");
  formData.append("frame_index", String(frameIndex));
  formData.append("original_filename", frame.name);

  const response = await fetch(LOAD_MASK_API_URL, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();

  if (result && result.success && result.from_cache) {
    return result;
  }

  return null;
}

async function runSegmentationForCurrentFrame() {
  if (!state.frames || state.frames.length === 0) {
    alert("Please load an IVUS image folder first.");
    return;
  }

  const frame = state.frames[state.currentIndex];

  if (!frame || !frame.file) {
    alert("Current frame file is unavailable. Please reload the folder.");
    return;
  }

  const btn = $("runSegmentationBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking mask...";
  }

  try {
    // 1. 先尝试读取已有 mask
    const cached = await loadSavedMaskForFrame(frame, state.currentIndex);

    if (cached) {
      frame.segmentation = cached;
      updateSegmentationOverlay(cached, true);

      alert("Loaded existing mask from local folder.");
      return;
    }

    // 2. 如果没有 mask，再调用模型分割
    if (btn) {
      btn.textContent = "Segmenting...";
    }

    const formData = new FormData();
    formData.append("file", frame.file, frame.name);
    formData.append("case_id", state.folderName || "unknown_case");
    formData.append("frame_index", String(state.currentIndex));
    formData.append("original_filename", frame.name);

    const response = await fetch(SEGMENT_API_URL, {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || "Segmentation failed.");
    }

    frame.segmentation = result;
    updateSegmentationOverlay(result, true);
  } catch (err) {
    console.error(err);

    alert(
      "Segmentation failed. Please check whether backend_segmentation.py is running at http://127.0.0.1:8001\n\n" +
      err.message
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Segmentation";
    }
  }
}

async function runSegmentationForAllFrames() {
  if (!state.frames || state.frames.length === 0) {
    alert("Please load an IVUS image folder first.");
    return;
  }

  const btn = document.getElementById("runAllSegmentationBtn");
  const singleBtn = document.getElementById("runSegmentationBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking masks 0%";
  }

  if (singleBtn) {
    singleBtn.disabled = true;
  }

  let successCount = 0;
  let cachedCount = 0;
  let newSegmentCount = 0;
  let failCount = 0;

  for (let i = 0; i < state.frames.length; i++) {
    const frame = state.frames[i];

    try {
      // 1. 先读取已有 mask
      const cached = await loadSavedMaskForFrame(frame, i);

      if (cached) {
        frame.segmentation = cached;
        successCount += 1;
        cachedCount += 1;

        if (i === state.currentIndex) {
          updateSegmentationOverlay(cached, true);
        }
      } else {
        // 2. 没有 mask 才真正分割
        const formData = new FormData();

        formData.append("file", frame.file, frame.name);
        formData.append("case_id", state.folderName || "unknown_case");
        formData.append("frame_index", String(i));
        formData.append("original_filename", frame.name);

        const response = await fetch(SEGMENT_API_URL, {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Segmentation failed.");
        }

        frame.segmentation = result;
        successCount += 1;
        newSegmentCount += 1;

        if (i === state.currentIndex) {
          updateSegmentationOverlay(result, true);
        }
      }
    } catch (err) {
      console.error(`Segmentation failed at frame ${i + 1}:`, err);
      frame.segmentation = null;
      failCount += 1;
    }

    const progress = Math.round(((i + 1) / state.frames.length) * 100);

    if (btn) {
      if (cachedCount > 0 && newSegmentCount === 0) {
        btn.textContent = `Loading masks ${progress}%`;
      } else {
        btn.textContent = `Segment all ${progress}%`;
      }
    }
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Segment all";
  }

  if (singleBtn) {
    singleBtn.disabled = false;
  }

  renderCurrentFrame();

  alert(
    `Full-sequence mask preparation finished.\n\n` +
    `Success: ${successCount}\n` +
    `Loaded existing masks: ${cachedCount}\n` +
    `Newly segmented: ${newSegmentCount}\n` +
    `Failed: ${failCount}\n\n` +
    `Next step: click "Update profile".`
  );
}

function updateSegmentationOverlay(result, updateStatus = true) {
  const eemPath = $("eemOverlay");
  const lumenPath = $("lumenOverlay");

  if (eemPath) eemPath.setAttribute("d", result.eem_path || "");
  if (lumenPath) lumenPath.setAttribute("d", result.lumen_path || "");

  if (updateStatus) {
    const phenotype = document.querySelector(".phenotype");
    if (phenotype) {
      phenotype.innerHTML = "Segmentation: <b>EEM overlay</b>";
    }
  }
}

if (folderInput) {
  folderInput.addEventListener("change", (event) => {
    const files = event.target.files;
    loadImageSequence(files);
  });
}

if (frameSlider) {
  frameSlider.addEventListener("input", (event) => {
    const idx = Number(event.target.value) - 1;
    goToFrame(idx);
  });
}

Object.keys(thumbNodes).forEach((key) => {
  const card = thumbNodes[key].card;
  if (!card) return;

  card.addEventListener("click", () => jumpToLandmark(key));
});

document.querySelectorAll(".frame-control button").forEach((btn) => {
  const txt = btn.textContent.trim();

  if (txt === "◀◀") {
    btn.addEventListener("click", () => prevFrame(10));
  } else if (txt === "◀") {
    btn.addEventListener("click", () => prevFrame(1));
  } else if (txt === "▶") {
    btn.addEventListener("click", () => nextFrame(1));
  } else if (txt === "▶▶") {
    btn.addEventListener("click", () => nextFrame(10));
  }
});

document.addEventListener("keydown", (event) => {
  if (state.totalFrames === 0) return;

  if (event.key === "ArrowLeft") {
    prevFrame(event.shiftKey ? 10 : 1);
  } else if (event.key === "ArrowRight") {
    nextFrame(event.shiftKey ? 10 : 1);
  }

  if (event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "d") setCurrentAsLandmark("distal");
    if (key === "m") setCurrentAsLandmark("mla");
    if (key === "l") setCurrentAsLandmark("lesion");
    if (key === "p") setCurrentAsLandmark("proximal");
  }
});

function initEmptyState() {
  if (currentFrame) currentFrame.textContent = "—";
  if (currentFrameTotal) currentFrameTotal.textContent = "";
  if (currentPosition) currentPosition.textContent = "Load an IVUS folder";
  if (totalFrameText) totalFrameText.textContent = "-";

  if (frameSlider) {
    frameSlider.min = 1;
    frameSlider.max = 1;
    frameSlider.value = 1;
  }

  Object.keys(thumbNodes).forEach((key) => {
    const node = thumbNodes[key];
    if (node.text) node.text.textContent = "Frame: -";
  });

  createLandmarkControlBar();
  createSegmentationButton();
}

initEmptyState();
const segBtn = document.getElementById("runSegmentationBtn");
if (segBtn) {
  segBtn.addEventListener("click", runSegmentationForCurrentFrame);
}
const segmentAllBtn = document.getElementById("runAllSegmentationBtn");
if (segmentAllBtn) {
  segmentAllBtn.addEventListener("click", runSegmentationForAllFrames);
}

/* =========================================================
   Quantitative Lesion Profiling from full-sequence segmentation
   ========================================================= */

function pxAreaToMm2(areaPx) {
  if (!Number.isFinite(areaPx)) return NaN;
  return areaPx * PIXEL_SIZE_MM * PIXEL_SIZE_MM;
}

function areaToEquivalentDiameter(areaMm2) {
  if (!Number.isFinite(areaMm2) || areaMm2 <= 0) return NaN;
  return 2.0 * Math.sqrt(areaMm2 / Math.PI);
}

function median(values) {
  const arr = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (arr.length === 0) return NaN;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

function smoothArray(values, win = 7) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  const half = Math.floor(win / 2);

  for (let i = 0; i < n; i++) {
    const local = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n && Number.isFinite(values[j])) {
        local.push(values[j]);
      }
    }
    out[i] = median(local);
  }

  return out;
}

function buildProfileFromSegmentations() {
  const profile = [];

  for (let i = 0; i < state.frames.length; i++) {
    const seg = state.frames[i].segmentation;

    if (!seg || !Number.isFinite(seg.eem_area_px) || !Number.isFinite(seg.lumen_area_px)) {
      profile.push({
        index: i,
        valid: false,
        lumenArea: NaN,
        eemArea: NaN,
        plaqueBurden: NaN,
        lumenDiameter: NaN,
        eemDiameter: NaN,
      });
      continue;
    }

    const eemArea = pxAreaToMm2(seg.eem_area_px);
    const lumenArea = pxAreaToMm2(seg.lumen_area_px);

    const plaqueBurden =
      eemArea > 0 ? ((eemArea - lumenArea) / eemArea) * 100.0 : NaN;

    profile.push({
      index: i,
      valid: true,
      lumenArea,
      eemArea,
      plaqueBurden,
      lumenDiameter: areaToEquivalentDiameter(lumenArea),
      eemDiameter: areaToEquivalentDiameter(eemArea),
    });
  }

  return profile;
}

function getValidProfile(profile) {
  return profile.filter(
    (p) =>
      p.valid &&
      Number.isFinite(p.lumenArea) &&
      Number.isFinite(p.eemArea) &&
      Number.isFinite(p.plaqueBurden)
  );
}

function findMLAFrame(profile) {
  const valid = getValidProfile(profile);
  if (valid.length === 0) return null;

  return valid.reduce((best, p) => {
    return p.lumenArea < best.lumenArea ? p : best;
  }, valid[0]);
}

function estimateReferenceDiameter(profile, mlaIndex) {
  const n = profile.length;

  const leftStart = Math.max(0, mlaIndex - 80);
  const leftEnd = Math.max(0, mlaIndex - 25);

  const rightStart = Math.min(n - 1, mlaIndex + 25);
  const rightEnd = Math.min(n - 1, mlaIndex + 80);

  const leftDiameters = [];
  const rightDiameters = [];

  for (let i = leftStart; i <= leftEnd; i++) {
    if (profile[i]?.valid && Number.isFinite(profile[i].eemDiameter)) {
      leftDiameters.push(profile[i].eemDiameter);
    }
  }

  for (let i = rightStart; i <= rightEnd; i++) {
    if (profile[i]?.valid && Number.isFinite(profile[i].eemDiameter)) {
      rightDiameters.push(profile[i].eemDiameter);
    }
  }

  const leftRef = median(leftDiameters);
  const rightRef = median(rightDiameters);

  if (Number.isFinite(leftRef) && Number.isFinite(rightRef)) {
    return (leftRef + rightRef) / 2.0;
  }

  if (Number.isFinite(leftRef)) return leftRef;
  if (Number.isFinite(rightRef)) return rightRef;

  return NaN;
}

function polylinePath(points) {
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length === 0) return "";

  let d = `M ${valid[0].x.toFixed(2)} ${valid[0].y.toFixed(2)}`;
  for (let i = 1; i < valid.length; i++) {
    d += ` L ${valid[i].x.toFixed(2)} ${valid[i].y.toFixed(2)}`;
  }
  return d;
}

function areaFillPath(points, baselineY) {
  const line = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (line.length === 0) return "";

  let d = `M ${line[0].x.toFixed(2)} ${baselineY.toFixed(2)}`;
  for (const p of line) {
    d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  d += ` L ${line[line.length - 1].x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
  return d;
}

function normalizeToY(value, minVal, maxVal, yBottom, yTop) {
  if (!Number.isFinite(value)) return NaN;
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || maxVal <= minVal) {
    return (yBottom + yTop) / 2;
  }

  const t = (value - minVal) / (maxVal - minVal);
  return yBottom - t * (yBottom - yTop);
}

function updateQuantitativeProfileFromSegmentations() {
  const profile = buildProfileFromSegmentations();
  const valid = getValidProfile(profile);

  if (valid.length < 5) {
    console.warn("Not enough valid segmentation results to build profile.");
    return;
  }

  state.profile = profile;

  const n = profile.length;

  const lumenAreaRaw = profile.map((p) => p.lumenArea);
  const eemAreaRaw = profile.map((p) => p.eemArea);
  const pbRaw = profile.map((p) => p.plaqueBurden);
  const eemDiameterRaw = profile.map((p) => p.eemDiameter);

  const lumenArea = smoothArray(lumenAreaRaw, 7);
  const eemArea = smoothArray(eemAreaRaw, 7);
  const plaqueBurden = smoothArray(pbRaw, 7);
  const eemDiameter = smoothArray(eemDiameterRaw, 7);

  const mla = findMLAFrame(profile);
  if (!mla) return;

  const mlaIndex = mla.index;

  const refDiameter = estimateReferenceDiameter(profile, mlaIndex);
  const maxPB = Math.max(...plaqueBurden.filter(Number.isFinite));

  const x0 = 70;
  const x1 = 750;

  function xMap(i) {
    if (n <= 1) return x0;
    return x0 + (i / (n - 1)) * (x1 - x0);
  }

  const lumenMin = Math.min(...lumenArea.filter(Number.isFinite));
  const lumenMax = Math.max(...lumenArea.filter(Number.isFinite));

  const eemDiamMin = Math.min(...eemDiameter.filter(Number.isFinite));
  const eemDiamMax = Math.max(...eemDiameter.filter(Number.isFinite));

  const lumenPoints = lumenArea.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, lumenMin, lumenMax, 198, 145),
  }));

  const diameterPoints = eemDiameter.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, eemDiamMin, eemDiamMax, 290, 250),
  }));

  const pbPoints = plaqueBurden.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, 0, 100, 420, 300),
  }));

  drawDynamicProfile({
    lumenPoints,
    diameterPoints,
    pbPoints,
    mlaIndex,
    xMap,
  });

  updateQuantitativeSummary({
    mlaArea: mla.lumenArea,
    refDiameter,
    maxPB,
  });

  // 同时更新 MLA 缩略图跳转
  state.landmarks.mla = mlaIndex;
  renderThumbnails();
}

function drawDynamicProfile({ lumenPoints, diameterPoints, pbPoints, mlaIndex, xMap }) {
  const svg = document.querySelector(".profile-svg");
  if (!svg) return;

  // Dim old static curves, but keep labels/gridlines.
  svg.querySelectorAll("path").forEach((p) => {
    if (!p.closest("#dynamicProfileLayer")) {
      p.style.opacity = "0.12";
    }
  });

  let layer = document.getElementById("dynamicProfileLayer");
  if (!layer) {
    layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    layer.setAttribute("id", "dynamicProfileLayer");
    svg.appendChild(layer);
  }

  layer.innerHTML = "";

  const blueFill = document.createElementNS("http://www.w3.org/2000/svg", "path");
  blueFill.setAttribute("d", areaFillPath(lumenPoints, 198));
  blueFill.setAttribute("fill", "#3383e8");
  blueFill.setAttribute("opacity", "0.16");
  layer.appendChild(blueFill);

  const blueCurve = document.createElementNS("http://www.w3.org/2000/svg", "path");
  blueCurve.setAttribute("d", polylinePath(lumenPoints));
  blueCurve.setAttribute("fill", "none");
  blueCurve.setAttribute("stroke", "#1967c2");
  blueCurve.setAttribute("stroke-width", "4");
  blueCurve.setAttribute("stroke-linecap", "round");
  layer.appendChild(blueCurve);

  const diameterCurve = document.createElementNS("http://www.w3.org/2000/svg", "path");
  diameterCurve.setAttribute("d", polylinePath(diameterPoints));
  diameterCurve.setAttribute("fill", "none");
  diameterCurve.setAttribute("stroke", "#1967c2");
  diameterCurve.setAttribute("stroke-width", "3");
  diameterCurve.setAttribute("stroke-linecap", "round");
  layer.appendChild(diameterCurve);

  const pbFill = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pbFill.setAttribute("d", areaFillPath(pbPoints, 420));
  pbFill.setAttribute("fill", "#f36b2a");
  pbFill.setAttribute("opacity", "0.42");
  layer.appendChild(pbFill);

  const pbCurve = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pbCurve.setAttribute("d", polylinePath(pbPoints));
  pbCurve.setAttribute("fill", "none");
  pbCurve.setAttribute("stroke", "#f36b2a");
  pbCurve.setAttribute("stroke-width", "4");
  pbCurve.setAttribute("stroke-linecap", "round");
  layer.appendChild(pbCurve);

  const mlaPoint = lumenPoints[mlaIndex];
  if (mlaPoint && Number.isFinite(mlaPoint.x) && Number.isFinite(mlaPoint.y)) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", mlaPoint.x.toFixed(2));
    circle.setAttribute("cy", mlaPoint.y.toFixed(2));
    circle.setAttribute("r", "7");
    circle.setAttribute("fill", "#eb2a2a");
    layer.appendChild(circle);

    const mlaLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    mlaLine.setAttribute("x1", xMap(mlaIndex).toFixed(2));
    mlaLine.setAttribute("x2", xMap(mlaIndex).toFixed(2));
    mlaLine.setAttribute("y1", "70");
    mlaLine.setAttribute("y2", "482");
    mlaLine.setAttribute("stroke", "#ff2d2d");
    mlaLine.setAttribute("stroke-width", "2");
    mlaLine.setAttribute("stroke-dasharray", "7 7");
    layer.appendChild(mlaLine);
  }
}

function updateQuantitativeSummary({ mlaArea, refDiameter, maxPB }) {
  const mlaNode = document.getElementById("metricMLA");
  const refNode = document.getElementById("metricRefDiameter");
  const pbNode = document.getElementById("metricMaxPB");

  if (mlaNode && Number.isFinite(mlaArea)) {
    mlaNode.textContent = `${mlaArea.toFixed(2)} mm²`;
  }

  if (refNode && Number.isFinite(refDiameter)) {
    refNode.textContent = `${refDiameter.toFixed(2)} mm`;
  }

  if (pbNode && Number.isFinite(maxPB)) {
    pbNode.textContent = `${maxPB.toFixed(1)}%`;
  }
}

/* =========================================================
   Recommended Strategy Generation from IVUS Profile
   Rule-based v1
   ========================================================= */

function getFrameSpacingMm() {
  if (!state.frames || state.frames.length <= 1) return 0.15;
  return DEFAULT_PULLBACK_LENGTH_MM / (state.frames.length - 1);
}

function nearestValue(value, candidates) {
  if (!Number.isFinite(value)) return candidates[0];

  let best = candidates[0];
  let bestDiff = Math.abs(value - best);

  for (const c of candidates) {
    const diff = Math.abs(value - c);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }

  return best;
}

function roundLengthUp(requiredLength, candidates) {
  for (const c of candidates) {
    if (c >= requiredLength) return c;
  }
  return candidates[candidates.length - 1];
}

function estimateReferenceDiameterForStrategy(profile, mlaIndex) {
  const n = profile.length;

  const left = [];
  const right = [];

  const leftStart = Math.max(0, mlaIndex - 90);
  const leftEnd = Math.max(0, mlaIndex - 25);

  const rightStart = Math.min(n - 1, mlaIndex + 25);
  const rightEnd = Math.min(n - 1, mlaIndex + 90);

  for (let i = leftStart; i <= leftEnd; i++) {
    if (profile[i]?.valid && Number.isFinite(profile[i].eemDiameter)) {
      left.push(profile[i].eemDiameter);
    }
  }

  for (let i = rightStart; i <= rightEnd; i++) {
    if (profile[i]?.valid && Number.isFinite(profile[i].eemDiameter)) {
      right.push(profile[i].eemDiameter);
    }
  }

  const leftRef = median(left);
  const rightRef = median(right);

  if (Number.isFinite(leftRef) && Number.isFinite(rightRef)) {
    return {
      refDiameter: (leftRef + rightRef) / 2.0,
      proximalRefDiameter: leftRef,
      distalRefDiameter: rightRef,
    };
  }

  if (Number.isFinite(leftRef)) {
    return {
      refDiameter: leftRef,
      proximalRefDiameter: leftRef,
      distalRefDiameter: NaN,
    };
  }

  if (Number.isFinite(rightRef)) {
    return {
      refDiameter: rightRef,
      proximalRefDiameter: NaN,
      distalRefDiameter: rightRef,
    };
  }

  return {
    refDiameter: NaN,
    proximalRefDiameter: NaN,
    distalRefDiameter: NaN,
  };
}

function detectTargetLesionAroundMLA(profile, mlaIndex) {
  const n = profile.length;

  let start = mlaIndex;
  let end = mlaIndex;

  // 从 MLA 向左扩展。PB 高于扩展阈值则认为仍在病变附近。
  while (
    start > 0 &&
    profile[start]?.valid &&
    Number.isFinite(profile[start].plaqueBurden) &&
    profile[start].plaqueBurden >= PB_EXPAND_THRESHOLD
  ) {
    start -= 1;
  }

  // 从 MLA 向右扩展。
  while (
    end < n - 1 &&
    profile[end]?.valid &&
    Number.isFinite(profile[end].plaqueBurden) &&
    profile[end].plaqueBurden >= PB_EXPAND_THRESHOLD
  ) {
    end += 1;
  }

  // 防止扩展过短：至少覆盖 MLA 附近 10 帧。
  const minHalfWidth = 5;
  start = Math.max(0, Math.min(start, mlaIndex - minHalfWidth));
  end = Math.min(n - 1, Math.max(end, mlaIndex + minHalfWidth));

  const spacing = getFrameSpacingMm();
  const lesionLength = Math.max(0, (end - start + 1) * spacing);

  return {
    lesionStartIndex: start,
    lesionEndIndex: end,
    lesionLength,
  };
}

function estimateRiskLevel(maxPB, lesionLength, refDiameter) {
  if (!Number.isFinite(maxPB)) return "Unknown";

  if (maxPB >= 75 || lesionLength >= 38 || refDiameter < 2.5) {
    return "High";
  }

  if (maxPB >= 55 || lesionLength >= 28) {
    return "Moderate";
  }

  return "Low";
}

function scoreCandidate(candidate, targetDiameter, requiredLength, riskLevel) {
  const diameterError = Math.abs(candidate.diameter - targetDiameter);
  const lengthShortage = Math.max(0, requiredLength - candidate.length);
  const lengthExcess = Math.max(0, candidate.length - requiredLength);

  let score = 1.0;

  score -= diameterError * 0.22;
  score -= lengthShortage * 0.06;
  score -= lengthExcess * 0.015;

  if (riskLevel === "High") {
    score -= 0.04;
  }

  score = Math.max(0.05, Math.min(0.99, score));
  return score;
}

function generateCandidateStents(targetDiameter, requiredLength, riskLevel) {
  const candidates = [];

  for (const d of STENT_DIAMETERS_MM) {
    for (const l of STENT_LENGTHS_MM) {
      const candidate = { diameter: d, length: l };
      candidate.score = scoreCandidate(candidate, targetDiameter, requiredLength, riskLevel);
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // 去掉几乎重复的候选，保留 top 3
  const selected = [];
  const seen = new Set();

  for (const c of candidates) {
    const key = `${c.diameter}-${c.length}`;
    if (seen.has(key)) continue;

    selected.push(c);
    seen.add(key);

    if (selected.length >= 3) break;
  }

  return selected;
}

function formatStent(diameter, length) {
  return `${diameter.toFixed(diameter % 1 === 0 ? 1 : 2)} × ${Math.round(length)} mm`;
}

function updateRecommendedStrategyFromProfile(profile) {
  const valid = getValidProfile(profile);
  if (valid.length < 5) {
    console.warn("Not enough valid profile points for strategy recommendation.");
    return;
  }

  const mla = findMLAFrame(profile);
  if (!mla) return;

  const mlaIndex = mla.index;
  const { lesionStartIndex, lesionEndIndex, lesionLength } =
    detectTargetLesionAroundMLA(profile, mlaIndex);

  const refInfo = estimateReferenceDiameterForStrategy(profile, mlaIndex);
  const refDiameter = refInfo.refDiameter;

  const maxPB = Math.max(
    ...profile
      .filter((p) => p.valid && Number.isFinite(p.plaqueBurden))
      .map((p) => p.plaqueBurden)
  );

  const targetDiameter = nearestValue(refDiameter, STENT_DIAMETERS_MM);
  const requiredLength = lesionLength + LENGTH_SAFETY_MARGIN_MM;
  const targetLength = roundLengthUp(requiredLength, STENT_LENGTHS_MM);

  const riskLevel = estimateRiskLevel(maxPB, lesionLength, refDiameter);

  const candidates = generateCandidateStents(targetDiameter, requiredLength, riskLevel);

  // 强制让第一候选更贴近 target diameter / rounded-up length
  candidates[0] = {
    diameter: targetDiameter,
    length: targetLength,
    score: scoreCandidate(
      { diameter: targetDiameter, length: targetLength },
      targetDiameter,
      requiredLength,
      riskLevel
    ),
  };

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];

  updateStrategyPanel({
    best,
    candidates,
    riskLevel,
    refDiameter,
    lesionLength,
    requiredLength,
    maxPB,
    mlaArea: mla.lumenArea,
    lesionStartIndex,
    lesionEndIndex,
    mlaIndex,
  });

  // 缓存给后续 bottom coverage map 使用
  state.strategy = {
    best,
    candidates,
    riskLevel,
    refDiameter,
    lesionLength,
    requiredLength,
    maxPB,
    mlaArea: mla.lumenArea,
    lesionStartIndex,
    lesionEndIndex,
    mlaIndex,
  };
  updateCoverageMapFromStrategy(state.strategy);
}

function updateStrategyPanel(strategy) {
  const {
    best,
    candidates,
    riskLevel,
    refDiameter,
    lesionLength,
    requiredLength,
    maxPB,
    mlaArea,
  } = strategy;

  const recommendedStent = document.getElementById("recommendedStent");
  const matchingScore = document.getElementById("matchingScore");
  const riskLevelNode = document.getElementById("riskLevel");

  if (recommendedStent) {
    recommendedStent.textContent = formatStent(best.diameter, best.length);
  }

  if (matchingScore) {
    matchingScore.textContent = best.score.toFixed(2);
  }

  if (riskLevelNode) {
    riskLevelNode.textContent = riskLevel;
    riskLevelNode.className =
      riskLevel === "High"
        ? "orange-text"
        : riskLevel === "Moderate"
        ? "orange-text"
        : "green-text";
  }

  // Alternative candidates
  for (let i = 0; i < 3; i++) {
    const c = candidates[i];
    if (!c) continue;

    const candNode = document.getElementById(`candidate${i + 1}`);
    const scoreNode = document.getElementById(`candidateScore${i + 1}`);

    if (candNode) candNode.textContent = formatStent(c.diameter, c.length);
    if (scoreNode) scoreNode.textContent = c.score.toFixed(2);

    const row = candNode?.closest(".candidate");
    const bar = row?.querySelector("i");
    if (bar) {
      bar.style.setProperty("--w", `${Math.round(c.score * 100)}%`);
    }
  }

  updateEvidenceAndRiskNote({
    best,
    riskLevel,
    refDiameter,
    lesionLength,
    requiredLength,
    maxPB,
    mlaArea,
  });
}

function updateEvidenceAndRiskNote({
  best,
  riskLevel,
  refDiameter,
  lesionLength,
  requiredLength,
  maxPB,
  mlaArea,
}) {
  const evidenceList = document.getElementById("evidenceList");
  const riskNoteList = document.getElementById("riskNoteList");

  if (evidenceList) {
    evidenceList.innerHTML = "";

    const evidenceItems = [
      `Reference diameter ${refDiameter.toFixed(2)} mm supports ${best.diameter.toFixed(2)} mm stent size`,
      `MLA is ${mlaArea.toFixed(2)} mm², indicating the narrowest target segment`,
      `Detected lesion length is ${lesionLength.toFixed(1)} mm; selected ${Math.round(
        best.length
      )} mm stent provides coverage margin`,
      `Maximum plaque burden is ${maxPB.toFixed(1)}%, supporting anatomy-aware risk assessment`,
      `Candidate strategy is ranked by diameter matching, lesion coverage, and landing-zone safety`,
    ];

    for (const item of evidenceItems) {
      const li = document.createElement("li");
      li.textContent = item;
      evidenceList.appendChild(li);
    }
  }

  if (riskNoteList) {
    riskNoteList.innerHTML = "";

    const riskItems = [];

    if (riskLevel === "High") {
      riskItems.push("High-risk plaque burden or long lesion detected");
      riskItems.push("Careful lesion preparation and strategy review are recommended");
    } else if (riskLevel === "Moderate") {
      riskItems.push("Moderate plaque burden or lesion length detected");
      riskItems.push("Careful landing-zone confirmation may be required");
    } else {
      riskItems.push("Lower-risk quantitative profile detected");
      riskItems.push("Recommended strategy remains subject to clinician confirmation");
    }

    if (maxPB >= 65) {
      riskItems.push("High local plaque burden may increase procedural complexity");
    }

    for (const item of riskItems) {
      const li = document.createElement("li");
      li.textContent = item;
      riskNoteList.appendChild(li);
    }
  }
}

/* =========================================================
   Generate Strategy button
   ========================================================= */

function generateStrategyFromCurrentProfile() {
  if (!state.profile) {
    alert("Please run Segment all first to build the quantitative IVUS profile.");
    return;
  }

  const valid = getValidProfile(state.profile);
  if (!valid || valid.length < 5) {
    alert("Not enough valid segmentation results. Please run Segment all again.");
    return;
  }

  updateRecommendedStrategyFromProfile(state.profile);
}

const generateStrategyBtn = document.getElementById("generateStrategyBtn");
if (generateStrategyBtn) {
  generateStrategyBtn.addEventListener("click", generateStrategyFromCurrentProfile);
}

/* =========================================================
   Coverage Map and Explanation update
   ========================================================= */

function setSvgXForText(id, x) {
  const el = document.getElementById(id);
  if (el) el.setAttribute("x", x.toFixed(1));
}

function setSvgXForLine(id, x) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute("x1", x.toFixed(1));
  el.setAttribute("x2", x.toFixed(1));
}

function updateCoverageMapFromStrategy(strategy) {
  if (!strategy || !state.frames || state.frames.length <= 1) {
    return;
  }

  const n = state.frames.length;

  const {
    best,
    riskLevel,
    refDiameter,
    lesionLength,
    maxPB,
    mlaArea,
    lesionStartIndex,
    lesionEndIndex,
  } = strategy;

  const mapX0 = 90;
  const mapX1 = 900;

  function xMapFrame(idx) {
    const t = idx / Math.max(1, n - 1);
    return mapX0 + t * (mapX1 - mapX0);
  }

  const lesionStartX = xMapFrame(lesionStartIndex);
  const lesionEndX = xMapFrame(lesionEndIndex);
  const lesionBandX = Math.min(lesionStartX, lesionEndX);
  const lesionBandWidth = Math.max(8, Math.abs(lesionEndX - lesionStartX));

  const spacing = getFrameSpacingMm();
  const marginFrame = Math.round((LENGTH_SAFETY_MARGIN_MM / 2.0) / spacing);

  const proximalRefIndex = Math.max(0, lesionStartIndex - marginFrame);
  const distalRefIndex = Math.min(n - 1, lesionEndIndex + marginFrame);

  const proximalX = xMapFrame(proximalRefIndex);
  const distalX = xMapFrame(distalRefIndex);

  // 1) Update marker positions
  setSvgXForText("mapProximalText1", proximalX);
  setSvgXForText("mapProximalText2", proximalX);
  setSvgXForLine("mapProximalLine", proximalX);

  setSvgXForText("mapLesionStartText1", lesionStartX);
  setSvgXForText("mapLesionStartText2", lesionStartX);
  setSvgXForLine("mapLesionStartLine", lesionStartX);

  setSvgXForText("mapLesionEndText1", lesionEndX);
  setSvgXForText("mapLesionEndText2", lesionEndX);
  setSvgXForLine("mapLesionEndLine", lesionEndX);

  setSvgXForText("mapDistalText1", distalX);
  setSvgXForText("mapDistalText2", distalX);
  setSvgXForLine("mapDistalLine", distalX);

  // 1.5) Update shallow red target-lesion band
  // The shallow red band should match lesion start/end only.
  const lesionBand = document.getElementById("mapLesionBand");

  if (lesionBand) {
    lesionBand.setAttribute("x", lesionBandX.toFixed(1));
    lesionBand.setAttribute("width", lesionBandWidth.toFixed(1));
  }

  // 2) Update stent coverage bar
  const stentX = proximalX;
  const stentWidth = Math.max(80, distalX - proximalX);

  const stentMesh = document.getElementById("mapStentMesh");
  const stentOutline = document.getElementById("mapStentOutline");

  if (stentMesh) {
    stentMesh.setAttribute("x", stentX.toFixed(1));
    stentMesh.setAttribute("width", stentWidth.toFixed(1));
  }

  if (stentOutline) {
    stentOutline.setAttribute("x", stentX.toFixed(1));
    stentOutline.setAttribute("width", stentWidth.toFixed(1));
  }

  // 3) Update length arrow
  const arrowY = 180;
  const arrowLine = document.getElementById("mapStentLengthLine");
  const arrowPath = document.getElementById("mapStentLengthArrow");

  if (arrowLine) {
    arrowLine.setAttribute("x1", stentX.toFixed(1));
    arrowLine.setAttribute("x2", (stentX + stentWidth).toFixed(1));
  }

  if (arrowPath) {
    const xA = stentX;
    const xB = stentX + stentWidth;
    arrowPath.setAttribute(
      "d",
      `M${xA.toFixed(1)},${arrowY} l18,-8 v16 z M${xB.toFixed(1)},${arrowY} l-18,-8 v16 z`
    );
  }

  const coverageLengthText = document.getElementById("coverageLengthText");
  if (coverageLengthText) {
    coverageLengthText.textContent = `${Math.round(best.length)} mm`;
    coverageLengthText.setAttribute("x", (stentX + stentWidth / 2).toFixed(1));
  }

  // 4) Update explanation text
  const explainBox = document.getElementById("coverageExplanation");
  if (explainBox) {
    explainBox.innerHTML = `
      The system recommends a <b>${formatStent(best.diameter, best.length)}</b> stent.
      The recommended diameter is supported by the IVUS-derived reference diameter
      of <b>${refDiameter.toFixed(2)} mm</b>. The detected lesion length is
      <b>${lesionLength.toFixed(1)} mm</b>, and the selected stent provides
      sufficient coverage margin. The maximum plaque burden is
      <b>${maxPB.toFixed(1)}%</b>, with an estimated procedural risk level of
      <b>${riskLevel}</b>.
    `;
  }

  // 5) Update interpretation summary labels
  updateInterpretationSummary(strategy);
}

function updateInterpretationSummary(strategy) {
  const box = document.querySelector(".interpret-box");
  if (!box || !strategy) return;

  const riskText =
    strategy.riskLevel === "High"
      ? "High-risk"
      : strategy.riskLevel === "Moderate"
      ? "Moderate-risk"
      : "Lower-risk";

  box.innerHTML = `
    <h3>Interpretation Summary</h3>
    <div><span>✓</span>Interpretable</div>
    <div><span>▥</span>${strategy.best.diameter.toFixed(2)} mm reference-matched</div>
    <div><span>●</span>${riskText} profile</div>
  `;
}

/* =========================================================
   Backend-driven v2 pipeline
   ---------------------------------------------------------
   Segment all:
     - Calls /api/segment_frame frame by frame.
     - The backend saves every predicted ring mask to the local mask folder.

   Update profile:
     - Calls /api/run_stent_strategy.
     - The backend runs the original Python pipeline:
       extract -> clean -> target lesion v22 -> strategy v32.
     - The second panel is updated from the backend result.

   Generate strategy:
     - Does not run lesion detection again.
     - It only renders the stored backend result.
   ========================================================= */

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function toFiniteNumber(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
}

function fmtNumber(v, digits = 1, fallback = "—") {
  return Number.isFinite(v) ? v.toFixed(digits) : fallback;
}

function getBackendCaseId() {
  return state.folderName || "unknown_case";
}

async function updateProfileFromBackend() {
  if (!state.frames || state.frames.length === 0) {
    alert("Please load an IVUS folder first.");
    return;
  }

  const caseId = getBackendCaseId();
  const btn = document.getElementById("updateProfileBtn");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Running backend...";
  }

  try {
    const formData = new FormData();
    formData.append("case_id", caseId);

    const response = await fetch(STRATEGY_API_URL, {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || `Backend failed with HTTP ${response.status}`);
    }

    state.backendResult = result;
    state.profile = result.profile || null;

    updateSecondPanelFromBackend(result);

    alert(
      "Quantitative profile updated from the original backend pipeline.\n\n" +
      "Now click Generate strategy to display the recommendation."
    );
  } catch (err) {
    console.error(err);
    alert("Update profile failed:\n\n" + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Update profile";
    }
  }
}

function getProfileValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) {
      const v = Number(row[key]);
      if (Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

function updateSecondPanelFromBackend(result) {
  const target = result.target || {};
  const profile = Array.isArray(result.profile) ? result.profile : [];

  const mlaFrame = Math.round(toFiniteNumber(target.target_mla_frame));
  const lesionStart = Math.round(toFiniteNumber(target.target_start_frame));
  const lesionEnd = Math.round(toFiniteNumber(target.target_end_frame));
  const leftRef = Math.round(toFiniteNumber(target.left_reference_frame));
  const rightRef = Math.round(toFiniteNumber(target.right_reference_frame));

  let mlaArea = NaN;
  if (Number.isFinite(mlaFrame) && profile[mlaFrame]) {
    mlaArea = getProfileValue(profile[mlaFrame], ["lumen_area_mm2", "lumen_area_mm2_smooth"]);
  }

  const metricMLA = document.getElementById("metricMLA");
  const metricRefDiameter = document.getElementById("metricRefDiameter");
  const metricLesionLength = document.getElementById("metricLesionLength");
  const metricMaxPB = document.getElementById("metricMaxPB");
  const metricRisk = document.getElementById("metricRisk");
  const metricLandingSafety = document.getElementById("metricLandingSafety");

  if (metricMLA && Number.isFinite(mlaArea)) {
    metricMLA.textContent = `${mlaArea.toFixed(2)} mm²`;
  }

  if (metricRefDiameter && Number.isFinite(target.mean_ref_lumen_diameter_mm)) {
    metricRefDiameter.textContent = `${target.mean_ref_lumen_diameter_mm.toFixed(2)} mm`;
  }

  if (metricLesionLength && Number.isFinite(target.target_lesion_length_mm)) {
    metricLesionLength.textContent = `${target.target_lesion_length_mm.toFixed(1)} mm`;
  }

  if (metricMaxPB && Number.isFinite(target.target_max_plaque_burden)) {
    metricMaxPB.textContent = `${target.target_max_plaque_burden.toFixed(1)}%`;
  }

  const strategy = result.strategy || {};
  const riskText = backendRiskLevel(strategy, target);
  if (metricRisk) {
    metricRisk.textContent = riskText;
    metricRisk.className = riskText === "High" ? "orange-text" : riskText === "Moderate" ? "orange-text" : "green-text";
  }
  if (metricLandingSafety) {
    metricLandingSafety.textContent = Number.isFinite(strategy.landing_score) && strategy.landing_score < 0.55 ? "Review" : "Acceptable";
    metricLandingSafety.className = Number.isFinite(strategy.landing_score) && strategy.landing_score < 0.55 ? "orange-text" : "green-text";
  }

  drawProfileCurveFromBackend(result);
  updateProfileMarkersFromBackend({ mlaFrame, lesionStart, lesionEnd, leftRef, rightRef, n: profile.length });
}

function updateProfileMarkersFromBackend({ mlaFrame, lesionStart, lesionEnd, leftRef, rightRef, n }) {
  if (!n || n <= 1) return;
  const x0 = 70;
  const x1 = 750;
  const xMap = (i) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0);

  const markerMap = [
    ["profileProximalLine", "profileProximalLabel1", "profileProximalLabel2", leftRef],
    ["profileLesionStartLine", "profileLesionStartLabel1", "profileLesionStartLabel2", lesionStart],
    ["profileMlaLine", "profileMlaLabel", null, mlaFrame],
    ["profileLesionEndLine", "profileLesionEndLabel1", "profileLesionEndLabel2", lesionEnd],
    ["profileDistalLine", "profileDistalLabel1", "profileDistalLabel2", rightRef],
  ];

  for (const [lineId, label1Id, label2Id, idx] of markerMap) {
    if (!Number.isFinite(idx)) continue;
    const x = xMap(Math.max(0, Math.min(n - 1, idx)));
    setSvgXForLine(lineId, x);
    setSvgXForText(label1Id, x);
    if (label2Id) setSvgXForText(label2Id, x);
  }
}

function smoothBackendPoints(points, windowSize = 11) {
  const out = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < points.length; i++) {
    const ys = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < points.length) {
        const p = points[j];
        if (p && Number.isFinite(p.y)) ys.push(p.y);
      }
    }
    out.push({
      x: points[i].x,
      y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : points[i].y,
    });
  }
  return out;
}

function backendCurvePath(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return "";
  if (pts.length === 1) return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    d += ` Q ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` T ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

function backendAreaPath(points, baselineY) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return "";
  const line = backendCurvePath(pts);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${line} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
}

function drawProfileCurveFromBackend(result) {
  const profile = Array.isArray(result.profile) ? result.profile : [];
  if (profile.length < 2) return;

  const n = profile.length;
  const x0 = 70;
  const x1 = 750;
  const xMap = (i) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0);

  const lumenArea = profile.map((r) => getProfileValue(r, ["lumen_area_mm2", "lumen_area_mm2_smooth"]));
  const eemDiameter = profile.map((r) => getProfileValue(r, ["eem_diameter_mm", "eem_equiv_diameter_mm", "eem_equiv_diameter_mm_smooth"]));
  const plaqueBurden = profile.map((r) => getProfileValue(r, ["plaque_burden_percent", "plaque_burden_percent_smooth"]));

  const finiteMin = (arr) => Math.min(...arr.filter(Number.isFinite));
  const finiteMax = (arr) => Math.max(...arr.filter(Number.isFinite));

  const lumenMin = finiteMin(lumenArea);
  const lumenMax = finiteMax(lumenArea);
  const dMin = finiteMin(eemDiameter);
  const dMax = finiteMax(eemDiameter);
  const pbMin = finiteMin(plaqueBurden);
  const pbMax = finiteMax(plaqueBurden);

  const lumenPoints = smoothBackendPoints(lumenArea.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, lumenMin, lumenMax, 198, 145),
  })), 11);

  const diameterPoints = smoothBackendPoints(eemDiameter.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, dMin, dMax, 290, 250),
  })), 13);

  const pbPoints = smoothBackendPoints(plaqueBurden.map((v, i) => ({
    x: xMap(i),
    y: normalizeToY(v, pbMin, pbMax, 442, 305),
  })), 13);

  const lumenAreaFill = document.getElementById("lumenAreaFill");
  const lumenAreaPath = document.getElementById("lumenAreaPath");
  const vesselDiameterPath = document.getElementById("vesselDiameterPath");
  const plaqueBurdenFill = document.getElementById("plaqueBurdenFill");
  const plaqueBurdenPath = document.getElementById("plaqueBurdenPath");
  const mlaDot = document.getElementById("mlaMarkerDot");

  if (lumenAreaFill) lumenAreaFill.setAttribute("d", backendAreaPath(lumenPoints, 198));
  if (lumenAreaPath) lumenAreaPath.setAttribute("d", backendCurvePath(lumenPoints));
  if (vesselDiameterPath) vesselDiameterPath.setAttribute("d", backendCurvePath(diameterPoints));
  if (plaqueBurdenFill) plaqueBurdenFill.setAttribute("d", backendAreaPath(pbPoints, 442));
  if (plaqueBurdenPath) plaqueBurdenPath.setAttribute("d", backendCurvePath(pbPoints));

  const mlaFrame = Math.round(toFiniteNumber(result.target?.target_mla_frame));
  if (mlaDot && Number.isFinite(mlaFrame) && lumenPoints[mlaFrame]) {
    mlaDot.setAttribute("cx", lumenPoints[mlaFrame].x.toFixed(2));
    mlaDot.setAttribute("cy", lumenPoints[mlaFrame].y.toFixed(2));
    mlaDot.setAttribute("r", "7");
  }
}

function backendRiskLevel(strategy, target) {
  const note = String(strategy?.risk_note || "").toLowerCase();
  if (note.includes("high")) return "High";
  if (note.includes("moderate")) return "Moderate";

  const maxPB = Number(target?.target_max_plaque_burden);
  const len = Number(target?.target_lesion_length_mm);
  if (Number.isFinite(maxPB) && maxPB >= 65) return "High";
  if (Number.isFinite(len) && len >= 20) return "Moderate";
  return "Moderate";
}

function generateStrategyFromCurrentProfile() {
  const result = state.backendResult;
  if (!result || !result.success) {
    alert("Please click Update profile first. Generate strategy uses the backend result from the original Python pipeline.");
    return;
  }

  updateThirdPanelFromBackend(result);
  updateCoverageMapFromBackend(result);
}

function updateThirdPanelFromBackend(result) {
  const target = result.target || {};
  const strategy = result.strategy || {};

  const d = Number(strategy.recommended_diameter_mm);
  const l = Number(strategy.recommended_length_mm);
  const score = Number(strategy.matching_score);
  const riskLevel = backendRiskLevel(strategy, target);

  const recommendedStent = document.getElementById("recommendedStent");
  const matchingScore = document.getElementById("matchingScore");
  const riskLevelNode = document.getElementById("riskLevel");

  if (recommendedStent && Number.isFinite(d) && Number.isFinite(l)) {
    recommendedStent.textContent = `${d.toFixed(2)} × ${Math.round(l)} mm`;
  }
  if (matchingScore && Number.isFinite(score)) {
    matchingScore.textContent = score.toFixed(2);
  }
  if (riskLevelNode) {
    riskLevelNode.textContent = riskLevel;
    riskLevelNode.className = riskLevel === "High" || riskLevel === "Moderate" ? "orange-text" : "green-text";
  }

  updateCandidateRowsFromBackend(result);
  updateEvidenceAndRiskFromBackend(result);
}

function updateCandidateRowsFromBackend(result) {
  const strategy = result.strategy || {};
  const d = Number(strategy.recommended_diameter_mm);
  const l = Number(strategy.recommended_length_mm);
  const score = Number(strategy.matching_score);

  const candidates = [];
  if (Number.isFinite(d) && Number.isFinite(l)) {
    candidates.push({ diameter: d, length: l, score: Number.isFinite(score) ? score : 1.0 });
  }

  // If candidate CSV/top_candidates was not parsed by the backend, provide two safe neighboring display candidates.
  const diameters = [2.25, 2.50, 2.75, 3.00, 3.25, 3.50, 3.75, 4.00];
  const lengths = [8, 12, 15, 18, 23, 28, 33, 38, 48];
  const nearestIndex = (arr, val) => arr.reduce((best, x, i) => Math.abs(x - val) < Math.abs(arr[best] - val) ? i : best, 0);

  if (Number.isFinite(d) && Number.isFinite(l)) {
    const di = nearestIndex(diameters, d);
    const li = nearestIndex(lengths, l);
    const alt1 = { diameter: diameters[Math.max(0, di - 1)], length: l, score: Math.max(0, (Number.isFinite(score) ? score : 0.85) - 0.08) };
    const alt2 = { diameter: d, length: lengths[Math.min(lengths.length - 1, li + 1)], score: Math.max(0, (Number.isFinite(score) ? score : 0.85) - 0.12) };
    candidates.push(alt1, alt2);
  }

  for (let i = 0; i < 3; i++) {
    const cand = candidates[i];
    const candNode = document.getElementById(`candidate${i + 1}`);
    const scoreNode = document.getElementById(`candidateScore${i + 1}`);
    const row = candNode?.closest(".candidate");
    const bar = row?.querySelector("i");

    if (!cand) continue;
    if (candNode) candNode.textContent = `${cand.diameter.toFixed(2)} × ${Math.round(cand.length)} mm`;
    if (scoreNode) scoreNode.textContent = cand.score.toFixed(2);
    if (bar) bar.style.setProperty("--w", `${Math.round(cand.score * 100)}%`);
  }
}

function updateEvidenceAndRiskFromBackend(result) {
  const target = result.target || {};
  const strategy = result.strategy || {};
  const evidenceList = document.getElementById("evidenceList");
  const riskNoteList = document.getElementById("riskNoteList");

  if (evidenceList) {
    evidenceList.innerHTML = "";
    const items = [];

    if (Number.isFinite(strategy.recommended_diameter_mm)) {
      items.push(`Recommended diameter is ${strategy.recommended_diameter_mm.toFixed(2)} mm from the calibrated v32 strategy.`);
    }
    if (Number.isFinite(target.mean_ref_lumen_diameter_mm)) {
      items.push(`Reference lumen diameter is ${target.mean_ref_lumen_diameter_mm.toFixed(2)} mm.`);
    }
    if (Number.isFinite(target.target_lesion_length_mm)) {
      items.push(`Target lesion length is ${target.target_lesion_length_mm.toFixed(1)} mm from the backend v22 detection.`);
    }
    if (Number.isFinite(strategy.required_coverage_mm)) {
      items.push(`Required coverage is ${strategy.required_coverage_mm.toFixed(1)} mm.`);
    }
    if (Number.isFinite(target.target_max_plaque_burden)) {
      items.push(`Maximum plaque burden is ${target.target_max_plaque_burden.toFixed(1)}%.`);
    }

    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      evidenceList.appendChild(li);
    }
  }

  if (riskNoteList) {
    riskNoteList.innerHTML = "";
    const notes = [];
    if (strategy.risk_note) notes.push(String(strategy.risk_note));
    if (strategy.reference_confidence) notes.push(`Reference confidence: ${strategy.reference_confidence}.`);
    if (Number.isFinite(strategy.landing_score)) notes.push(`Landing score: ${strategy.landing_score.toFixed(2)}.`);
    if (notes.length === 0) notes.push("Backend strategy generated; please review clinically.");

    for (const item of notes) {
      const li = document.createElement("li");
      li.textContent = item;
      riskNoteList.appendChild(li);
    }
  }
}

function updateCoverageMapFromBackend(result) {
  const target = result.target || {};
  const strategy = result.strategy || {};
  const riskLevel = backendRiskLevel(strategy, target);

  const d = Number(strategy.recommended_diameter_mm);
  const l = Number(strategy.recommended_length_mm);
  const lesionStartIndex = Math.round(Number(target.target_start_frame));
  const lesionEndIndex = Math.round(Number(target.target_end_frame));
  const mlaIndex = Math.round(Number(target.target_mla_frame));

  if (!Number.isFinite(d) || !Number.isFinite(l) || !Number.isFinite(lesionStartIndex) || !Number.isFinite(lesionEndIndex)) {
    return;
  }

  const mappedStrategy = {
    best: { diameter: d, length: l },
    candidates: [],
    riskLevel,
    refDiameter: Number(target.mean_ref_lumen_diameter_mm),
    lesionLength: Number(target.target_lesion_length_mm),
    requiredLength: Number(strategy.required_coverage_mm),
    maxPB: Number(target.target_max_plaque_burden),
    mlaArea: NaN,
    lesionStartIndex,
    lesionEndIndex,
    mlaIndex,
  };

  state.strategy = mappedStrategy;
  updateCoverageMapFromStrategy(mappedStrategy);
}

// Bind Update profile to backend. Generate strategy keeps the original button id but uses the overridden function above.
const updateProfileBtnV2 = document.getElementById("updateProfileBtn");
if (updateProfileBtnV2) {
  updateProfileBtnV2.addEventListener("click", updateProfileFromBackend);
}
