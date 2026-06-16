"""BBox Captioner — FastAPI backend.

A small local web tool for drawing & captioning bounding boxes on
illustrations to build a dataset. Scans a source directory of images,
lets a worker draw/caption boxes, then writes per-image output folders
(original copy + bbox JSON + cropped PNGs) and tracks progress in a
cache file under the output directory.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
APP_SETTINGS_FILE = BASE_DIR / "app_settings.json"  # remembers last-used dirs
CACHE_NAME = ".bbox_cache.json"                     # lives in the output dir

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

app = FastAPI(title="BBox Captioner")

# ---------------------------------------------------------------------------
# In-memory session state (single local user)
# ---------------------------------------------------------------------------
STATE: dict = {"source_dir": None, "output_dir": None}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _natural_key(s: str):
    """Sort helper so 002.png < 010.png regardless of zero padding."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_source_images(source: Path) -> list[str]:
    if not source.is_dir():
        raise HTTPException(400, f"Source directory not found: {source}")
    names = [
        p.name
        for p in source.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ]
    return sorted(names, key=_natural_key)


def cache_path(output: Path) -> Path:
    return output / CACHE_NAME


def load_cache(output: Path) -> dict:
    cp = cache_path(output)
    if cp.exists():
        try:
            return json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": 1, "processed": {}}


def save_cache(output: Path, cache: dict) -> None:
    cache_path(output).write_text(
        json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def load_app_settings() -> dict:
    if APP_SETTINGS_FILE.exists():
        try:
            return json.loads(APP_SETTINGS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_app_settings(data: dict) -> None:
    try:
        APP_SETTINGS_FILE.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def require_dirs() -> tuple[Path, Path]:
    if not STATE["source_dir"] or not STATE["output_dir"]:
        raise HTTPException(400, "Source and output directories are not set.")
    return Path(STATE["source_dir"]), Path(STATE["output_dir"])


def build_image_list(source: Path, output: Path) -> dict:
    cache = load_cache(output)
    processed = cache.get("processed", {})
    names = list_source_images(source)
    images = [
        {
            "name": n,
            "processed": n in processed,
            "num_boxes": processed.get(n, {}).get("num_boxes", 0),
        }
        for n in names
    ]
    done = sum(1 for i in images if i["processed"])
    return {
        "source_dir": str(source),
        "output_dir": str(output),
        "images": images,
        "total": len(images),
        "done": done,
    }


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------
class OpenRequest(BaseModel):
    source_dir: str
    output_dir: str


class Box(BaseModel):
    index: int
    name: str
    bbox: list[int]  # [xmin, ymin, xmax, ymax] in original-image pixels


class SaveRequest(BaseModel):
    name: str
    boxes: list[Box]


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
# Tiny script run in a separate process so the native Tk dialog never touches
# the server's asyncio event loop / non-main thread.
_BROWSE_SCRIPT = (
    "import tkinter as tk;"
    "from tkinter import filedialog;"
    "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
    "p=filedialog.askdirectory(title='Select folder');"
    "print(p if p else '')"
)


@app.get("/api/browse")
def browse_folder():
    """Open a native OS folder-picker on the machine running the server.

    This is a local single-user tool, so the server host *is* the user's
    machine. Uses Python's stdlib tkinter (no extra dependency).
    """
    try:
        out = subprocess.run(
            [sys.executable, "-c", _BROWSE_SCRIPT],
            capture_output=True, text=True, timeout=300,
        )
        path = out.stdout.strip().splitlines()[-1].strip() if out.stdout.strip() else ""
        return {"path": path}
    except Exception as e:  # tkinter missing, headless, cancelled, etc.
        raise HTTPException(500, f"Folder picker unavailable: {e}")


@app.get("/api/state")
def get_state():
    settings = load_app_settings()
    return {
        "source_dir": STATE["source_dir"] or settings.get("source_dir", ""),
        "output_dir": STATE["output_dir"] or settings.get("output_dir", ""),
    }


@app.post("/api/open")
def open_dirs(req: OpenRequest):
    source = Path(req.source_dir.strip()).expanduser()
    output = Path(req.output_dir.strip()).expanduser()

    if not source.is_dir():
        raise HTTPException(400, f"Source directory not found: {source}")
    output.mkdir(parents=True, exist_ok=True)

    # Create the cache file if this is a fresh output directory.
    if not cache_path(output).exists():
        save_cache(output, {"version": 1, "processed": {}})

    STATE["source_dir"] = str(source)
    STATE["output_dir"] = str(output)
    save_app_settings({"source_dir": str(source), "output_dir": str(output)})

    return build_image_list(source, output)


@app.get("/api/images")
def get_images():
    source, output = require_dirs()
    return build_image_list(source, output)


@app.get("/api/image")
def get_image(name: str):
    source, _ = require_dirs()
    path = (source / name).resolve()
    if source.resolve() not in path.parents or not path.is_file():
        raise HTTPException(404, "Image not found.")
    return FileResponse(path)


@app.get("/api/result")
def get_result(name: str):
    """Load previously saved boxes for an already-processed image."""
    _, output = require_dirs()
    stem = Path(name).stem
    json_path = output / stem / f"{stem}-bbox.json"
    if not json_path.exists():
        return {"name": name, "boxes": []}
    try:
        boxes = json.loads(json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        boxes = []
    return {"name": name, "boxes": boxes}


@app.post("/api/save")
def save_boxes(req: SaveRequest):
    source, output = require_dirs()
    src_path = (source / req.name).resolve()
    if source.resolve() not in src_path.parents or not src_path.is_file():
        raise HTTPException(404, "Source image not found.")

    stem = Path(req.name).stem
    folder = output / stem
    folder.mkdir(parents=True, exist_ok=True)

    # 1) Copy the original image into the per-image folder.
    shutil.copy2(src_path, folder / req.name)

    # 2) Re-number boxes by order and crop each one.
    with Image.open(src_path) as img:
        img = img.convert("RGBA") if img.mode == "P" else img.copy()
        w, h = img.size
        out_boxes = []
        # Remove stale crops from a previous save of this image.
        for old in folder.glob(f"{stem}-crop-*.png"):
            old.unlink(missing_ok=True)

        for i, box in enumerate(req.boxes, start=1):
            x1, y1, x2, y2 = box.bbox
            x1, x2 = sorted((max(0, min(x1, w)), max(0, min(x2, w))))
            y1, y2 = sorted((max(0, min(y1, h)), max(0, min(y2, h))))
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            crop_name = f"{stem}-crop-{i:02d}.png"
            img.crop((x1, y1, x2, y2)).save(folder / crop_name)
            out_boxes.append(
                {"index": i, "name": box.name, "bbox": [x1, y1, x2, y2]}
            )

    # 3) Write the bbox JSON.
    (folder / f"{stem}-bbox.json").write_text(
        json.dumps(out_boxes, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # 4) Update the cache.
    cache = load_cache(output)
    cache.setdefault("processed", {})[req.name] = {
        "num_boxes": len(out_boxes),
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    save_cache(output, cache)

    return build_image_list(source, output)


# ---------------------------------------------------------------------------
# Frontend (served by the same app)
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def index():
    return (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
