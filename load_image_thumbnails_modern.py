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

VERSION = "1.0.2"
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


def _media_roots() -> List[Dict[str, str]]:
    """Browse roots: ComfyUI input, output, and an extra "输入" source folder.

    The extra root (/tmp/code/input) is a plain media folder the user keeps
    source images in; images there are browse-only (cut/paste them into the
    ComfyUI input root to use them in a node).
    """
    roots = [{"id": "input", "label": "input", "dir": str(_input_root())}]
    try:
        out_dir = Path(folder_paths.get_output_directory()).resolve()
    except Exception:
        out_dir = None
    if out_dir is not None and out_dir.is_dir() and out_dir != _input_root():
        roots.append({"id": "output", "label": "output", "dir": str(out_dir)})

    code_dir = Path("/tmp/code/input")
    try:
        if not code_dir.is_dir() and os.name == "posix":
            code_dir.mkdir(parents=True, exist_ok=True)
        if code_dir.is_dir():
            resolved = code_dir.resolve()
            if resolved != _input_root() and (out_dir is None or resolved != out_dir):
                roots.append({"id": "code_input", "label": "输入", "dir": str(resolved)})
    except Exception:
        pass
    return roots


def _root_dir(root_id: str) -> Path:
    for root in _media_roots():
        if root["id"] == root_id:
            return Path(root["dir"])
    raise ValueError(f"Unknown media root: {root_id}")


def _scan_input_tree(force: bool = False) -> Dict[str, object]:
    roots = _media_roots()
    stamp_parts = []
    for root in roots:
        try:
            stamp_parts.append((root["id"], Path(root["dir"]).stat().st_mtime_ns))
        except FileNotFoundError:
            stamp_parts.append((root["id"], 0))
        except OSError:
            stamp_parts.append((root["id"], -1))
    stamp = tuple(stamp_parts)

    if not force and _CACHE["stamp"] == stamp and _CACHE["listing"] is not None:
        return _CACHE["listing"]  # type: ignore[return-value]

    images: List[Dict[str, object]] = []
    folders: Dict[Tuple[str, str], int] = {}

    for root in roots:
        root_id = root["id"]
        base = Path(root["dir"])
        folders[(root_id, ".")] = 0
        try:
            files = sorted(base.rglob("*"), key=lambda p: str(p).lower())
        except OSError:
            continue
        for file_path in files:
            if not _is_supported_media(file_path):
                continue
            try:
                rel = file_path.relative_to(base).as_posix()
                parent = file_path.parent.relative_to(base).as_posix() if file_path.parent != base else "."
                stat = file_path.stat()
            except (OSError, ValueError):
                continue
            mime = mimetypes.guess_type(file_path.name)[0] or ("video/*" if file_path.suffix.lower() in VIDEO_EXTENSIONS else "image/*")
            media_type = "video" if file_path.suffix.lower() in VIDEO_EXTENSIONS else "image"
            images.append(
                {
                    "name": file_path.name,
                    "relpath": rel,
                    "folder": parent,
                    "root": root_id,
                    "size": stat.st_size,
                    "mtime_ns": stat.st_mtime_ns,
                    "mime": mime,
                    "media_type": media_type,
                    "selectable": media_type == "image",
                }
            )
            folders[(root_id, parent)] = folders.get((root_id, parent), 0) + 1
            if parent != ".":
                current = Path(parent)
                while current != Path("."):
                    ancestor = current.parent.as_posix() if current.parent.as_posix() != "" else "."
                    folders.setdefault((root_id, ancestor), 0)
                    current = current.parent

    folder_items = []
    root_labels = {root["id"]: root["label"] for root in roots}
    for (root_id, folder) in sorted(folders.keys(), key=lambda item: (item[0] != "input", item[0], item[1] != ".", item[1].lower())):
        folder_items.append(
            {
                "path": folder,
                "root": root_id,
                "label": root_labels.get(root_id, root_id) if folder == "." else folder,
                "count": sum(1 for item in images if item["root"] == root_id and item["folder"] == folder),
            }
        )

    listing = {
        "version": VERSION,
        "root": _input_root().as_posix(),
        "roots": [{"id": root["id"], "label": root["label"]} for root in roots],
        "folders": folder_items,
        "images": images,
    }
    _CACHE["stamp"] = stamp
    _CACHE["listing"] = listing
    return listing


def _list_choices() -> List[str]:
    listing = _scan_input_tree()
    values = [item["relpath"] for item in listing["images"] if item.get("root", "input") == "input"]
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


@PromptServer.instance.routes.get("/thumbnails-modern/media")
async def thumbnails_modern_media(request):
    root_id = (request.rel_url.query.get("root", "input") or "input").lower()
    relpath = request.rel_url.query.get("relpath", "")
    try:
        base = _root_dir(root_id)
        rel = _safe_rel_path(relpath)
        target = (base / rel).resolve()
        if base != target and base not in target.parents:
            raise ValueError("Resolved path escapes the media root")
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    if not target.exists() or not target.is_file():
        return web.json_response({"ok": False, "error": "File not found"}, status=404)
    return web.FileResponse(target)


@PromptServer.instance.routes.get("/thumbnails-modern/folder_path")
async def thumbnails_modern_folder_path(request):
    """Absolute path of the folder selected in the sidebar (for the Copy path button)."""
    root_id = (request.rel_url.query.get("root", "input") or "input").lower()
    folder = request.rel_url.query.get("folder", "") or ""
    try:
        base = _root_dir(root_id)
        rel = _safe_rel_path(folder)
        target = (base / rel).resolve()
        if base != target and base not in target.parents:
            raise ValueError("Resolved path escapes the media root")
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    if not target.exists() or not target.is_dir():
        return web.json_response({"ok": False, "error": "Folder not found"}, status=404)
    return web.json_response({"ok": True, "path": str(target)})


@PromptServer.instance.routes.post("/thumbnails-modern/delete")
async def thumbnails_modern_delete(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    root_id = str((payload or {}).get("root", "input") or "input").lower()
    if root_id != "input":
        return web.json_response({"ok": False, "error": "Deleting is only supported in the input root"}, status=400)

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


def _unique_dest(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    index = 1
    while True:
        candidate = dest.with_name(f"{stem}_{index}{suffix}")
        if not candidate.exists():
            return candidate
        index += 1


def _move_files(from_root: str, relpaths, to_root: str, to_folder: str) -> Dict[str, object]:
    """Move files (cut/paste) inside or between the media roots."""
    try:
        src_root = _root_dir(from_root)
        dst_root = _root_dir(to_root)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    folder_rel = "" if str(to_folder or "").strip() in ("", ".") else _safe_rel_path(to_folder)
    dst_dir = dst_root if not folder_rel else (dst_root / folder_rel).resolve()
    if dst_dir != dst_root and dst_root not in dst_dir.parents:
        return {"ok": False, "error": "Target folder is outside the media root"}
    if not dst_dir.is_dir():
        return {"ok": False, "error": "Target folder not found"}

    moved: List[Dict[str, str]] = []
    failed: List[str] = []
    for relpath in relpaths or []:
        try:
            rel = _safe_rel_path(relpath)
            if not rel:
                raise ValueError("Empty source path")
            src = (src_root / rel).resolve()
            if src_root != src and src_root not in src.parents:
                raise ValueError("Source is outside the media root")
            if not src.is_file():
                raise ValueError("Source is not a file")
            dest = _unique_dest(dst_dir / src.name)
            shutil.move(str(src), str(dest))
            moved.append({"from": rel, "to": dest.relative_to(dst_root).as_posix()})
        except Exception as exc:
            failed.append(f"{relpath}: {exc}")

    if moved:
        _scan_input_tree(force=True)
    return {"ok": True, "moved": moved, "failed": failed}


@PromptServer.instance.routes.post("/thumbnails-modern/move")
async def thumbnails_modern_move(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    payload = payload or {}
    result = _move_files(
        str(payload.get("from_root", "input") or "input").lower(),
        payload.get("relpaths") or [],
        str(payload.get("to_root", "input") or "input").lower(),
        payload.get("to_folder", "") or "",
    )
    return web.json_response(result, status=200 if result.get("ok") else 400)


def _delete_folder_tree(relpath: str, root_id: str = "input") -> Dict[str, object]:
    """Delete a folder (recursively) that lives inside one of the media roots."""
    name, _ = _split_annotation(relpath)
    try:
        rel = _safe_rel_path(name)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if not rel:
        return {"ok": False, "error": "Refusing to delete the media root"}

    try:
        root = _root_dir(root_id)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    target = (root / rel).resolve()
    if target == root or root not in target.parents:
        return {"ok": False, "error": "Folder is outside the media root"}
    if not target.exists():
        return {"ok": False, "error": "Folder not found"}
    if target.is_symlink() or not target.is_dir():
        return {"ok": False, "error": "Not a folder"}

    try:
        files = sum(1 for path in target.rglob("*") if path.is_file())
        shutil.rmtree(target)
        _scan_input_tree(force=True)
        return {"ok": True, "deleted": rel, "root": root_id, "files": files}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@PromptServer.instance.routes.post("/thumbnails-modern/delete_folder")
async def thumbnails_modern_delete_folder(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    payload = payload or {}
    root_id = str(payload.get("root", "input") or "input").lower()
    result = _delete_folder_tree(payload.get("relpath", ""), root_id)
    status = 200
    if not result.get("ok"):
        status = 404 if result.get("error") == "Folder not found" else 400
    return web.json_response(result, status=status)
