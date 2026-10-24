import hashlib
import mimetypes
import os
import re
import shutil
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageFile, ImageOps, ImageSequence, UnidentifiedImageError

import folder_paths
from server import PromptServer
import nodes

VERSION = "1.0.1"
ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".jxl", ".apng", ".ico"
}
VIDEO_EXTENSIONS = {
    ".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"
}
EXCLUDED_ANIMATED_CONCAT_FORMATS = {"MPO"}
_CACHE: Dict[str, object] = {"stamp": None, "listing": None}


def _input_root() -> Path:
    return Path(folder_paths.get_input_directory()).resolve()


def _safe_rel_path(value: str) -> str:
    value = str(value or "").replace("\\", "/").lstrip("/")
    parts = [p for p in value.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError("Parent path traversal is not allowed")
    return "/".join(parts)


# ComfyUI stores edited images as "<file> [input]" / "[output]" / "[temp]"
# (see folder_paths.annotated_filepath / get_annotated_filepath). The mask
# editor and the painter both write that suffix into the widget value, so the
# backend must resolve it exactly like the native LoadImage node does.
ANNOTATED_SUFFIX_RE = re.compile(r"\s*\[(input|output|temp)\]\s*$", re.IGNORECASE)


def _split_annotation(value: str) -> Tuple[str, str]:
    raw = str(value or "")
    match = ANNOTATED_SUFFIX_RE.search(raw)
    if not match:
        return raw, None
    return raw[: match.start()], match.group(1).lower()


def _annotation_base_dir(kind: str) -> Path:
    if kind == "output":
        return Path(folder_paths.get_output_directory()).resolve()
    if kind == "temp":
        return Path(folder_paths.get_temp_directory()).resolve()
    return _input_root()


def _resolve_input_file(value: str) -> Path:
    name, annotation = _split_annotation(value)
    if annotation:
        base = _annotation_base_dir(annotation)
        parts = [p for p in str(name or "").replace("\\", "/").lstrip("/").split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise ValueError("Parent path traversal is not allowed")
        candidate = (base / "/".join(parts)).resolve()
        if base != candidate and base not in candidate.parents:
            raise ValueError("Resolved path escapes the allowed directory")
        return candidate
    rel = _safe_rel_path(name)
    candidate = (_input_root() / rel).resolve()
    root = _input_root()
    if root != candidate and root not in candidate.parents:
        raise ValueError("Resolved path escapes ComfyUI input directory")
    return candidate


def _is_supported_media(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in (ALLOWED_EXTENSIONS | VIDEO_EXTENSIONS)


def _scan_input_tree(force: bool = False) -> Dict[str, object]:
    root = _input_root()
    try:
        stamp = root.stat().st_mtime_ns
    except FileNotFoundError:
        stamp = time.time_ns()

    if not force and _CACHE["stamp"] == stamp and _CACHE["listing"] is not None:
        return _CACHE["listing"]  # type: ignore[return-value]

    images: List[Dict[str, object]] = []
    folders: Dict[str, int] = {".": 0}

    for file_path in sorted(root.rglob("*"), key=lambda p: str(p).lower()):
        if not _is_supported_media(file_path):
            continue
        rel = file_path.relative_to(root).as_posix()
        parent = file_path.parent.relative_to(root).as_posix() if file_path.parent != root else "."
        stat = file_path.stat()
        mime = mimetypes.guess_type(file_path.name)[0] or ("video/*" if file_path.suffix.lower() in VIDEO_EXTENSIONS else "image/*")
        media_type = "video" if file_path.suffix.lower() in VIDEO_EXTENSIONS else "image"
        images.append(
            {
                "name": file_path.name,
                "relpath": rel,
                "folder": parent,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "mime": mime,
                "media_type": media_type,
                "selectable": media_type == "image",
            }
        )
        folders[parent] = folders.get(parent, 0) + 1
        if parent != ".":
            current = Path(parent)
            while current != Path("."):
                ancestor = current.parent.as_posix() if current.parent.as_posix() != "" else "."
                folders.setdefault(ancestor, 0)
                current = current.parent

    folder_items = []
    for folder in sorted(folders.keys(), key=lambda x: (x != ".", x.lower())):
        folder_items.append(
            {
                "path": folder,
                "label": "input" if folder == "." else folder,
                "count": sum(1 for item in images if item["folder"] == folder),
            }
        )

    listing = {"version": VERSION, "root": root.as_posix(), "folders": folder_items, "images": images}
    _CACHE["stamp"] = stamp
    _CACHE["listing"] = listing
    return listing


def _list_choices() -> List[str]:
    listing = _scan_input_tree()
    values = [item["relpath"] for item in listing["images"]]
    return values or [""]


def _pillow_open(fn, arg):
    previous = None
    try:
        return fn(arg)
    except (OSError, UnidentifiedImageError, ValueError):
        previous = ImageFile.LOAD_TRUNCATED_IMAGES
        ImageFile.LOAD_TRUNCATED_IMAGES = True
        return fn(arg)
    finally:
        if previous is not None:
            ImageFile.LOAD_TRUNCATED_IMAGES = previous


def _load_image_tensor(image_path: Path) -> Tuple[torch.Tensor, torch.Tensor]:
    img = _pillow_open(Image.open, image_path)
    output_images = []
    output_masks = []
    width, height = None, None

    for frame in ImageSequence.Iterator(img):
        frame = _pillow_open(ImageOps.exif_transpose, frame)
        if frame.mode == "I":
            frame = frame.point(lambda i: i * (1 / 255))

        rgb = frame.convert("RGB")
        if not output_images:
            width, height = rgb.size
        if rgb.size != (width, height):
            continue

        image_np = np.array(rgb).astype(np.float32) / 255.0
        image_t = torch.from_numpy(image_np)[None,]

        if "A" in frame.getbands():
            mask = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
            mask_t = 1.0 - torch.from_numpy(mask)
        else:
            mask_t = torch.zeros((height or 64, width or 64), dtype=torch.float32, device="cpu")

        output_images.append(image_t)
        output_masks.append(mask_t.unsqueeze(0))

    if len(output_images) > 1 and getattr(img, "format", None) not in EXCLUDED_ANIMATED_CONCAT_FORMATS:
        return torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0)
    return output_images[0], output_masks[0]


class LoadImageMediaBrowser:
    CATEGORY = "image"
    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    DESCRIPTION = "Load image with the Load Image Media Browser for ComfyUI input files."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (_list_choices(), {"image_upload": True}),
            }
        }

    def load_image(self, image):
        image_path = _resolve_input_file(image)
        if not image_path.exists() or not image_path.is_file():
            raise FileNotFoundError(f"Input image not found: {image}")
        return _load_image_tensor(image_path)

    @classmethod
    def IS_CHANGED(cls, image):
        path = _resolve_input_file(image)
        stat = path.stat()
        fingerprint = f"{path.as_posix()}::{stat.st_size}::{stat.st_mtime_ns}"
        return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        try:
            path = _resolve_input_file(image)
        except Exception as exc:
            return str(exc)
        if not path.exists() or not path.is_file():
            return f"Invalid image file: {image}"
        if path.suffix.lower() not in ALLOWED_EXTENSIONS:
            return f"Unsupported image type: {path.suffix}"
        return True


NODE_CLASS_MAPPINGS = {
    "LoadImage": LoadImageMediaBrowser,
    "LoadImageThumbnailsModern": LoadImageMediaBrowser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadImage": "Load Image",
    "LoadImageMediaBrowser": "Load Image Media Browser",
}

# Replace the core LoadImage automatically so existing workflows benefit without manual node replacement.
nodes.NODE_CLASS_MAPPINGS["LoadImage"] = LoadImageMediaBrowser
nodes.NODE_DISPLAY_NAME_MAPPINGS["LoadImage"] = "Load Image"


@PromptServer.instance.routes.get("/thumbnails-modern/list")
async def thumbnails_modern_list(request):
    force = request.rel_url.query.get("refresh", "0") == "1"
    return web.json_response(_scan_input_tree(force=force))


@PromptServer.instance.routes.post("/thumbnails-modern/delete")
async def thumbnails_modern_delete(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    relpath = payload.get("relpath", "")
    try:
        target = _resolve_input_file(relpath)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

    if not target.exists() or not target.is_file():
        return web.json_response({"ok": False, "error": "File not found"}, status=404)

    try:
        target.unlink()
        _scan_input_tree(force=True)
        return web.json_response({"ok": True, "deleted": relpath})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


def _delete_folder_tree(relpath: str) -> Dict[str, object]:
    """Delete a folder (recursively) that lives inside the ComfyUI input tree."""
    name, _ = _split_annotation(relpath)
    try:
        rel = _safe_rel_path(name)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if not rel:
        return {"ok": False, "error": "Refusing to delete the input root"}

    root = _input_root()
    target = (root / rel).resolve()
    if target == root or root not in target.parents:
        return {"ok": False, "error": "Folder is outside the input directory"}
    if not target.exists():
        return {"ok": False, "error": "Folder not found"}
    if target.is_symlink() or not target.is_dir():
        return {"ok": False, "error": "Not a folder"}

    try:
        files = sum(1 for path in target.rglob("*") if path.is_file())
        shutil.rmtree(target)
        _scan_input_tree(force=True)
        return {"ok": True, "deleted": rel, "files": files}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@PromptServer.instance.routes.post("/thumbnails-modern/delete_folder")
async def thumbnails_modern_delete_folder(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    result = _delete_folder_tree((payload or {}).get("relpath", ""))
    status = 200
    if not result.get("ok"):
        status = 404 if result.get("error") == "Folder not found" else 400
    return web.json_response(result, status=status)
