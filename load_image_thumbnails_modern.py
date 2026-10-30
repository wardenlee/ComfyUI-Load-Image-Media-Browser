import asyncio
import hashlib
import mimetypes
import os
import re
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
MEDIA_EXTENSIONS = ALLOWED_EXTENSIONS | VIDEO_EXTENSIONS

# 扫描缓存：per-directory memo，键为 (root_id, 相对目录)，值为该目录自身的 st_mtime_ns。
# 目录自身的 mtime 会在其直接子项增删改名时变化，因此“往子目录里加文件”也能让缓存失效。
_SCAN: Dict[str, object] = {"dirs": {}, "entries": {}, "listing": None, "stamp": None, "dirty": set()}

# 磁盘缩略图缓存：<temp>/_tm_thumbs/<sha1(root|rel|size|mtime_ns|w)>.<ext>
THUMB_CACHE_DIR_NAME = "_tm_thumbs"
THUMB_DEFAULT_EDGE = 256
THUMB_MIN_EDGE = 64
THUMB_MAX_EDGE = 1024
THUMB_QUALITY = 82
THUMB_CACHE_CONTROL = "public, max-age=0, must-revalidate"
LIST_CACHE_CONTROL = "no-cache"
THUMB_PRUNE_THRESHOLD = 20000
THUMB_PRUNE_EVERY = 128
_THUMB_INFLIGHT: Dict[str, asyncio.Future] = {}
_THUMB_EXT: Dict[str, str] = {}
_THUMB_STATE: Dict[str, int] = {"builds": 0}


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
ANNOTATED_SUFFIX_RE = re.compile(r"\s*\[([A-Za-z0-9_]+)\]\s*$")


def _split_annotation(value: str) -> Tuple[str, str]:
    raw = str(value or "")
    match = ANNOTATED_SUFFIX_RE.search(raw)
    if not match:
        return raw, None
    kind = match.group(1).lower()
    # 只有能解析成真实根目录的后缀才当标注，避免把普通文件名里的 [xxx] 误判
    try:
        _annotation_base_dir(kind)
    except Exception:
        return raw, None
    return raw[: match.start()], kind


def _annotation_base_dir(kind: str) -> Path:
    """Resolve the annotation suffix: input/output/temp or any browse root id."""
    if kind == "output":
        return Path(folder_paths.get_output_directory()).resolve()
    if kind == "temp":
        return Path(folder_paths.get_temp_directory()).resolve()
    return _root_dir(kind)


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


def _resolve_media_path(root_id: str, relpath: str) -> Tuple[Path, str, Path]:
    """共享的路径安全校验：/media、/folder_path、/thumb 用同一套逻辑。"""
    base = _root_dir(root_id)
    rel = _safe_rel_path(relpath)
    target = (base / rel).resolve()
    if base != target and base not in target.parents:
        raise ValueError("Resolved path escapes the media root")
    return base, rel, target


def _invalidate_dir(root_id: str, rel_dir: str = ".") -> None:
    """把某个目录（连同其祖先）标成脏：下一轮扫描必须重新读取它们。

    写入路径（上传/删除/移动）用它代替“立刻整棵重扫”——上传 200 个文件时按目录失效即可，
    最后统一刷一次列表。注意目录自身 mtime 也可能因为同刻写入而没变化，所以必须显式标脏。
    """
    normalized = str(rel_dir or "").replace("\\", "/").strip("/") or "."
    keys: List[Tuple[str, str]] = []
    current = normalized
    while True:
        keys.append((root_id, current))
        if current == ".":
            break
        parent = Path(current).parent.as_posix() or "."
        if parent == current:
            break
        current = parent

    dirty = _SCAN.get("dirty")
    if not isinstance(dirty, set):
        dirty = set()
        _SCAN["dirty"] = dirty
    entries = _SCAN.get("entries")
    for key in keys:
        dirty.add(key)
        if isinstance(entries, dict):
            # 丢掉旧条目，避免下一轮扫描复用到已过期的文件列表
            entries.pop(key, None)


def _dir_media_entries(dirents: List[os.DirEntry], rel_dir: str, root_id: str) -> List[Dict[str, object]]:
    """把一个目录里可直接枚举到的媒体文件转成 list 条目（不递归）。"""
    items: List[Dict[str, object]] = []
    for entry in dirents:
        try:
            if entry.is_dir(follow_symlinks=False):
                continue
            name = entry.name
            suffix = os.path.splitext(name)[1].lower()
            if suffix not in MEDIA_EXTENSIONS:
                continue
            if not entry.is_file(follow_symlinks=True):
                continue
            stat = entry.stat()
        except OSError:
            continue
        media_type = "video" if suffix in VIDEO_EXTENSIONS else "image"
        mime = mimetypes.guess_type(name)[0] or ("video/*" if media_type == "video" else "image/*")
        items.append(
            {
                "name": name,
                "relpath": name if rel_dir == "." else f"{rel_dir}/{name}",
                "folder": rel_dir,
                "root": root_id,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "mime": mime,
                "media_type": media_type,
                "selectable": media_type == "image",
            }
        )
    items.sort(key=lambda item: str(item["relpath"]).lower())
    return items


def _scan_root(
    root_id: str,
    base: Path,
    dirty: set,
    old_dirs: Dict[Tuple[str, str], int],
    old_entries: Dict[Tuple[str, str], List[Dict[str, object]]],
    new_entries: Dict[Tuple[str, str], List[Dict[str, object]]],
) -> Dict[Tuple[str, str], int]:
    """单次 os.scandir 遍历：校验每个目录自身的 mtime，只重建变化/标脏的目录。"""
    walked: Dict[Tuple[str, str], int] = {}
    stack: List[Path] = [base]
    while stack:
        current = stack.pop()
        try:
            # 先取目录自身 mtime、再 scandir：顺序反了的话，写入正好落在两者之间会
            # 把“变更后”的 mtime 配上“变更前”的条目缓存住（TOCTOU，可能长期缺文件）
            own_mtime = current.stat().st_mtime_ns
        except OSError:
            own_mtime = 0
        try:
            dirents = list(os.scandir(current))
        except OSError:
            continue
        try:
            rel_dir = "." if current == base else current.relative_to(base).as_posix()
        except ValueError:
            continue
        key = (root_id, rel_dir)
        walked[key] = own_mtime

        for entry in dirents:
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
            except OSError:
                continue

        if key not in dirty and old_dirs.get(key) == own_mtime:
            cached = old_entries.get(key)
            if cached is not None:
                new_entries[key] = cached
                continue
        new_entries[key] = _dir_media_entries(dirents, rel_dir, root_id)
    return walked


def _build_listing(roots: List[Dict[str, str]], entries: Dict[Tuple[str, str], List[Dict[str, object]]]) -> Dict[str, object]:
    """从 per-directory 条目拼出对外的 list 响应（字段形状与旧实现完全一致）。"""
    images: List[Dict[str, object]] = []
    folders: Dict[Tuple[str, str], int] = {}
    root_labels = {root["id"]: root["label"] for root in roots}
    for root in roots:
        folders[(root["id"], ".")] = 0

    per_root: Dict[str, List[Tuple[str, List[Dict[str, object]]]]] = {}
    for (root_id, rel_dir), items in entries.items():
        if not items:
            continue
        folders[(root_id, rel_dir)] = len(items)
        if rel_dir != ".":
            current = Path(rel_dir)
            while current != Path("."):
                parent = current.parent.as_posix() if current.parent.as_posix() != "" else "."
                folders.setdefault((root_id, parent), 0)
                current = current.parent
        per_root.setdefault(root_id, []).append((rel_dir, items))

    for root in roots:
        dirs = per_root.get(root["id"]) or []
        start = len(images)
        for _rel_dir, items in dirs:
            images.extend(items)
        if start < len(images):
            # 与旧实现一致：按（根前缀相同的）相对路径小写排序，等价于原来的绝对路径排序
            images[start:] = sorted(images[start:], key=lambda item: str(item["relpath"]).lower())

    folder_items = []
    for (root_id, folder) in sorted(folders.keys(), key=lambda item: (item[0] != "input", item[0], item[1] != ".", item[1].lower())):
        folder_items.append(
            {
                "path": folder,
                "root": root_id,
                "label": root_labels.get(root_id, root_id) if folder == "." else folder,
                "count": folders[(root_id, folder)],
            }
        )

    return {
        "version": VERSION,
        "root": _input_root().as_posix(),
        "roots": [{"id": root["id"], "label": root["label"]} for root in roots],
        "folders": folder_items,
        "images": images,
    }


def _scan_input_tree(force: bool = False) -> Dict[str, object]:
    """列出所有媒体根目录下的媒体文件。

    增量策略（item 6）：
    - per-directory memo：键为 (root_id, 相对目录)，值为该目录自身的 st_mtime_ns。目录自身
      mtime 会随其直接子项的增删改名而变化，所以“往子目录里加文件”同样能让缓存失效
      （旧实现只看各根目录自身的 mtime，因此漏检）。
    - 校验只用一次 os.scandir 遍历；只有 mtime 变了、或被 _invalidate_dir 标脏的目录才重建。
    - force/refresh=1 表示“现在重新校验一遍并重新拼一份列表”，不会退化成整棵 rglob 全量重扫。
    """
    roots = _media_roots()
    old_dirs = _SCAN.get("dirs") or {}
    old_entries = _SCAN.get("entries") or {}
    dirty = set(_SCAN.get("dirty") or ())
    new_dirs: Dict[Tuple[str, str], int] = {}
    new_entries: Dict[Tuple[str, str], List[Dict[str, object]]] = {}

    for root in roots:
        base = Path(root["dir"])
        try:
            walked = _scan_root(root["id"], base, dirty, old_dirs, old_entries, new_entries)
        except OSError:
            walked = {}
        new_dirs.update(walked)

    stamp = tuple(sorted(new_dirs.items()))
    previous_stamp = _SCAN.get("stamp")
    _SCAN["dirs"] = new_dirs
    _SCAN["entries"] = new_entries
    _SCAN["stamp"] = stamp
    # 只消费本轮真正处理过的脏标记（扫描期间新增的保留）
    _SCAN["dirty"] = set(_SCAN.get("dirty") or ()) - dirty

    if not force and not dirty and previous_stamp == stamp and _SCAN.get("listing") is not None:
        return _SCAN["listing"]  # type: ignore[return-value]

    listing = _build_listing(roots, new_entries)
    _SCAN["listing"] = listing
    return listing


def _list_choices() -> List[str]:
    listing = _scan_input_tree()
    values = []
    for item in listing["images"]:
        root = item.get("root", "input")
        rel = item["relpath"]
        # 非 input 根用 "<relpath> [<root>]" 标注，节点用 _resolve_input_file 解析
        values.append(rel if root == "input" else f"{rel} [{root}]")
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


def _query_int(value, default: Optional[int], minimum: Optional[int] = None, maximum: Optional[int] = None) -> Optional[int]:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _etag_matches(header_value: str, key: str) -> bool:
    """If-None-Match 命中判断（容忍强/弱校验与引号）。"""
    raw = str(header_value or "").strip()
    if not raw:
        return False
    if raw == "*":
        return True
    expected = {key, f'"{key}"', f'W/"{key}"'}
    return any(token.strip() in expected for token in raw.split(","))


def _listing_etag_key(stamp, limit: Optional[int], offset: int) -> str:
    parts = [f"{root_id}\t{rel}\t{mtime}" for (root_id, rel), mtime in (stamp or ())]
    parts.append(f"limit={'' if limit is None else limit}\toffset={offset}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


@PromptServer.instance.routes.get("/thumbnails-modern/list")
async def thumbnails_modern_list(request):
    query = request.rel_url.query
    force = query.get("refresh", "0") == "1"
    limit = _query_int(query.get("limit"), None, minimum=0)
    offset = _query_int(query.get("offset"), 0, minimum=0) or 0

    listing = _scan_input_tree(force=force)
    etag_key = _listing_etag_key(_SCAN.get("stamp"), limit, offset)
    headers = {"ETag": f'"{etag_key}"', "Cache-Control": LIST_CACHE_CONTROL}
    if not force and _etag_matches(request.headers.get("If-None-Match"), etag_key):
        return web.Response(status=304, headers=headers)

    payload = dict(listing)
    if limit is not None:
        # 只在显式给了 limit 时切片；folders/total 仍描述完整目录树
        payload["images"] = listing["images"][offset:offset + limit]
        payload["total"] = len(listing["images"])
    return web.json_response(payload, headers=headers)


@PromptServer.instance.routes.get("/thumbnails-modern/media")
async def thumbnails_modern_media(request):
    root_id = (request.rel_url.query.get("root", "input") or "input").lower()
    relpath = request.rel_url.query.get("relpath", "")
    try:
        _base, _rel, target = _resolve_media_path(root_id, relpath)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    if not target.exists() or not target.is_file():
        return web.json_response({"ok": False, "error": "File not found"}, status=404)
    return web.FileResponse(target)


# --------------------------------------------------------------- 缩略图缓存


def _thumb_extension() -> str:
    """缓存文件扩展名：优先 webp，Pillow 不支持时退回 jpg。"""
    cached = _THUMB_EXT.get("ext")
    if cached:
        return cached
    ext = ".jpg"
    try:
        Image.init()
        if ".webp" in Image.registered_extensions():
            ext = ".webp"
    except Exception:
        ext = ".jpg"
    _THUMB_EXT["ext"] = ext
    return ext


def _thumb_cache_dir() -> Path:
    cache_dir = Path(folder_paths.get_temp_directory()).resolve() / THUMB_CACHE_DIR_NAME
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _thumb_key(root_id: str, rel: str, stat: os.stat_result, width: int) -> str:
    """ETag 与缓存文件名共用的 sha1(root|rel|size|mtime_ns|w)。"""
    fingerprint = f"{root_id}|{rel}|{stat.st_size}|{stat.st_mtime_ns}|{width}"
    return hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()


def _cached_thumb_path(cache_dir: Path, key: str) -> Optional[Path]:
    for ext in (".webp", ".jpg"):
        candidate = cache_dir / f"{key}{ext}"
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    return None


def _prune_thumb_cache(cache_dir: Path) -> None:
    """尽力而为：磁盘缩略图超过阈值时按 mtime 淘汰最旧的一批。"""
    _THUMB_STATE["builds"] = _THUMB_STATE.get("builds", 0) + 1
    if _THUMB_STATE["builds"] % THUMB_PRUNE_EVERY:
        return
    try:
        files = [item for item in cache_dir.glob("*") if item.is_file()]
        if len(files) <= THUMB_PRUNE_THRESHOLD:
            return
        files.sort(key=lambda item: item.stat().st_mtime_ns)
        for stale in files[: len(files) - THUMB_PRUNE_THRESHOLD]:
            try:
                stale.unlink()
            except OSError:
                pass
    except Exception:
        return


def _build_thumbnail(source: Path, cache_dir: Path, key: str, width: int) -> Path:
    """在 worker 线程里解码 + 等比缩到 max edge=width，并用 os.replace 原子落盘。"""
    ext = _thumb_extension()
    dest = cache_dir / f"{key}{ext}"
    image = _pillow_open(Image.open, source)
    try:
        try:
            frame = next(ImageSequence.Iterator(image))  # 动画只取第一帧
        except StopIteration:
            frame = image
        frame = _pillow_open(ImageOps.exif_transpose, frame)
        if frame.mode in ("RGBA", "LA") or (frame.mode == "P" and "transparency" in frame.info):
            frame = frame.convert("RGBA")
        else:
            frame = frame.convert("RGB")
        frame.thumbnail((width, width), Image.LANCZOS)

        temp = cache_dir / f"{dest.name}.{os.getpid()}.{time.time_ns()}.part"
        temps = [temp]
        try:
            if ext == ".webp":
                try:
                    frame.save(temp, "WEBP", quality=THUMB_QUALITY, method=4)
                except Exception:
                    # Pillow 实际没编进 webp：退回 jpeg（换扩展名，缓存查找两种都认）
                    dest = dest.with_suffix(".jpg")
                    temp = cache_dir / f"{dest.name}.{os.getpid()}.{time.time_ns()}.part"
                    temps.append(temp)
                    frame.convert("RGB").save(temp, "JPEG", quality=88, optimize=True)
            else:
                frame.convert("RGB").save(temp, "JPEG", quality=88, optimize=True)
            os.replace(temp, dest)
        finally:
            for leftover in temps:
                try:
                    if leftover.exists():
                        leftover.unlink()
                except OSError:
                    pass
        _prune_thumb_cache(cache_dir)
        return dest
    finally:
        try:
            image.close()
        except Exception:
            pass


async def _ensure_thumbnail(source: Path, key: str, width: int) -> Path:
    """命中直接返回缓存文件；未命中则在线程池生成，同一 key 的并发请求共用一次解码。"""
    cache_dir = _thumb_cache_dir()
    cached = _cached_thumb_path(cache_dir, key)
    if cached is not None:
        return cached

    loop = asyncio.get_running_loop()
    inflight = _THUMB_INFLIGHT.get(key)
    if inflight is not None:
        return await asyncio.shield(inflight)

    future: asyncio.Future = loop.create_future()
    _THUMB_INFLIGHT[key] = future
    future.add_done_callback(lambda done: done.cancelled() or done.exception())
    try:
        result = await loop.run_in_executor(None, _build_thumbnail, source, cache_dir, key, width)
        if not future.done():
            future.set_result(result)
        return result
    except BaseException as exc:
        if not future.done():
            # 首个请求被取消（浏览器 abort）：别把伪 CancelledError 塞给同 key 的等待方
            if isinstance(exc, asyncio.CancelledError):
                future.cancel()
            else:
                future.set_exception(exc)
        raise
    finally:
        _THUMB_INFLIGHT.pop(key, None)


THUMB_CONTENT_TYPES = {".webp": "image/webp", ".jpg": "image/jpeg"}


@PromptServer.instance.routes.get("/thumbnails-modern/thumb")
async def thumbnails_modern_thumb(request):
    """等比 max-edge 缩略图，磁盘缓存 + ETag/Cache-Control，If-None-Match 命中回 304。

    视频或解码失败一律 404 + {"ok": false, "error": ...}，前端据此回落到原图。
    """
    query = request.rel_url.query
    root_id = (query.get("root", "input") or "input").lower()
    relpath = query.get("relpath", "")
    width = _query_int(query.get("w"), THUMB_DEFAULT_EDGE, minimum=THUMB_MIN_EDGE, maximum=THUMB_MAX_EDGE)
    if width is None:
        width = THUMB_DEFAULT_EDGE

    try:
        _base, rel, target = _resolve_media_path(root_id, relpath)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    if not target.exists() or not target.is_file():
        return web.json_response({"ok": False, "error": "File not found"}, status=404)
    if target.suffix.lower() in VIDEO_EXTENSIONS:
        return web.json_response({"ok": False, "error": "Video thumbnails are not supported"}, status=404)
    try:
        source_stat = target.stat()
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=404)

    key = _thumb_key(root_id, rel, source_stat, width)
    headers = {"ETag": f'"{key}"', "Cache-Control": THUMB_CACHE_CONTROL}
    if _etag_matches(request.headers.get("If-None-Match"), key):
        return web.Response(status=304, headers=headers)

    try:
        thumb_path = await _ensure_thumbnail(target, key, width)
        data = await asyncio.get_running_loop().run_in_executor(None, thumb_path.read_bytes)
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"Thumbnail failed: {exc}"}, status=404)

    return web.Response(
        body=data,
        headers=headers,
        content_type=THUMB_CONTENT_TYPES.get(thumb_path.suffix.lower(), "application/octet-stream"),
    )


@PromptServer.instance.routes.get("/thumbnails-modern/folder_path")
async def thumbnails_modern_folder_path(request):
    """Absolute path of the folder selected in the sidebar (for the Copy path button)."""
    root_id = (request.rel_url.query.get("root", "input") or "input").lower()
    folder = request.rel_url.query.get("folder", "") or ""
    try:
        _base, _rel, target = _resolve_media_path(root_id, folder)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    if not target.exists() or not target.is_dir():
        return web.json_response({"ok": False, "error": "Folder not found"}, status=404)
    return web.json_response({"ok": True, "path": str(target)})


WRITABLE_ROOTS = ("input", "code_input")


def _delete_file(relpath: str, root_id: str = "input") -> Dict[str, object]:
    """Delete one file inside a writable root (input or 输入)."""
    if root_id not in WRITABLE_ROOTS:
        return {"ok": False, "error": "Deleting is only supported in the input root and the 输入 folder"}
    try:
        base = _root_dir(root_id)
        rel = _safe_rel_path(_split_annotation(relpath)[0])
        if not rel:
            raise ValueError("Empty path")
        target = (base / rel).resolve()
        if base != target and base not in target.parents:
            raise ValueError("Resolved path escapes the media root")
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if not target.exists() or not target.is_file():
        return {"ok": False, "error": "File not found"}
    try:
        target.unlink()
        _invalidate_dir(root_id, Path(rel).parent.as_posix())
        _scan_input_tree(force=True)
        return {"ok": True, "deleted": rel}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@PromptServer.instance.routes.post("/thumbnails-modern/delete")
async def thumbnails_modern_delete(request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    payload = payload or {}
    root_id = str(payload.get("root", "input") or "input").lower()
    result = _delete_file(payload.get("relpath", ""), root_id)
    if result.get("ok"):
        return web.json_response(result)
    status = 404 if result.get("error") == "File not found" else 400
    return web.json_response(result, status=status)


def _save_upload(root_id: str, subfolder: str, filename: str, data: bytes) -> Dict[str, object]:
    """Write one uploaded file into a writable root (input or 输入)."""
    if root_id not in WRITABLE_ROOTS:
        return {"ok": False, "error": "Uploads are only supported in the input root and the 输入 folder"}
    name = os.path.basename(str(filename or "").replace("\\", "/"))
    if not name or name in (".", ".."):
        return {"ok": False, "error": "Invalid file name"}
    ext = os.path.splitext(name)[1].lower()
    if ext not in (ALLOWED_EXTENSIONS | VIDEO_EXTENSIONS):
        return {"ok": False, "error": f"Unsupported file type: {ext}"}
    try:
        base = _root_dir(root_id)
        rel_dir = "" if str(subfolder or "").strip() in ("", ".") else _safe_rel_path(subfolder)
        target_dir = base if not rel_dir else (base / rel_dir).resolve()
        if target_dir != base and base not in target_dir.parents:
            raise ValueError("Target folder is outside the media root")
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / name
        if dest.exists():
            return {"ok": True, "name": name, "subfolder": rel_dir, "skipped": True}
        dest.write_bytes(data)
        # 只失效、不重扫：一次上传 200 张时由 /upload 路由在循环结束后统一刷一次列表
        _invalidate_dir(root_id, rel_dir or ".")
        return {"ok": True, "name": name, "subfolder": rel_dir}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@PromptServer.instance.routes.post("/thumbnails-modern/upload")
async def thumbnails_modern_upload(request):
    root_id = str(request.rel_url.query.get("root", "input") or "input").lower()
    subfolder = request.rel_url.query.get("subfolder", "") or ""
    try:
        reader = await request.multipart()
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"multipart required: {exc}"}, status=400)

    results = []
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name != "image":
            await part.release()
            continue
        data = await part.read()
        results.append(_save_upload(root_id, subfolder, part.filename or "", data))

    if any(item.get("ok") and not item.get("skipped") for item in results):
        # 整个 multipart 只刷一次列表（每个文件只做了 _invalidate_dir）
        _scan_input_tree(force=True)

    if not results:
        return web.json_response({"ok": False, "error": "No file uploaded"}, status=400)
    payload = dict(results[0])
    if len(results) > 1:
        payload["results"] = results
    if not all(item.get("ok") for item in results):
        payload["ok"] = False
    return web.json_response(payload, status=200 if payload.get("ok") else 400)


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
        for item in moved:
            _invalidate_dir(from_root, Path(item["from"]).parent.as_posix())
            _invalidate_dir(to_root, Path(item["to"]).parent.as_posix())
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
        _invalidate_dir(root_id, Path(rel).parent.as_posix())
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
