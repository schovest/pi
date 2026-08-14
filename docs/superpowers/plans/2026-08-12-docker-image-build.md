# 容器镜像构建 Action 与部署文档 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 GitHub Actions workflow 将 pi 构建为多平台 OCI 镜像并发布到 `ghcr.io/schovest/pi`，更新 README 与 containerization.md 新增容器镜像部署方法。

**Architecture:** 独立 workflow `docker-image.yml` 复用 `scripts/build-binaries.sh` 产出 linux-x64/arm64 预编译二进制目录，通过 buildx 命名 context（`linux-amd64`/`linux-arm64`）配合 Dockerfile 的 `COPY --from=linux-$TARGETARCH` 选择对应平台产物，最终 push 到 ghcr.io。基础镜像 `node:24-bookworm-slim`（自带最新 LTS Node + npm）。

**Tech Stack:** GitHub Actions（checkout/setup-bun/setup-node/setup-qemu/setup-buildx/login/metadata/build-push）、docker/build-push-action、Bun 编译二进制、Dockerfile 多阶段多平台。

**Spec:** `docs/superpowers/specs/2026-08-12-docker-image-build-design.md`

## Global Constraints

- 镜像发布到 `ghcr.io/schovest/pi`（GITHUB_TOKEN，`permissions: packages: write`），不发布 Docker Hub。
- 构建方式为 COPY 预编译二进制（复用 build-binaries.sh），不做源码多阶段构建。
- 触发：push `v*` tag + workflow_dispatch（`tag` 必填、`source_ref` 可选，模式与 build-binaries.yml 一致）。
- 基础镜像 `node:24-bookworm-slim`（自带最新 LTS npm；Bun 二进制需 glibc，不用 alpine）。
- 平台：linux/amd64 + linux/arm64。
- tag 策略：`<版本号>`（RELEASE_TAG 去 `v` 前缀）+ `latest`（仅 tag 触发时）。
- 容器内默认 root 运行（与 containerization.md 现有 Plain Docker 文档行为一致）。
- Dockerfile 的 `FROM` 必须用 `--platform=$TARGETPLATFORM`（apt 装的 git 必须是目标架构）。
- 每次 `build-binaries.sh` 调用会清空 `--out` 目录，两个平台必须用不同 `--out`。
- 运行期系统依赖仅 `git` + `ca-certificates`。
- AGENTS.md：功能 commit 必须同步更新 `packages/coding-agent/CHANGELOG.md`（`## [Unreleased]` 下 `### Added`）；变更完成后自查 `packages/coding-agent/docs/`。
- 本机无 docker：Dockerfile/buildx 逻辑无法本地构建验证，靠语法核对 + CI 验证。

---

### Task 1: Dockerfile + docker-image.yml workflow + CHANGELOG

**Files:**

- Create: `Dockerfile`（仓库根目录）
- Create: `.github/workflows/docker-image.yml`
- Modify: `packages/coding-agent/CHANGELOG.md`（`## [Unreleased]` 下新增 `### Added` 条目）

**Interfaces:**

- Consumes: `scripts/build-binaries.sh`（`--skip-install --skip-build --platform <p> --out <dir>`，输出 `<out>/<platform>/` 目录内含 `pi` 可执行文件及共享文件）；`npm run build` 产物 `packages/coding-agent/dist/`。
- Produces: 根目录 `Dockerfile`（命名 context `linux-amd64`/`linux-arm64` 指向各平台二进制目录）；`ghcr.io/schovest/pi:<version>` + `:latest` 镜像。Task 2 的 README 引用 `ghcr.io/schovest/pi`。

- [ ] **Step 1: 创建 `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$TARGETPLATFORM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY --from=linux-$TARGETARCH / /opt/pi
ENV PATH="/opt/pi:$PATH"

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

说明：`COPY --from=linux-$TARGETARCH` 引用 buildx 命名 context（workflow 中定义），构建 linux/amd64 时解析为 `linux-amd64`，linux/arm64 时为 `linux-arm64`。

- [ ] **Step 2: 创建 `.github/workflows/docker-image.yml`**

```yaml
name: Docker Image

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag to build (e.g., v0.13.8)'
        required: true
        type: string
      source_ref:
        description: 'Source ref to build/publish (defaults to tag; use only for release recovery)'
        required: false
        type: string

permissions: {}

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    env:
      RELEASE_TAG: ${{ github.event.inputs.tag || github.ref_name }}
      SOURCE_REF: ${{ github.event.inputs.source_ref || github.event.inputs.tag || github.ref_name }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ env.SOURCE_REF }}
          persist-credentials: false

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci --ignore-scripts

      - name: Build packages
        run: npm run build

      - name: Build linux-x64 binaries
        run: ./scripts/build-binaries.sh --skip-install --skip-build --platform linux-x64 --out /tmp/pi-linux-x64

      - name: Build linux-arm64 binaries
        run: ./scripts/build-binaries.sh --skip-install --skip-build --platform linux-arm64 --out /tmp/pi-linux-arm64

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image version
        id: version
        run: |
          VERSION="${RELEASE_TAG}"
          VERSION="${VERSION#v}"
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/schovest/pi
          tags: |
            type=raw,value=${{ steps.version.outputs.version }}
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          build-contexts: |
            linux-amd64=/tmp/pi-linux-x64/linux-x64
            linux-arm64=/tmp/pi-linux-arm64/linux-arm64
          file: Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

要点：

- 两次 `build-binaries.sh` 必须不同 `--out`（脚本会清空输出目录）；`--skip-install --skip-build` 跳过已执行的 npm ci / npm run build；不传 `--skip-deps`（产物需 clipboard 原生库，`--no-save` 幂等）。
- 命名 context 路径为 `<out>/<platform>/`（脚本构建后解压目录所在位置）。
- `latest` tag 仅在 `github.ref` 为 tag 时启用（workflow_dispatch 不覆盖 latest）。

- [ ] **Step 3: 更新 `packages/coding-agent/CHANGELOG.md`**

在 `## [Unreleased]` 下新增：

```markdown
## [Unreleased]

### Added

- 容器镜像发布：新增 `.github/workflows/docker-image.yml` 与根目录 `Dockerfile`，tag 触发或手动 dispatch 将 pi 构建为多平台镜像（linux/amd64、linux/arm64）并发布到 `ghcr.io/schovest/pi`（`<版本号>` + `latest` tag）；镜像基于 `node:24-bookworm-slim`（内置最新 LTS Node + npm），内置 `git`/`ca-certificates`，部署方式见 README「Container Image」与 `docs/containerization.md`
```

- [ ] **Step 4: 验证 YAML 语法与 Dockerfile 逻辑**

Run:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-image.yml')); print('workflow yaml OK')"
```

Expected: `workflow yaml OK`，无异常。

人工核对：

- `Dockerfile`：`--platform=$TARGETPLATFORM` 已用（非 BUILDPLATFORM）；`COPY --from=linux-$TARGETARCH` 与 workflow `contexts` 中 `linux-amd64`/`linux-arm64` 名字对应。
- workflow 中 `--out` 路径与 `contexts` 路径一致（`/tmp/pi-linux-x64/linux-x64`、`/tmp/pi-linux-arm64/linux-arm64`）。

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .github/workflows/docker-image.yml packages/coding-agent/CHANGELOG.md
git commit -m "feat: 容器镜像构建 workflow 与 Dockerfile（ghcr.io/schovest/pi，linux/amd64+arm64）"
```

---

### Task 2: README 与 containerization.md 部署文档

**Files:**

- Modify: `README.md`（"Permissions & Containerization" 一节内新增 "Container Image" 子节）
- Modify: `packages/coding-agent/docs/containerization.md`（"Plain Docker" 一节补充官方镜像用法）

**Interfaces:**

- Consumes: Task 1 发布的镜像 `ghcr.io/schovest/pi`、tag 策略（`latest` + `<版本号>`）、镜像内置内容（Node LTS + npm、git、ca-certificates）、支持平台（linux/amd64、linux/arm64）。
- Produces: README「Container Image」子节（部署方法）、containerization.md Plain Docker 官方镜像替代方案。

- [ ] **Step 1: 更新 `README.md`**

在 "## Permissions & Containerization" 一节末尾（"Plain Docker" 条目之后、"## Quick Install" 之前）追加：

````markdown
### Container Image

An official container image is published to GitHub Container Registry:

- **Image**: `ghcr.io/schovest/pi`
- **Platforms**: linux/amd64, linux/arm64
- **Tags**: `latest` plus a version tag per release (e.g. `0.13.8`)
- **Bundled**: the `pi` binary with a Node.js LTS runtime (including npm) for extension installation, `git`, and `ca-certificates`

Run pi in a container:

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  ghcr.io/schovest/pi
```

`-v "$PWD:/workspace"` mounts your current directory into the container so reads and writes in `/workspace` directly affect your host files. Use a named volume for `/root/.pi/agent` to keep container-local settings and sessions; mounting your host `~/.pi/agent` exposes host auth and session files to the container. The container runs as root by default, matching the Plain Docker pattern in [containerization.md](packages/coding-agent/docs/containerization.md).
````

- [ ] **Step 2: 更新 `packages/coding-agent/docs/containerization.md`**

在 "## Plain Docker" 一节开头（`Dockerfile.pi` 示例之前）插入：

````markdown
Instead of building your own image, use the official image `ghcr.io/schovest/pi` (linux/amd64 and linux/arm64, bundles the `pi` binary with a Node.js LTS runtime including npm, `git`, and `ca-certificates`):

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  ghcr.io/schovest/pi
```

If you need a custom image, build your own with `Dockerfile.pi`:
````

- [ ] **Step 3: 自查 `packages/coding-agent/docs/` 一致性**

检查 `packages/coding-agent/docs/docs.json` 中 containerization.md 的条目（如存在标题索引）是否需同步；确认无其他 docs 文件引用 Plain Docker 自建方式的描述与本变更冲突。

- [ ] **Step 4: Commit**

```bash
git add README.md packages/coding-agent/docs/containerization.md
git commit -m "docs: README 与 containerization.md 新增容器镜像部署方法（ghcr.io/schovest/pi）"
```

---

## Self-Review

**1. Spec coverage:**

- 独立 workflow + 根目录 Dockerfile → Task 1 Step 1-2 ✓
- ghcr 发布、GITHUB_TOKEN、packages: write → Task 1 Step 2 ✓
- tag 触发 + 手动 dispatch → Task 1 Step 2 ✓
- node:24-bookworm-slim（LTS npm）、glibc、git/ca-certificates → Task 1 Step 1 ✓
- linux/amd64 + linux/arm64、命名 context + TARGETARCH → Task 1 Step 1-2 ✓
- tag 策略 `<版本号>` + `latest`（仅 tag）→ Task 1 Step 2 ✓
- README 部署方法 → Task 2 Step 1 ✓
- containerization.md 同步 → Task 2 Step 2 ✓
- CHANGELOG Added 条目 → Task 1 Step 3 ✓

**2. Placeholder scan:** 无 TBD/TODO/占位符；所有代码块均为完整内容。

**3. Type consistency:**

- `TARGETARCH` 与命名 context `linux-$TARGETARCH`（amd64/arm64）在 Dockerfile 与 workflow 中一致。
- `RELEASE_TAG`/`SOURCE_REF` 命名与 build-binaries.yml 一致。
- `--out` 路径（`/tmp/pi-linux-x64`）与 `contexts` 路径（`/tmp/pi-linux-x64/linux-x64`）前缀一致。
- `ghcr.io/schovest/pi` 在 Task 1（workflow images）与 Task 2（README/docs）中一致。
