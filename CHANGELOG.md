# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [1.1.1] - 2026-04-22

### Fixed

- **修复模型 ID 错误** — 移除对 `selected_variant` 的使用，直接使用 `key` 作为模型 ID。`selected_variant` 包含量化后缀（如 `@q4_k_m`），导致 API 调用时模型 ID 不正确

## [1.1.0] - 2026-04-20

### Added

- **模型缓存** — 首次成功探测后缓存模型列表到 `~/.pi/agent/lmstudio-models.json`，下次启动时同步加载，解决 pi 重启后需要重新选择模型的问题
- **`/login lmstudio` 命令** — 通过 pi 原生的 `/login` 机制输入 LM Studio API Token，凭证持久化到 `~/.pi/agent/auth.json`，无需重复输入
- **环境变量认证** — 支持 `LM_API_TOKEN`（与 LM Studio 官方文档一致）和 `LM_API_KEY`（向后兼容）环境变量传入 API Token
- **401 兼容探测** — 端口扫描时遇到 401 状态码也识别为 LM Studio 在运行，提示用户配置 Token
- 架构图中新增本地缓存层说明

### Fixed

- 修复模型类型过滤条件拼写错误：`"embeddings"` → `"embedding"`（影响 `detectAndRegister` 和 `/lmstudio` handler 两处）

### Changed

- README 补充模型记忆、认证支持等新特性说明
- README 命令表格新增 `/login lmstudio` 条目
- 架构 Mermaid 图新增缓存层

## [1.0.0] - 2026-04-19

### Added

- **自动端口检测** — 启动时扫描 1234、8080 端口，支持 `LMSTUDIO_PORT` 环境变量自定义
- **原生 API 模型发现** — 通过 `/api/v1/models` 获取模型元数据（上下文窗口、类型、量化、视觉/推理能力）
- **OpenAI 兼容推理** — 通过 `/v1/chat/completions` 实现对话推理，完整支持工具调用和流式输出
- **参数透传** — 不主动设置 temperature 等采样参数，由 LM Studio GUI 配置生效
- **`/lmstudio` 命令** — 手动触发检测/刷新，`/lmstudio off` 临时卸载
- **LM Studio 离线保护** — 重新检测失败时展示上次注册的模型列表，而非清空
- 中英双语文档（README.md / README.en.md）
