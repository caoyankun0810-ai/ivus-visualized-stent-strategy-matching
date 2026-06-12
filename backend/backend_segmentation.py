# backend_segmentation.py
# FastAPI backend for IVUS single-frame ring-mask segmentation.
#
# Your model:
#   0 = background
#   1 = ring-shaped vessel wall region between lumen and EEM
#
# This backend extracts:
#   outer contour of the ring  -> EEM contour, green line
#   inner hole of the ring     -> Lumen contour, blue line
#
# Run:
#   python backend_segmentation.py

import os
import sys
import traceback
from typing import Dict, Any, Tuple

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Additional imports for backend-driven strategy pipeline
from fastapi import Form
import subprocess
import pandas as pd
import math
import re

# =========================================================
# User configuration
# =========================================================

TRANSUNET_ROOT = r"G:\autodl\home\EndoFM-LV\TransUNet"

WEIGHT_PATH = (
    r"G:\autodl\home\EndoFM-LV\TransUNet\model\TU_Synapse224"
    r"\TU_pretrain_motion_kan_datakuochong_R50-ViT-B_16_skip3_epo500_bs1_lr0.0002_224_s2"
    r"\epoch_399.pth"
)

VIT_NAME = "R50-ViT-B_16"
IMG_SIZE = 224
NUM_CLASSES = 2

# 0 = background
# 1 = ring-shaped vessel wall / EEM-lumen region
RING_CLASS_ID = 1

# Overlay SVG viewBox size in index.html
SVG_VIEWBOX_SIZE = 500

# Your model expects 3-channel input.
MODEL_INPUT_CHANNELS = 3

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# =========================================================
# v2 backend-driven strategy pipeline configuration
# =========================================================

# Put the original Python strategy scripts in the same folder as this backend file.
STRATEGY_SCRIPT_ROOT = os.path.dirname(os.path.abspath(__file__))

EXTRACT_SCRIPT = os.path.join(STRATEGY_SCRIPT_ROOT, "extract_ivus_mask_profile.py")
CLEAN_SCRIPT = os.path.join(STRATEGY_SCRIPT_ROOT, "clean_ivus_profile_run.py")
TARGET_SCRIPT = os.path.join(STRATEGY_SCRIPT_ROOT, "detect_target_lesion_v22_run.py")
STRATEGY_SCRIPT = os.path.join(STRATEGY_SCRIPT_ROOT, "generate_stent_strategy_v32_calibrated_run.py")

# These must match the fixed output paths inside your original Python scripts.
MASK_SAVE_ROOT = r"G:\stent_display\stentPredMasks105_motion_kan_stent"
TARGET_SUMMARY_CSV = r"G:\stent_display\stentTargetLesion105_v22\target_lesion_summary_v22.csv"
STRATEGY_SUMMARY_CSV = r"G:\stent_display\stentStrategy105_v32_lumen_calibrated\stent_strategy_summary_v32.csv"
CLEAN_PROFILE_DIR = r"G:\stent_display\stentMaskProfiles105_clean\per_case_clean_csv"


# =========================================================
# FastAPI app
# =========================================================

app = FastAPI(title="IVUS Ring Segmentation Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



# =========================================================
# v2 local mask saving + original strategy pipeline endpoint
# =========================================================
def safe_case_name(name: str) -> str:
    name = str(name).strip()
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    return name if name else "unknown"

def safe_name(name: str) -> str:
    name = str(name).strip()
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    return name if name else "unknown"


def get_saved_mask_path(case_id: str, original_filename: str, frame_index: int = None):
    """
    Prefer original filename. Also keep a fallback for old 0000.png-style masks.
    """
    case_id = safe_name(case_id)
    case_dir = os.path.join(MASK_SAVE_ROOT, case_id)

    stem, _ = os.path.splitext(os.path.basename(original_filename or ""))
    stem = safe_name(stem)

    candidates = []

    if stem and stem != "unknown":
        candidates.append(os.path.join(case_dir, f"{stem}.png"))

    if frame_index is not None:
        candidates.append(os.path.join(case_dir, f"{int(frame_index):04d}.png"))

    for p in candidates:
        if os.path.exists(p):
            return p

    return None

def save_pred_mask_for_strategy(pred_mask, case_id: str, original_filename: str):
    """
    Save predicted ring-shaped mask for the downstream Python pipeline.

    Save path:
        G:\\stent_display\\stentPredMasks105_motion_kan_stent\\<case_id>\\<original_filename_stem>.png
    """
    case_id = safe_name(case_id)

    case_dir = os.path.join(MASK_SAVE_ROOT, case_id)
    os.makedirs(case_dir, exist_ok=True)

    stem, _ = os.path.splitext(os.path.basename(original_filename or "frame"))
    stem = safe_name(stem)

    save_path = os.path.join(case_dir, f"{stem}.png")

    mask = np.asarray(pred_mask)

    # If mask is 0/1, convert to 0/255.
    if mask.max() <= 1:
        mask = mask * 255

    mask = mask.astype(np.uint8)

    ok = cv2.imwrite(save_path, mask)
    if not ok:
        raise RuntimeError(f"Failed to save mask: {save_path}")

    return save_path


def build_segmentation_result_from_mask(mask_path: str, case_id: str, frame_index: int, original_filename: str):
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)

    if mask is None:
        raise RuntimeError(f"Failed to read saved mask: {mask_path}")

    # 统一成 0/1 ring mask
    mask_bin = (mask > 0).astype(np.uint8)

    eem_path, lumen_path, eem_area_px, lumen_area_px = extract_outer_inner_paths_from_ring(
        mask_bin,
        class_id=RING_CLASS_ID,
        viewbox_size=SVG_VIEWBOX_SIZE,
    )

    return {
        "success": True,
        "from_cache": True,
        "case_id": case_id,
        "frame_index": int(frame_index),
        "original_filename": original_filename,
        "mask_save_path": mask_path,
        "mask_shape": list(mask_bin.shape[:2]),
        "eem_path": eem_path,
        "lumen_path": lumen_path,
        "eem_area_px": eem_area_px,
        "lumen_area_px": lumen_area_px,
        "message": "Loaded existing mask from local folder.",
    }


@app.post("/api/load_saved_mask")
async def load_saved_mask(
    case_id: str = Form(...),
    original_filename: str = Form(...),
    frame_index: int = Form(0),
):
    try:
        mask_path = get_saved_mask_path(
            case_id=case_id,
            original_filename=original_filename,
            frame_index=frame_index,
        )

        if mask_path is None:
            return {
                "success": False,
                "from_cache": False,
                "error": "Saved mask not found.",
            }

        return build_segmentation_result_from_mask(
            mask_path=mask_path,
            case_id=case_id,
            frame_index=frame_index,
            original_filename=original_filename,
        )

    except Exception as e:
        traceback.print_exc()
        return {
            "success": False,
            "from_cache": False,
            "error": str(e),
        }


def finite_float(x, default=None):
    try:
        v = float(x)
        if math.isfinite(v):
            return v
        return default
    except Exception:
        return default


def finite_int(x, default=None):
    v = finite_float(x, default=None)
    if v is None:
        return default
    return int(round(v))


def find_case_row(df: pd.DataFrame, case_id: str, csv_name: str) -> dict:
    if "case_id" not in df.columns:
        raise ValueError(f"{csv_name} does not contain a case_id column.")
    rows = df[df["case_id"].astype(str) == str(case_id)]
    if len(rows) == 0:
        available = df["case_id"].astype(str).head(8).tolist()
        raise ValueError(f"case_id not found in {csv_name}: {case_id}. Available examples: {available}")
    return rows.iloc[0].to_dict()


def read_clean_profile(case_id: str):
    clean_csv = os.path.join(CLEAN_PROFILE_DIR, f"{case_id}_clean_profile.csv")
    if not os.path.exists(clean_csv):
        raise ValueError(f"clean profile csv not found: {clean_csv}")

    profile_df = pd.read_csv(clean_csv)
    profile = []

    for _, r in profile_df.iterrows():
        profile.append({
            "frame_index": finite_int(r.get("frame_index", len(profile)), len(profile)),
            "clean_valid": finite_int(r.get("clean_valid", r.get("valid", 0)), 0),
            "lumen_area_mm2": finite_float(r.get("lumen_area_mm2_smooth", r.get("lumen_area_mm2"))),
            "eem_area_mm2": finite_float(r.get("eem_area_mm2_smooth", r.get("eem_area_mm2"))),
            "plaque_burden_percent": finite_float(r.get("plaque_burden_percent_smooth", r.get("plaque_burden_percent"))),
            "lumen_diameter_mm": finite_float(r.get("lumen_equiv_diameter_mm_smooth", r.get("lumen_equiv_diameter_mm"))),
            "eem_diameter_mm": finite_float(r.get("eem_equiv_diameter_mm_smooth", r.get("eem_equiv_diameter_mm"))),
        })

    return profile


def run_python_script(script_path: str, case_id: str = None, timeout_sec: int = 600):
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"script not found: {script_path}")

    script_name = os.path.basename(script_path)
    script_dir = os.path.dirname(script_path)

    env = os.environ.copy()
    if case_id:
        env["IVUS_CASE_ID"] = str(case_id)

    print(f"\n[RUN] {script_name}", flush=True)
    print(f"      case_id: {case_id}", flush=True)
    print(f"      path: {script_path}", flush=True)
    print(f"      cwd : {script_dir}", flush=True)

    proc = subprocess.Popen(
        [sys.executable, script_path],
        cwd=script_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    lines = []

    try:
        import time
        start_time = time.time()

        while True:
            line = proc.stdout.readline()

            if line:
                line = line.rstrip()
                lines.append(line)
                print(f"[{script_name}] {line}", flush=True)

            if proc.poll() is not None:
                break

            if time.time() - start_time > timeout_sec:
                proc.kill()
                raise RuntimeError(
                    f"Script timeout after {timeout_sec}s: {script_name}\n"
                    f"Last output:\n" + "\n".join(lines[-80:])
                )

        returncode = proc.wait()

    finally:
        if proc.stdout:
            proc.stdout.close()

    print(f"[DONE] {script_name}, returncode={returncode}", flush=True)

    if returncode != 0:
        raise RuntimeError(
            f"Script failed: {script_name}\n"
            f"Last output:\n" + "\n".join(lines[-120:])
        )

    return "\n".join(lines)


@app.post("/api/run_stent_strategy")
async def run_stent_strategy(case_id: str = Form(...)):
    """Run the original Python pipeline and return one unified result for panels 2-4."""
    try:
        case_id = safe_case_name(case_id)

        run_python_script(EXTRACT_SCRIPT, case_id=case_id)
        run_python_script(CLEAN_SCRIPT, case_id=case_id)
        run_python_script(TARGET_SCRIPT, case_id=case_id)
        run_python_script(STRATEGY_SCRIPT, case_id=case_id)

        if not os.path.exists(TARGET_SUMMARY_CSV):
            raise FileNotFoundError(f"target summary not found: {TARGET_SUMMARY_CSV}")
        if not os.path.exists(STRATEGY_SUMMARY_CSV):
            raise FileNotFoundError(f"strategy summary not found: {STRATEGY_SUMMARY_CSV}")

        target_df = pd.read_csv(TARGET_SUMMARY_CSV)
        strategy_df = pd.read_csv(STRATEGY_SUMMARY_CSV)

        target_row = find_case_row(target_df, case_id, "target summary")
        strategy_row = find_case_row(strategy_df, case_id, "strategy summary")
        profile = read_clean_profile(case_id)

        return {
            "success": True,
            "case_id": case_id,
            "target": {
                "target_mla_frame": finite_int(target_row.get("target_mla_frame", target_row.get("target_MLA_frame"))),
                "target_start_frame": finite_int(target_row.get("target_start_frame")),
                "target_end_frame": finite_int(target_row.get("target_end_frame")),
                "target_lesion_length_mm": finite_float(target_row.get("target_lesion_length_mm")),
                "target_max_plaque_burden": finite_float(target_row.get("target_max_plaque_burden")),
                "target_mean_plaque_burden": finite_float(target_row.get("target_mean_plaque_burden")),
                "primary_pb_length_mm": finite_float(target_row.get("primary_pb_length_mm")),
                "left_reference_frame": finite_int(target_row.get("left_reference_frame")),
                "right_reference_frame": finite_int(target_row.get("right_reference_frame")),
                "mean_ref_lumen_diameter_mm": finite_float(target_row.get("mean_ref_lumen_diameter_mm")),
                "mean_ref_eem_diameter_mm": finite_float(target_row.get("mean_ref_eem_diameter_mm")),
            },
            "strategy": {
                "recommended_strategy": str(strategy_row.get("recommended_strategy", "")),
                "recommended_diameter_mm": finite_float(strategy_row.get("recommended_diameter_mm")),
                "recommended_length_mm": finite_float(strategy_row.get("recommended_length_mm")),
                "matching_score": finite_float(strategy_row.get("matching_score")),
                "required_coverage_mm": finite_float(strategy_row.get("required_coverage_mm")),
                "required_by_target_mm": finite_float(strategy_row.get("required_by_target_mm")),
                "required_by_pb_mm": finite_float(strategy_row.get("required_by_pb_mm")),
                "diameter_score": finite_float(strategy_row.get("diameter_score")),
                "coverage_score": finite_float(strategy_row.get("coverage_score")),
                "landing_score": finite_float(strategy_row.get("landing_score")),
                "risk_score": finite_float(strategy_row.get("risk_score")),
                "risk_note": str(strategy_row.get("risk_note", "")),
                "reference_confidence": str(strategy_row.get("reference_confidence", "")),
                "top_candidates": str(strategy_row.get("top_candidates", "")),
            },
            "profile": profile,
        }

    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# =========================================================
# Model loading
# =========================================================

model = None


def _safe_import_transunet():
    if TRANSUNET_ROOT not in sys.path:
        sys.path.insert(0, TRANSUNET_ROOT)

    from networks.vit_seg_modeling import VisionTransformer as ViT_seg
    from networks.vit_seg_modeling import CONFIGS as CONFIGS_ViT

    return ViT_seg, CONFIGS_ViT


def _clean_state_dict(ckpt: Any) -> Dict[str, torch.Tensor]:
    if isinstance(ckpt, dict):
        for k in ["state_dict", "model", "net", "model_state_dict"]:
            if k in ckpt and isinstance(ckpt[k], dict):
                ckpt = ckpt[k]
                break

    if not isinstance(ckpt, dict):
        raise RuntimeError("Unsupported checkpoint format.")

    new_ckpt = {}
    for k, v in ckpt.items():
        nk = k
        if nk.startswith("module."):
            nk = nk[len("module."):]
        new_ckpt[nk] = v

    return new_ckpt


def load_model():
    global model

    if model is not None:
        return model

    if not os.path.exists(WEIGHT_PATH):
        raise FileNotFoundError(f"Weight file not found: {WEIGHT_PATH}")

    ViT_seg, CONFIGS_ViT = _safe_import_transunet()

    config_vit = CONFIGS_ViT[VIT_NAME]
    config_vit.n_classes = NUM_CLASSES
    config_vit.n_skip = 3

    if "R50" in VIT_NAME:
        config_vit.patches.grid = (int(IMG_SIZE / 16), int(IMG_SIZE / 16))

    net = ViT_seg(config_vit, img_size=IMG_SIZE, num_classes=NUM_CLASSES)

    ckpt = torch.load(WEIGHT_PATH, map_location="cpu")
    state_dict = _clean_state_dict(ckpt)

    missing, unexpected = net.load_state_dict(state_dict, strict=False)

    print("[Model loaded]")
    print(f"  weight: {WEIGHT_PATH}")
    print(f"  device: {DEVICE}")
    print(f"  missing keys: {len(missing)}")
    print(f"  unexpected keys: {len(unexpected)}")
    if missing:
        print("  first missing keys:", missing[:5])
    if unexpected:
        print("  first unexpected keys:", unexpected[:5])

    net.to(DEVICE)
    net.eval()

    model = net
    return model


# =========================================================
# Image preprocessing and inference
# =========================================================

def read_image_from_upload(file_bytes: bytes):
    arr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)

    if img is None:
        raise RuntimeError("Failed to decode image. Please upload png/jpg/bmp/tif image.")

    return img


def preprocess_image(img_gray: np.ndarray):
    h0, w0 = img_gray.shape[:2]

    img_resized = cv2.resize(img_gray, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    img_float = img_resized.astype(np.float32) / 255.0

    if MODEL_INPUT_CHANNELS == 3:
        img_3ch = np.stack([img_float, img_float, img_float], axis=0)  # [3,H,W]
        tensor = torch.from_numpy(img_3ch).unsqueeze(0)                # [1,3,H,W]
    else:
        tensor = torch.from_numpy(img_float).unsqueeze(0).unsqueeze(0) # [1,1,H,W]

    return tensor.float().to(DEVICE), (h0, w0)


@torch.no_grad()
def infer_mask(img_gray: np.ndarray):
    net = load_model()

    x, orig_shape = preprocess_image(img_gray)
    logits = net(x)

    if isinstance(logits, (list, tuple)):
        logits = logits[0]

    if logits.ndim != 4:
        raise RuntimeError(f"Unexpected model output shape: {tuple(logits.shape)}")

    if NUM_CLASSES == 1 or logits.shape[1] == 1:
        prob = torch.sigmoid(logits)[0, 0].detach().cpu().numpy()
        pred = (prob > 0.5).astype(np.uint8)
    else:
        pred = torch.argmax(torch.softmax(logits, dim=1), dim=1)[0].detach().cpu().numpy().astype(np.uint8)

    h0, w0 = orig_shape
    pred_orig = cv2.resize(pred, (w0, h0), interpolation=cv2.INTER_NEAREST)

    return pred_orig


# =========================================================
# Ring contour extraction
# =========================================================

def contour_to_svg_path(contour: np.ndarray, mask_shape: Tuple[int, int], viewbox_size: int = 500):
    """Convert one OpenCV contour to SVG path."""
    if contour is None or len(contour) < 3:
        return ""

    h, w = mask_shape[:2]
    sx = viewbox_size / float(w)
    sy = viewbox_size / float(h)

    epsilon = 0.0025 * cv2.arcLength(contour, True)
    contour = cv2.approxPolyDP(contour, epsilon, True)

    pts = contour.reshape(-1, 2)
    if len(pts) < 3:
        return ""

    commands = []
    x0, y0 = pts[0]
    commands.append(f"M {x0 * sx:.2f} {y0 * sy:.2f}")

    for x, y in pts[1:]:
        commands.append(f"L {x * sx:.2f} {y * sy:.2f}")

    commands.append("Z")
    return " ".join(commands)


def extract_outer_inner_paths_from_ring(mask: np.ndarray, class_id: int = 1, viewbox_size: int = 500):
    """
    For a ring-shaped binary mask:
      - outer boundary corresponds to EEM
      - inner hole boundary corresponds to lumen

    Use RETR_CCOMP to keep parent-child contour hierarchy.
    """
    bin_mask = (mask == class_id).astype(np.uint8)

    # Keep hole structure. Do not fill holes.
    # Only do mild close/open to reduce small isolated fragments.
    kernel = np.ones((3, 3), np.uint8)
    bin_mask = cv2.morphologyEx(bin_mask, cv2.MORPH_OPEN, kernel)
    bin_mask = cv2.morphologyEx(bin_mask, cv2.MORPH_CLOSE, kernel)

    contours, hierarchy = cv2.findContours(bin_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

    if not contours or hierarchy is None:
        return "", "", 0.0, 0.0

    hierarchy = hierarchy[0]

    # Candidate outer contours are contours with parent == -1.
    outer_candidates = []
    for i, c in enumerate(contours):
        parent = hierarchy[i][3]
        area = cv2.contourArea(c)
        if parent == -1 and area > 5:
            outer_candidates.append((i, c, area))

    if not outer_candidates:
        return "", "", 0.0, 0.0

    # Use largest external contour as EEM.
    outer_idx, outer_contour, outer_area = max(outer_candidates, key=lambda x: x[2])

    # Child contours of the selected outer contour are holes.
    inner_candidates = []
    for i, c in enumerate(contours):
        parent = hierarchy[i][3]
        area = cv2.contourArea(c)
        if parent == outer_idx and area > 5:
            inner_candidates.append((i, c, area))

    inner_contour = None
    inner_area = 0.0

    if inner_candidates:
        # Use largest hole as lumen.
        _, inner_contour, inner_area = max(inner_candidates, key=lambda x: x[2])
    else:
        # Fallback: if hierarchy did not preserve hole, estimate lumen from inverse mask
        # inside the outer contour. This handles occasional broken ring masks.
        filled_outer = np.zeros_like(bin_mask)
        cv2.drawContours(filled_outer, [outer_contour], -1, 1, thickness=-1)
        hole_region = ((filled_outer == 1) & (bin_mask == 0)).astype(np.uint8)

        hole_contours, _ = cv2.findContours(hole_region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hole_contours = [c for c in hole_contours if cv2.contourArea(c) > 5]
        if hole_contours:
            inner_contour = max(hole_contours, key=cv2.contourArea)
            inner_area = float(cv2.contourArea(inner_contour))

    eem_path = contour_to_svg_path(outer_contour, mask.shape, viewbox_size)
    lumen_path = contour_to_svg_path(inner_contour, mask.shape, viewbox_size) if inner_contour is not None else ""

    return eem_path, lumen_path, float(outer_area), float(inner_area)


# =========================================================
# API endpoints
# =========================================================

@app.get("/api/health")
def health():
    return {
        "success": True,
        "device": DEVICE,
        "weight_exists": os.path.exists(WEIGHT_PATH),
        "weight_path": WEIGHT_PATH,
        "num_classes": NUM_CLASSES,
        "class_map": {
            "0": "background",
            "1": "ring region between lumen and EEM",
        },
        "model_input_channels": MODEL_INPUT_CHANNELS,
    }


@app.post("/api/segment_frame")
async def segment_frame(
    file: UploadFile = File(...),
    case_id: str = Form("unknown_case"),
    frame_index: int = Form(0),
    original_filename: str = Form(""),
):
    try:
        file_bytes = await file.read()
        img_gray = read_image_from_upload(file_bytes)

        pred_mask = infer_mask(img_gray)

        mask_save_path = save_pred_mask_for_strategy(
            pred_mask=pred_mask,
            case_id=case_id,
            original_filename=original_filename or file.filename,
        )

        eem_path, lumen_path, eem_area, lumen_area = extract_outer_inner_paths_from_ring(
            pred_mask,
            class_id=RING_CLASS_ID,
            viewbox_size=SVG_VIEWBOX_SIZE,
        )

        return {
            "success": True,
            "frame_name": file.filename,
            "case_id": case_id,
            "frame_index": int(frame_index),
            "original_filename": original_filename or file.filename,
            "mask_save_path": mask_save_path,
            "eem_path": eem_path,
            "lumen_path": lumen_path,
            "eem_area_px": eem_area,
            "lumen_area_px": lumen_area,
            "message": "Ring segmentation completed and mask saved.",
        }

    except Exception as e:
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
        }

if __name__ == "__main__":
    try:
        load_model()
    except Exception:
        traceback.print_exc()
        print("[Warning] Model failed to load at startup. The API will try again during request.")

    uvicorn.run(app, host="127.0.0.1", port=8001)
