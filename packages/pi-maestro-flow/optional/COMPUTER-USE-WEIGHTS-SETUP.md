# Computer Use 视觉权重安装指南（AI 可执行）

本文档面向 AI agent，提供把 OmniParser-v2 `icon_detect` 权重接入 `computer_use` 工具的完整步骤。每步含可复制命令、预期输出、校验点。执行前请通读全文。

## PURPOSE

把 OmniParser-v2 `icon_detect` 权重接入 computer_use 工具：下载官方 `.pt` → 转 ONNX → 更新 manifest → 验证真实 UI 检测。成功标准：`computer_use` 的 detect 不再返回 `MODEL_PROVENANCE_UNVERIFIED`，能检测到屏幕上的 icon。

## PREREQUISITES

- Python 3.10+（下载权重 + ultralytics 转换）
- `huggingface_hub` Python 包（`pip install huggingface_hub`）
- `ultralytics==8.4.126`（转换工具，会装 torch）
- `onnxruntime-node` 已作为 optionalDependency 安装
- 本地 RapidOCR 模型路径（`RAPIDOCR_ONNX_ROOT` 环境变量，detect 的 OCR 标签匹配需要）

## 前置约束

- **不得把权重打入 npm 包**。权重是运行时本地资源，`computer-use-packaging.test.mjs` 会断言 `.onnx`/`.pt`/`.bin` 等不入包。
- **provenance 未验证时必须 fail-closed**。manifest 里 `status` 只能是 `verified_local`（已验证）或 `unverified_missing`（缺失），不存在"下载了但没验证"的中间态。
- **runtime 是 ONNX**。我们用 `onnxruntime-node`，不是 ultralytics/PyTorch。官方只发 `.pt`，需转换。

## 产物清单

安装完成后本地应有：

| 文件 | 用途 | 来源 |
|---|---|---|
| `temp/weights/icon_detect/model.pt` | 官方 PyTorch 权重（provenance 根） | microsoft/OmniParser-v2.0 |
| `temp/weights/icon_detect/model.onnx` | ONNX 转换产物（运行时实际加载） | ultralytics export |
| `optional/computer-use-manifest.json` | 记录两个 SHA-256 + provenance | 手工更新 |

---

## 步骤 1：下载官方权重并记录 provenance

```bash
python - <<'PY'
from huggingface_hub import hf_hub_download
import hashlib, os
os.makedirs("temp/weights/icon_detect", exist_ok=True)
path = hf_hub_download(
    repo_id="microsoft/OmniParser-v2.0",
    filename="icon_detect/model.pt",
    local_dir=".",
)
print("DOWNLOADED", path)
h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1<<20), b""):
        h.update(chunk)
print("PT_SHA256", h.hexdigest())
print("PT_SIZE", os.path.getsize(path))
PY
```

**预期输出**：
```
DOWNLOADED <cwd>/icon_detect/model.pt
PT_SHA256 dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57
PT_SIZE 40623819
```

**校验点**：SHA-256 必须等于 `dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57`。不一致立即停止——权重被篡改或仓库变更。

移动到 GA 期望路径（可选，若用 GA 兼容路径）：
```bash
mkdir -p temp/weights/icon_detect && mv icon_detect/model.pt temp/weights/icon_detect/model.pt && rmdir icon_detect
```

---

## 步骤 2：安装 ultralytics 并转换为 ONNX

```bash
pip install ultralytics==8.4.126
```

**校验点**：`python -c "import ultralytics; print(ultralytics.__version__)"` 输出 `8.4.126`。

转换：
```bash
python - <<'PY'
from ultralytics import YOLO
import hashlib, os
mdl = YOLO("temp/weights/icon_detect/model.pt")
out = mdl.export(format="onnx", dynamic=False, simplify=True, opset=12, imgsz=640)
print("EXPORTED", out)
h = hashlib.sha256(open(out, "rb").read())
print("ONNX_SHA256", h.hexdigest())
print("ONNX_SIZE", os.path.getsize(out))
PY
```

**预期输出**：
```
=== task type === detect
...
ONNX: export success ... saved as 'temp\weights\icon_detect\model.onnx' (76.7 MB)
EXPORTED temp/weights/icon_detect/model.onnx
ONNX_SHA256 04bd2f00aa4d2cee1e2ba588fddeb575de1d074f76c4f945d89730df86bc3378
ONNX_SIZE 80428860
```

**校验点**：
- ONNX SHA-256 = `04bd2f00aa4d2cee1e2ba588fddeb575de1d074f76c4f945d89730df86bc3378`
- 模型架构：YOLO11m detect，输入 `[1,3,640,640]`，输出 `[1,5,8400]`（单类，无 NMS）
- 文件大小 ~80MB

> **注意**：ONNX SHA-256 是**派生值**（由官方 `.pt` + ultralytics 版本 + 导出参数确定性产出）。同版本同输入产同输出，但不是官方值。provenance 字段必须如实记录转换链。

---

## 步骤 3：更新 manifest

编辑 `optional/computer-use-manifest.json`，把 `omniparser.v2.icon_detect` 条目改为：

```json
{"id":"omniparser.v2.icon_detect","kind":"ui_detector","status":"verified_local","path":"<绝对路径>/temp/weights/icon_detect/model.onnx","package":"ultralytics","package_version":"8.4.126","provenance":"Derived from microsoft/OmniParser-v2.0 icon_detect/model.pt (official SHA-256 dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57) via ultralytics 8.4.126 export(format=onnx, opset=12, imgsz=640, simplify=true).","sha256":"04bd2f00aa4d2cee1e2ba588fddeb575de1d074f76c4f945d89730df86bc3378"}
```

**校验点**：
- `status` = `verified_local`（不是 `unverified_missing`）
- `sha256` = 步骤 2 的 ONNX SHA-256
- `provenance` 必须包含官方 `.pt` SHA-256 + 转换工具版本 + 导出参数
- `path` 指向 `.onnx`（不是 `.pt`）

---

## 步骤 4：配置 RapidOCR 环境（OCR 路径用）

detect 的 label 匹配依赖 RapidOCR。设环境变量指向本地 rapidocr 包：

```bash
# Windows (Git Bash)
export RAPIDOCR_ONNX_ROOT='C:/Users/<user>/miniconda3/Lib/site-packages/rapidocr_onnxruntime'
```

**校验点**：`$RAPIDOCR_ONNX_ROOT/models/` 下应含 `ch_PP-OCRv3_det_infer.onnx`、`ch_PP-OCRv3_rec_infer.onnx`、`ch_ppocr_mobile_v2.0_cls_infer.onnx`。manifest 里这三个 RapidOCR 模型的 SHA-256 必须与本地文件一致。

---

## 步骤 5：验证

### 5a. 真实 detect 烟雾测试

```bash
cd packages/pi-maestro-flow
RAPIDOCR_ONNX_ROOT='<步骤4的路径>' node --experimental-transform-types --test \
  --test-name-pattern="OmniParser icon_detect returns real icon detections" \
  test/computer-use-vision.test.ts
```

**预期**：`pass 1 fail 0`。若 skip，说明模型文件或 onnxruntime-node 未就位。

### 5b. fail-closed 契约仍成立

```bash
node --experimental-transform-types --test \
  --test-name-pattern="OmniParser detection is explicitly unavailable" \
  test/computer-use-vision.test.ts
```

**预期**：`pass 1 fail 0`。用临时 manifest 构造 `unverified_missing` 验证 fail-closed。

### 5c. 完整 CU 套件

```bash
RAPIDOCR_ONNX_ROOT='<步骤4的路径>' node --experimental-transform-types --test \
  test/computer-use-vision.test.ts \
  test/computer-use-manager.test.ts \
  test/computer-use-tool.test.ts \
  test/local-vision-facade.test.ts \
  test/computer-use-native-provider-contract.test.mjs \
  test/teammate-computer-use-broker.test.ts
```

**预期**：`pass 36 fail 0`。

### 5d. 打包回归（权重不入包）

```bash
node --test test/computer-use-packaging.test.mjs
```

**预期**：`pass 1 fail 0`。

### 5e. typecheck

```bash
npx tsc -p tsconfig.intelligence.json --noEmit
```

**预期**：无输出，exit 0。

---

## 技术说明：为什么需要转换

GA 的 `ui_detect.py` 是 Python，用 `ultralytics.YOLO("model.pt")` 直接加载 PyTorch 权重。我们的 vision service 是 Node.js + `onnxruntime-node`，**物理上只能加载 ONNX**。`.pt` 是 PyTorch 原生格式，onnxruntime 无法加载。转换是格式适配，不是额外步骤。

导出的 ONNX **不含 NMS**（YOLO11 导出特性），runtime adapter 自己实现：letterbox 预处理 → 推理 → `[1,5,8400]` 解码 → greedy NMS → 坐标映射回原图。测试图 30 个候选框经 NMS 降为 3 个真实目标。

## 回滚

若要回滚到 fail-closed 状态，把 manifest 条目改回：
```json
{"id":"omniparser.v2.icon_detect","kind":"ui_detector","status":"unverified_missing","path":"...","package":"ultralytics","package_version":null,"provenance":null,"diagnostic":"Required model.pt and the ultralytics package were not found locally..."}
```
detect 会重新返回 `MODEL_PROVENANCE_UNVERIFIED`。权重文件可保留或删除，不影响 fail-closed 行为。
