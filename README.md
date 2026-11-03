# ccgui-relay-docker

CC GUI 外网穿透中继的**自部署 Docker 版**。它替代官方部署包里的 Cloudflare Worker，让你在自己的服务器 / NAS 上跑同一个中继，不再依赖 `*.workers.dev`。

桌面端仍然是主动外连、不开放任何入站端口；中继只负责校验密钥和转发字节。手机能不能进来，依旧由 CC GUI 自己的 URL token 和逐设备配对授权决定。

- 镜像：`ghcr.io/sdp-kun/ccgui-relay-docker`（linux/amd64 + linux/arm64）
- 运行时：Node 24，单进程，无数据库、无持久化
- 协议：与 Cloudflare Worker 版完全一致，CC GUI 桌面端无需任何改动

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/SDP-Kun/ccgui-relay-docker.git
cd ccgui-relay-docker
cp .env.example .env

# 生成并填入密钥
openssl rand -base64 32
# 编辑 .env，把 RELAY_KEY 改成上面这串

docker compose up -d
docker compose logs -f relay
```

服务默认只监听宿主机回环地址 `127.0.0.1:8787`，TLS 交给同机的 Caddy/Nginx（见下文）。需要局域网直连时，把 `compose.yaml` 里的端口改成 `"8787:8787"`。

### docker run

```bash
export RELAY_KEY="$(openssl rand -base64 32)"
echo "请保存这个密钥：$RELAY_KEY"

docker run -d --name ccgui-relay --restart unless-stopped \
  -e RELAY_KEY="$RELAY_KEY" \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/sdp-kun/ccgui-relay-docker:latest
```

## 配置 CC GUI

1. 电脑打开 CC GUI → **设置 → 远程访问 → 外网访问**
2. **中转地址**：填你的公网地址，例如 `https://relay.example.com`（不是 `/agent`，不带路径）
3. **中转密钥**：与容器里的 `RELAY_KEY` 完全一致
4. 点「连接中转」
5. 手机打开同一个地址 → 授权页 → 输入 CC GUI 上显示的 8 位配对密钥

> 换 `RELAY_KEY` 等于换命名空间，手机端需要重新配对。

## 多台桌面端（多个 CC GUI 宿主）

**一个中继容器只服务一台桌面端。**

桌面端与中继之间是一对一的 WebSocket，协议里没有第二个身份维度可以区分不同的 CC GUI 实例。两台桌面端填同一个地址和密钥时，新连接会以 `1012` 顶掉旧连接；双方自动重连后就会每秒互相踢一次——表现为「只有一个通」，容器日志里会出现大量 `agent connected`。

要让多台 CC GUI 同时在线，**每台桌面端各起一个容器，各用一套密钥和端口**：

```yaml
services:
  relay-a:
    image: ghcr.io/sdp-kun/ccgui-relay-docker:latest
    restart: unless-stopped
    environment:
      RELAY_KEY: ${RELAY_KEY_A}
    ports:
      - "8787:8787"

  relay-b:
    image: ghcr.io/sdp-kun/ccgui-relay-docker:latest
    restart: unless-stopped
    environment:
      RELAY_KEY: ${RELAY_KEY_B}
    ports:
      - "8788:8787"
```

桌面端 A 填 `https://relay.example.com:8787`，B 填 `https://relay.example.com:8788`，密钥各用各的。前面放 Caddy/Nginx 时，为每个端口（或每个子域名）各写一条反代即可。

> 同一域名、不同端口会共享浏览器 cookie；同一部手机在两个地址之间切换时需要重新配对。需要完全隔离时，请为每台桌面端使用独立子域名。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RELAY_KEY` | **必填** | 桌面端与中继的共享密钥。缺失时容器直接退出 |
| `PORT` | `8787` | 容器内监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `HEAD_TIMEOUT_MS` | `30000` | 桌面端多久不返回响应头就向手机回 504 |
| `MAX_BODY_BYTES` | `67108864` | 单个请求体上限（64 MiB），超出回 413 |
| `AGENT_PING_INTERVAL_MS` | `30000` | 对桌面端 WebSocket 的保活间隔；`0` 关闭 |

## HTTPS / 反向代理

中继自己只跑 HTTP，**公网访问请务必加一层 TLS**：手机端的 URL 和 WebSocket 都需要 `https` / `wss`，明文传输也会暴露 token。

### Caddy（最省事，自动证书）

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 默认就支持 WebSocket 升级和流式响应，无需额外配置。

### Nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;
    # ssl_certificate     /path/fullchain.pem;
    # ssl_certificate_key /path/privkey.pem;

    # 请求路径里可能带有密钥分片，不要写进访问日志
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

> Nginx 也可以只跑 `:80` 并放在 Cloudflare 代理后面，但那样又回到了 Cloudflare 网络；自部署的意义通常是用自己的域名 + 自己的证书。

## 健康检查

- `GET /healthz` 返回 `200 {"ok":true,"agent":false|true}`。容器健康检查只判断进程是否可用；`agent:false` 表示桌面端还没连上来，此时手机访问会收到 503 和中文提示。
- 日志输出到 stderr，只记录连接/断开与错误，不记录带 token 的 URL。

## 镜像标签

| 标签 | 触发 |
|---|---|
| `latest` | 每次推送到 `main` |
| `main` | 同上 |
| `sha-<commit>` | 每次推送 |
| `0.1.0` / `0.1` | 推送 `v0.1.0` 这类 tag |

## 本地开发

```bash
npm install
npm test          # 14 个集成测试：HTTP/WS 隧道、鉴权、超时、重连替换
RELAY_KEY=dev-secret-at-least-16-chars npm start
```

构建本地镜像：

```bash
docker build -t ccgui-relay:local .
docker run --rm -e RELAY_KEY=dev-secret-at-least-16-chars -p 8787:8787 ccgui-relay:local
```

## 工作方式与限制

- 一个密钥对应一个桌面端：新连接会踢掉旧连接（关闭码 1012），和 Worker 版一致。多台桌面端请各起一个容器，见上文「多台桌面端」。
- 所有流都保存在进程内存里，**不要横向扩多个副本**；单容器即可。
- 不需要卷、不需要数据库；容器重启后桌面端会自动重连。
- 桌面端与中继之间走的是明文 WebSocket（由前面那层 TLS 保护），请勿把 `8787` 直接暴露到公网。

## 安全说明

- `RELAY_KEY` 是桌面端接入中继的唯一凭据，请使用长随机值，不要提交进 Git。
- 中继本身不保存任何消息内容，也不做用户鉴权；手机端的 token 校验与设备配对发生在 CC GUI 内。
- 日志与反向代理访问日志里避免记录完整路径：URL 中可能含有密钥分片。
- 怀疑密钥泄露时：修改 `RELAY_KEY` 并重启容器，然后在 CC GUI 里重新「连接中转」并重新配对手机。

## License

MIT