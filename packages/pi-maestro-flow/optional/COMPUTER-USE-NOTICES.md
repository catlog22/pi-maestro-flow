# Computer Use Optional Components

CU-0 records contracts for optional native providers only. Package startup must continue when any of these packages are not installed; callers must load them lazily and surface a diagnostic when unavailable.

## Native packages

The package versions in `computer-use-manifest.json` were inspected from npm registry tarballs on this worktree and are optional dependencies:

- `onnxruntime-node@1.21.0` - MIT; local probe passed through the existing `maestro-flow` dependency graph. The package declares Windows, macOS, and Linux support and exposes CPU and DirectML backends in the local build.
- `@nut-tree-fork/nut-js@4.2.6` - Apache-2.0; registry declarations expose mouse, keyboard, screen, and window APIs. No input API was invoked during CU-0.
- `screenshot-desktop@1.15.6` - MIT; registry package supports Windows, macOS, and Linux. Linux requires an external screenshot utility according to the package README. No screenshot was captured during CU-0.
- `active-win@9.0.0` - MIT; registry declarations expose active-window and open-window metadata APIs. The package README states that Wayland is unsupported. No window query was made during CU-0.
- `node-window-manager@2.2.4` - MIT; registry declarations expose `windowManager`, `Window`, and `Monitor`. Its README marks Linux support as work-in-progress. No window operation or accessibility request was made during CU-0.

## Model provenance

The local Python `rapidocr-onnxruntime@1.2.3` distribution was inspected and contains the three RapidOCR ONNX files recorded with local SHA-256 digests in the manifest. These files are not copied into this repository.

`GenericAgent/memory/ui_detect.py` refers to `temp/weights/icon_detect/model.pt` as an OmniParser-v2 YOLO model and imports `ultralytics`. Neither the model nor the Python package is available in the inspected environment. No authoritative URL or digest was established, so the manifest marks that artifact `unverified_missing`. Implementations must fail closed with `MODEL_PROVENANCE_UNVERIFIED`; they must not download or silently substitute a model.

This notice is evidence of the CU-0 inspection, not a grant of permission to perform desktop input or mutate user state.
