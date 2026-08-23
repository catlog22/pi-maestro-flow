---
title: OmniParser icon_detect 真实 detect 已跑通
type: decision
created: 2026-08-23T03:17:52.086Z
---

# OmniParser icon_detect 真实 detect 已跑通

## 状态（本次会话更新）

**之前（DCS-20260823-computer-use）**：OmniParser provenance `unverified_missing`，fail-closed，未测真实 detect。
**本次**：已下载官方权重 → 转 ONNX → manifest verified_local → 真实 detect 跑通。

## 完成的工作

1. **下载官方权重**：`microsoft/OmniParser-v2.0` `icon_detect/model.pt`，SHA-256 `dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57`，40MB。
2. **pt→onnx 转换**：`ultralytics==8.4.126 export(format=onnx, opset=12, imgsz=640, simplify=true)` → `model.onnx`，派生 SHA-256 `04bd2f00aa4d2cee1e2ba588fddeb575de1d074f76c4f945d89730df86bc3378`，80MB。模型 YOLO11m detect，输入 [1,3,640,640]，输出 [1,5,8400] 单类无 NMS。
3. **manifest 更新**：`omniparser.v2.icon_detect` 改 `verified_local`，path 指向 .onnx，provenance 记录转换链（官方 .pt SHA-256 + ultralytics 版本 + 导出参数），sha256 = 派生 ONNX digest。
4. **worker.ts 补 ONNX 回退**：detect() 无 runtime 注入时走内置 ONNX icon_detect + 内置 RapidOCR lines。新增 letterbox 预处理、YOLO11 输出解码、greedy NMS、坐标映射。
5. **真实 detect 测试**：烟雾测试 3 个方块图标全部检测到，坐标误差<3px，conf 0.75-0.82。match/crop 两模式均验证。新增环境门控的真实 detect 测试 + 保留 fail-closed 契约测试（用临时 manifest 隔离）。
6. **安装文档**：`optional/COMPUTER-USE-WEIGHTS-SETUP.md`，5 步 AI 可执行流程 + 5 项验证 + 回滚。

## 关键技术决策

- **必须转 ONNX**：GA 用 ultralytics+PyTorch 直接加载 .pt；我们 vision service 是 onnxruntime-node，物理上只能加载 ONNX。转换是格式适配，CU-0 契约（onnxruntime-node）不变。
- **ONNX 不含 NMS**：YOLO11 导出特性，runtime adapter 自己实现 greedy NMS。测试图 30 个候选框经 NMS 降为 3 个真实目标。
- **派生 SHA-256**：ONNX digest 不是官方值，是 ultralytics 版本+导出参数确定性产出。同版本同输入产同输出。provenance 必须如实记录转换链。
- **fail-closed 契约保留**：用临时 manifest 构造 unverified_missing 场景单独测试，与 verified_local 状态解耦。

## 验证结果

- 真实 detect 测试：pass 1（环境门控，需模型文件+onnxruntime-node）
- fail-closed 契约测试：pass 1
- CU 完整套件：pass 36（vision+manager+tool+facade+contract+broker）
- packaging：pass 1（文档入包，权重不入包）
- typecheck：exit 0

## 文件位置

- 官方 .pt：`G:/github_lib/GenericAgent/temp/weights/icon_detect/model.pt`
- ONNX：`G:/github_lib/GenericAgent/temp/weights/icon_detect/model.onnx`
- manifest：`packages/pi-maestro-flow/optional/computer-use-manifest.json`
- 安装文档：`packages/pi-maestro-flow/optional/COMPUTER-USE-WEIGHTS-SETUP.md`
- 实现：`packages/pi-maestro-flow/src/computer-use/vision/worker.ts`（inferIconDetect/letterbox/NMS/decodeIconDetect）
