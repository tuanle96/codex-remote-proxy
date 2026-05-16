# Codex Remote Proxy 中文文档

Codex Remote Proxy 的作用很直接：

- 保留 Codex 的 ChatGPT 登录态，用于手机端远程连接和远程控制
- 把真实模型请求转发到你自己的 OpenAI 兼容 `base_url`
- 把请求头里的 `Authorization` 改写成真实 API key

## 它解决了什么问题

Codex 的两个本地文件分别控制不同事情：

- `~/.codex/config.toml` 决定请求发往哪里
- `~/.codex/auth.json` 决定 `Authorization` 里放什么

当 Codex 处于 ChatGPT 登录模式时，发出去的通常不是普通 API key，而是 `tokens.access_token`。很多第三方 OpenAI 兼容服务并不接受这个值，所以即使 `base_url` 改对了，也可能无法正常对话。

这个项目通过本地代理解决这个错位。

## 推荐使用方式

当前最推荐的路径是 Node 版本，也是目前已验证可正常转发和对话的主路径。

先安装 Node 依赖：

```bash
cd node
npm install
cd ..
```

再运行统一 CLI：

```bash
node cli/codex-remote-proxy.mjs install
```

如果希望非交互式执行：

```bash
node cli/codex-remote-proxy.mjs install \
  --impl node \
  --upstream-base-url https://your-upstream.example.com \
  --api-key sk-your-key
```

完成后：

1. 重启 Codex Desktop
2. 使用 ChatGPT 账号登录
3. 正常继续使用 Codex

## 统一 CLI

统一入口：

```bash
node cli/codex-remote-proxy.mjs
```

主要命令：

- `check`
  查看 Codex 配置、鉴权模式、运行时状态和托管服务状态

- `install`
  提示输入或接收 `base_url` / `api_key`，自动选择空闲端口，修改 Codex 配置，并默认后台启动代理

- `status`
  查看当前托管服务状态和健康检查结果

- `stop`
  停止托管服务

- `guide`
  输出给 AI 读取的调用说明

常见 JSON 调用方式：

```bash
node cli/codex-remote-proxy.mjs check --json
node cli/codex-remote-proxy.mjs guide --json
node cli/codex-remote-proxy.mjs status --json
```

## 给 AI 的建议

建议流程：

1. 先跑 `check --json`
2. 读取 `recommendedImplementation`
3. 如果 Node 依赖就绪，优先走 `node`
4. 再跑 `install`
5. 从返回结果中读取 `proxyUrl`、`pid`、`health`
6. 之后用 `status --json` 做确认

注意：

- `install` 会修改 `~/.codex/config.toml`
- `install` 会先创建备份
- Node 路径当前需要先执行 `cd node && npm install`

## 实现目录

- [../node](../node)
  推荐实现

- [../python](../python)
  Python 备选实现
