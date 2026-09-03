# pi-antigravity

通过 Google Antigravity OAuth 在 Pi Coding Agent 中使用 Antigravity 模型。

本插件**不需要用户预先安装 Antigravity CLI**。安装 Pi 包后，插件自己注册 OAuth 登录、模型目录和流式请求 provider。

> **重要风险提示**：Antigravity 的非官方第三方接入可能不符合 Google 服务条款，并可能导致账号受限。请在使用前自行确认条款并审查代码。本项目不保存或上传 OAuth 凭据。

## 安装

```bash
pi install git:github.com/inouemoby/pi-antigravity
```

Pi 需要 Node.js 22 或更高版本。安装后重启 Pi，或执行 `/reload`。

## 登录

```text
/login
```

选择 **Google Antigravity**，在浏览器中使用 Google 账号完成 OAuth。浏览器跳转到 localhost 后，把完整 callback URL 粘贴回 Pi；插件会保存刷新令牌并在以后自动刷新。

## 选择模型

```text
/model
```

也可以使用：

```text
/antigravity-models
```

模型目录由 `@cortexkit/antigravity-auth-core` 提供，当前包括 Gemini 3.x Flash、Gemini 3.1 Pro，以及 Antigravity 公开的其他模型。图片输出模型不会注册到 Pi，因为 Pi 当前的 provider 流协议没有图片输出块。

## 设计目标

- `/login` 内置 OAuth 2.0 PKCE 流程；不依赖 `gemini` 或 `agy` 可执行文件。
- 使用 Pi 的 `auth.json` 保存 OAuth 凭据，访问令牌只在请求期间使用。
- 自动注册 Antigravity 模型及上下文窗口、最大输出 token 等元数据。
- 支持文本、图片输入、思考输出和 Pi 工具调用。
- 通过 Antigravity 的 SSE 流式接口返回 Pi 标准事件。

## 开发

```bash
npm install
npm run check
npm run build
```

本项目依赖 `@cortexkit/antigravity-auth-core` 提供 Antigravity OAuth、请求传输和协议变换；Pi 端的登录流程、模型注册、消息转换和流式事件处理由本项目实现。

## 许可证

MIT
