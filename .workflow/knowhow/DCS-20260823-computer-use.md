---
title: Computer Use 权重测试后续计划
type: decision
created: 2026-08-23T02:44:59.063Z
---

# Computer Use 权重测试后续计划

## 状态（当前会话结束时）

- **RapidOCR ONNX**（det `ch_PP-OCRv3_det_infer.onnx` / cls `ch_ppocr_mobile_v2.0_cls_infer.onnx` / rec `ch_PP-OCRv3_rec_infer.onnx`）：已在 `optional/computer-use-manifest.json` 中标记 `verified_local`，SHA-256 本地实测。本地路径 `C:/Users/dyw/miniconda3/Lib/site-packages/rapidocr_onnxruntime`（Python rapidocr_onnx_runtime 包内）。det→crop→cls→rec 管线已用 puppeteer 截图烟雾测试验证（如 "Login" → "Login"）。
- **OmniParser-v2 `icon_detect`**：provenance 未验证，manifest 标记 `unverified_missing`，运行时按设计 fail-closed 返回 `MODEL_PROVENANCE_UNVERIFIED`，不伪造图标坐标。

## 下次权重测试要做的

1. **RapidOCR 准确性回归**：设 `RAPIDOCR_ONNX_ROOT` 指向本地 rapidocr 包，运行 `test/browser-ocr-detect.test.ts`（`runOcr over a rendered text page`、`tab.detect()`、region crop）和 `test/computer-use-vision.test.ts`，确认 det→crop→cls→rec 与 CTC 解码在多字号/CJK/旋转场景下稳定。已知小字号（28px）单标签偶有漏检，测试用 skip 容错，不要改成硬断言。
2. **OmniParser provenance 验证**（前提：拿到可信来源的权重与官方 SHA-256）：把 SHA-256 写进 manifest、`status` 改 `verified_local`，再跑 `OmniParser detection is explicitly unavailable when provenance is missing` 之外的真实 detect 用例。**在 provenance 验证通过前，不得放开 fail-closed**。
3. **打包回归**：`node --test test/computer-use-packaging.test.mjs` 确认权重/缓存/.part 不入包，manifest/notices/schema 入包。

## 硬约束（不可破坏）

- 权重绝不打进 npm 包；本地路径仅用于测试环境。
- provenance 未验证时必须 fail-closed，绝不返回伪造的检测坐标。
- optional native 依赖缺失不得崩溃启动。
