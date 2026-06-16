# BBox Captioner

A lightweight local web tool for **drawing and captioning bounding boxes on
illustrations** to build an object/element dataset. A worker opens a folder of
images, draws rectangles, names each one, and the app saves the bbox data plus
cropped image regions — tracking progress so work can be resumed any time.

No build step, no database, no cloud. It's a small **FastAPI** backend that
serves a plain HTML/CSS/JS frontend and does the image cropping with **Pillow**.

---

## Quick start

```bash
git clone <your-repo-url>
cd BreakerHandRecorder
pip install -r requirements.txt
python run.py
```

`run.py` starts the server and opens <http://127.0.0.1:8000> in your browser.

> Using conda? `conda activate <env> && pip install -r requirements.txt && python run.py`

Options: `python run.py --port 9000 --no-browser`

---

## How to use

1. **Top bar** — type/paste the **Source** directory (images to caption) and an
   **Output** directory (where results go), then click **Open**. The output
   directory is created if missing; a `.bbox_cache.json` progress file is created
   inside it (or read if it already exists).
2. **Choose image** — pick any image; a ✓ marks already-processed ones. Opening a
   processed image reloads its saved boxes.
3. **Draw** — drag a rectangle on the image. Click **✓** to keep it (or press
   `Enter`) or **✕** to discard (or press `Esc`). Each kept box appears on the
   right as: `index · name (editable, default "Object") · thumbnail · Redraw / Delete`.
4. **Save** — `Save` writes the current image; `Save & Next` writes it and jumps
   to the next unprocessed image. `Previous` / `Skip` navigate without saving.
   The progress bar shows completion across the whole source folder.

Keyboard: `Enter` confirm box · `Esc` cancel box · `Ctrl/Cmd+S` save.

The **⚙ Settings** menu controls theme (dark/light), box line color, and line width.

---

## Output layout

For a source image `001.png`, after saving the app writes:

```
<output>/
├── .bbox_cache.json          # progress cache (which images are done)
└── 001/
    ├── 001.png               # copy of the original
    ├── 001-bbox.json         # [{"index":1,"name":"Object","bbox":[x1,y1,x2,y2]}, ...]
    ├── 001-crop-01.png       # cropped region for box 1
    └── 001-crop-02.png       # ...
```

Bounding boxes are stored in **original-image pixels** as
`[xmin, ymin, xmax, ymax]`. The image is displayed fit-to-view, and coordinates
are scaled back to full resolution on save, so boxes are always full-res accurate.

---

## Notes

- Supported image types: `.png .jpg .jpeg .webp .bmp .gif .tif .tiff`.
- `app_settings.json` (gitignored) just remembers the last-used directories on
  your machine — safe to delete.
- This is a single-user local tool; it binds to `127.0.0.1` only.
- Re-saving an image overwrites its folder's JSON and crops (stale crops removed).
```
