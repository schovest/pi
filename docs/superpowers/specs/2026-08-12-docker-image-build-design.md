# 容器镜像构建 Action 与部署文档 — 设计

日期：2026-08-12
状态：已批准（用户确认）

## 目标

- 新增 GitHub Actions workflow，将 pi 构建为 OCI 容器镜像并发布到 GitHub Container Registry（`ghcr.io/schovest/pi`）。
- 更新 README，新增容器镜像部署方法。
- 镜像自带最新 LTS 的 npm（基础镜像用 Node LTS，自带 npm）。

## 已确认的决策

| 决策点 | 选择 |
| --- | --- |
| 镜像仓库 | ghcr.io（`ghcr.io/schovest/pi`），GITHUB_TOKEN 免配置 |
| 构建方式 | COPY 预编译发布二进制（复用 build-binaries.sh linux 产物） |
| 触发时机 | push `v*` tag + workflow_dispatch（手动指定 tag） |
| 基础镜像 | `node:24-bookworm-slim`（最新 LTS Node + npm，glibc） |
| 平台 | linux/amd64 + linux/arm64 |
| tag 策略 | `<版本号>`（去 v 前缀）+ `latest` |
| 运行用户 | root（与 containerization.md 现有文档行为一致） |
| workflow 组织 | 独立 `docker-image.yml`，不与 build-binaries.yml 混合 |

## 方案选择

### 方案 A（选定）：独立 workflow + 根目录 Dockerfile

- 与 build-binaries.yml 解耦：镜像发布失败不影响二进制/npm 发布。
- 复用共享脚本 `scripts/build-binaries.sh` 的 linux 产物。
- 代价：workflow 中构建二进制的编排步骤有少量重复（脚本本身共享）。

### 方案 B（未选）：并入 build-binaries.yml 作为第三个 job

- 一次 tag 发布完成全部，但混合职责、互相阻塞，且该文件已较长。

## 架构与组件

### 1. `Dockerfile`（仓库根目录）

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY --from=linux-$TARGETARCH / /opt/pi
ENV PATH="/opt/pi:$PATH"

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

要点：

- `node:24-bookworm-slim`：自带最新 LTS Node + npm；与 containerization.md 现有 Plain Docker 例子一致。
- 必须 glibc：Bun 编译二进制（`target=bun-linux-*`）依赖 glibc，不能用 alpine。
- `git` + `ca-certificates`：pi 运行必需（git 操作、HTTPS）。
- 多平台通过 buildx **命名 context** + `TARGETARCH` 实现：workflow 中为每个平台产出二进制目录，Dockerfile 用 `COPY --from=linux-$TARGETARCH / /opt/pi` 选择对应平台目录。
- 整个二进制产物目录（pi 可执行文件、package.json、README、CHANGELOG、photon wasm、theme/、assets/、export-html/、docs/、examples/、primary-agents/、clipboard 原生库）COPY 到 `/opt/pi`。
- 默认 root 运行（与现有文档行为一致，挂载卷无权限问题）。

### 2. `.github/workflows/docker-image.yml`

触发：

```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:          # 手动指定要构建的 tag
      source_ref:   # 指定源码 ref（release 恢复用），与 build-binaries.yml 一致
```

job `docker`，`runs-on: ubuntu-latest`，`permissions: { contents: read, packages: write }`。

步骤：

1. Checkout（`SOURCE_REF`，persist-credentials: false）
2. Setup Bun（oven-sh/setup-bun@v2，bun-version 1.3.10，与 build-binaries.yml 一致）
3. Setup Node.js（actions/setup-node@v4，node 22）
4. `npm ci --ignore-scripts` + `npm run build`（`dist/` 是二进制构建输入）
5. 构建 linux 二进制（两次调用，`--skip-install --skip-build`，不传 `--skip-deps` 以保留 clipboard 原生依赖安装；**必须不同 `--out`**，脚本会清空输出目录）：
   - `./scripts/build-binaries.sh --skip-install --skip-build --platform linux-x64 --out /tmp/pi-linux-x64`
   - `./scripts/build-binaries.sh --skip-install --skip-build --platform linux-arm64 --out /tmp/pi-linux-arm64`
6. docker/setup-qemu-action（arm64 模拟）
7. docker/setup-buildx-action
8. docker/login-action：ghcr.io，username `${{ github.actor }}`，password `${{ secrets.GITHUB_TOKEN }}`
9. docker/metadata-action：tags 为 `<version>`（RELEASE_TAG 去 v 前缀）+ `latest`，images `ghcr.io/schovest/pi`
10. docker/build-push-action：
    - `context: .`
    - `contexts`: `linux-amd64: /tmp/pi-linux-x64/linux-x64`、`linux-arm64: /tmp/pi-linux-arm64/linux-arm64`
    - `platforms: linux/amd64,linux/arm64`
    - `push: true`，tags 来自 metadata-action

注意：`--skip-install` 跳过 npm ci、`--skip-build` 跳过 npm run build（因此 workflow 需显式先执行两者）；不传 `--skip-deps`，clipboard 原生依赖安装照常执行（`--no-save` 幂等），产物需包含 clipboard 原生库。

### 3. README 更新

在 "Permissions & Containerization" 一节新增小节「容器镜像部署」（中文文档环境，标题可中英混合，正文可英文以保持文档风格一致）：

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  ghcr.io/schovest/pi
```

内容：官方镜像地址、支持的平台（linux/amd64、linux/arm64）、tag 策略（`latest` + 版本号）、镜像内置内容（Node LTS + npm、git、ca-certificates）、挂载说明（`$PWD:/workspace`、`pi-agent-home` 卷存 `/root/.pi/agent`）。

### 4. `packages/coding-agent/docs/containerization.md` 同步

Plain Docker 一节补充：可直接使用官方镜像 `ghcr.io/schovest/pi`，替代自建 Dockerfile 的步骤。

### 5. CHANGELOG.md

`## [Unreleased]` 下 `### Added` 新增条目：容器镜像构建 workflow（ghcr.io/schovest/pi）与部署文档。

## 错误处理

- 二进制构建失败：workflow 直接失败，不产生镜像（buildx 步骤不会执行）。
- 镜像 push 失败：workflow 失败，不产生 GitHub Release 副作用（独立 workflow，与 build-binaries.yml 互不影响）。
- 手动 dispatch 指定不存在的 tag：checkout 失败，workflow 失败，行为与 build-binaries.yml 一致。

## 测试与验证

- 本地验证：`docker build` 语法正确性（buildx 多平台构建需要 GitHub Actions 环境，本地可单平台验证 Dockerfile COPY 逻辑）。
- CI 验证：workflow 触发后，`ghcr.io/schovest/pi:latest` 与版本 tag 均存在；`docker pull` 后可运行 `pi --help`。
- 文档验证：README 与 containerization.md 中的命令与镜像实际行为一致。

## 不做的事（YAGNI）

- 不做 Docker Hub 发布（未要求）。
- 不做源码多阶段构建（未要求，且镜像大、与发布二进制不一致）。
- 不做 main 分支 latest 镜像（未要求）。
- 不做容器内非 root 用户（保持与现有文档行为一致）。
- 不为 docker-image.yml 提取共享 workflow 抽象（仅两处使用，不值得）。
