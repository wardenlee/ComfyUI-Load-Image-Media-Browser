# Changelog

## 1.0.3

### Removed

- the hardcoded extra **输入** root (`/tmp/code/input`). The native `input` directory is now the only input root: when `/tmp/code/input` is passed as `--input-directory`, the extra root pointed at the same folder and only duplicated the tree, making upload / drop / delete targets ambiguous
- no compatibility shim for the old `"<file> [code_input]"` annotation values (pre-1.0.3 workflows that reference them are not migrated)

### Changed

- `WRITABLE_ROOTS` / `WRITE_ROOTS` → `input` only; `DELETE_ROOTS` / `DOWNLOAD_ROOTS` → `input` + `output`
- `DEFAULT_ROOT_ID` → `input` (the browser used to open on the removed root and silently fall back to another one)
- tooltips, the read-only-root hint, comments and the README no longer mention the `输入` root
- version 1.0.3

## 1.0.2

### Added

- **output root** in the media root dropdown: browse ComfyUI's `output` folder next to `input` and pick a rendered image as the input again (the node value becomes `"<file> [output]"`, which the native Load Image node understands)
- per-card **View** button (left of Delete) opening a **panel-sized preview**: the image fills the browser dialog and `‹` / `›` page through the current batch; arrows sit in the gutters next to the panel edges, `←` / `→` and `Esc` work too
- **Copy path** button in the sidebar footer between *Upload folder* and *Delete folder*: copies the absolute path of the folder selected in the sidebar

### Changed

- write actions (Upload, Upload folder, Delete, Delete folder) are limited to the `input` root; the `output` root is browse/select only
- version 1.0.2

## 1.0.1

### Changed

- **Multi** now only toggles multi-select mode; the selected files are deleted with a separate **Delete** button that is always visible in the top row (greyed out while nothing is selected)
- moved **Upload folder** from the top row to the bottom of the folders sidebar
- added **Delete folder** next to it: deletes the folder selected in the sidebar together with everything inside it (the input root itself cannot be deleted)

### Fixed

- after saving a mask / brush edit in the **Mask Editor** or the **Painter**, the node kept loading the original image and the edited file had to be picked again manually:
  - the widget value annotated by ComfyUI (`"<file> [input]"`) was overwritten by the first file of the folder
  - the backend did not resolve the annotation suffix (`folder_paths.get_annotated_filepath` semantics)
  - thumbnails / node preview URLs no longer include the annotation suffix

## 1.0.0

Initial public GitHub-ready release of **ComfyUI Load Image Media Browser**.

### Included in 1.0.0

- renamed package to **ComfyUI Load Image Media Browser**
- added **Browse Media** integration for **Load Image**
- added **Browse Media** integration for **Load Video**
- both nodes can display images and videos in the browser
- only compatible media types are selectable per node
- added media visibility toggles for **Images** and **Videos**
- remembers the last opened folder
- keeps selection behavior inside the current folder
- added sorting by date and file name
- added direct delete action in the browser
- improved preview handling for portrait and landscape media
- added automatic node resizing for previews
- added aspect-ratio presets for 16:9, 9:16, 1:1, 4:3, and 3:4
