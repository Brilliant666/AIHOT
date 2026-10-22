# DokiHot 公开部署

DokiHot 由 Brilliant666 独立维护，来源为 KKKKhazix/AIHOT，使用域名 `rardar.dokitool.com`。这是独立站点，并非上游官方服务。技术包名、数据库用户和 Compose 默认项目名仍保留 `aihot`。创建本 PR 不会修改该域名、服务器或已有服务。

这份文档对应小规模公开试运营。配置检查、CI、真实主机验收分别证明不同事情：CI 通过不代表 DNS/证书可用，也不代表与现有代理共存已经验收。

## 默认边界

- `PORT=127.0.0.1:3000`，只有 Caddy 的 80/443 对公众开放；数据库 5432、内部 API 3001 没有宿主机映射。80 用于证书验证及跳转，网站内容使用 HTTPS。
- `RESTART_POLICY=no`，初期手动运行。确定长期运营后，明确改为 `unless-stopped` 并重建相关容器才启用重启策略；setup 始终不自动重启。
- 采集、模型、飞书和 IndexNow 默认关闭，空站验收不需要真实 API key。已修复的反馈入口有尝试计数与图片解码并发保护；仍应观察请求量，应用层限制不替代运营者的入口防护。
- 所有服务都轮转容器日志，默认每份 10 MB、最多 3 份。CPU/内存/PID 限制仅针对**运行容器**，不限制构建进程。
- worker 有 515 秒停止窗口，允许付费请求和备份收尾，不用 `kill -9` 代替正常停止。

| 服务 | CPU 上限 | 内存上限 | 可覆盖变量 |
|---|---:|---:|---|
| db | 0.30 核 | 768 MiB | DB_CPUS / DB_MEMORY |
| api | 0.30 核 | 768 MiB | API_CPUS / API_MEMORY |
| worker | 0.50 核 | 1536 MiB | WORKER_CPUS / WORKER_MEMORY |
| web | 0.30 核 | 768 MiB | WEB_CPUS / WEB_MEMORY |
| caddy | 0.10 核 | 128 MiB | CADDY_CPUS / CADDY_MEMORY |
| setup（短时） | 0.50 核 | 512 MiB | SETUP_CPUS / SETUP_MEMORY |

常驻 CPU 上限合计 1.5 核、内存约 3.9 GiB，是为两核 Oracle 留出余量的初始配置，不是性能承诺。容器达到上限会变慢或退出；根据 `docker stats`、OOM/错误日志与页面延迟调整。内存交换上限与内存相同，避免容器额外使用 swap。运行前仍要考虑宿主系统、Docker 开销和其他进程。

## 1. 准备固定版本和配置

使用已经审查、完成 CI 的本 Fork 提交。在独立目录检出固定提交，记录完整 SHA，不在运行目录执行随意的 `git pull`。

```bash
git clone https://github.com/Brilliant666/AIHOT.git dokihot
cd dokihot
# 将下方占位文字替换为已通过审查和 CI 的完整提交 SHA。
git checkout '已验证的完整提交SHA'
node scripts/init-env.ts
chmod 600 .env
```

需要 Node 24.11+ 运行配置脚本；生产服务使用镜像内 Node。使用支持 `up --wait --wait-timeout` 的当前 Docker Compose 插件，部署命令会等待健康检查和 setup 完成（[Compose 启动依赖说明](https://docs.docker.com/compose/how-tos/startup-order/)）。Node 和 Docker/Compose 的安装应按当前操作系统的官方说明准备，并先核对现有网络规则，不能覆盖已有代理或 SSH 配置。初始构建优先在其他机器或 ARM64 CI 中完成，将测试过的 ARM64 镜像按不可变标签/摘要部署；不能因为上表有 CPU 上限，就认为本机 `docker compose build` 也受限。

`.env` 至少确认：

```dotenv
SITE_URL=https://rardar.dokitool.com
SITE_DOMAIN=rardar.dokitool.com
PORT=127.0.0.1:3000
TRUST_PROXY=true
RESTART_POLICY=no
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
```

保留初始化生成的管理员密码、会话/图片签名密钥与数据库密码。数据库密码必须为 URL-safe 字符，避免破坏连接 URL；初始化脚本已生成合适格式。不要将真实配置提交到 Git，也不要把 `docker compose config` 的完整输出贴到工单；验证结构用 `docker compose config --quiet`。

站名使用 DokiHot；Logo、联系信息、隐私说明、使用规则与信源名单由运营者在 `site/`、`industry/` 中确认。示例页面和示例信源不是已经完成的业务配置。全文展示只给明确允许全文的来源开启。

```bash
node scripts/check-public-deployment.ts
docker compose --profile https config --quiet
```

检查脚本只读 `.env`，不打印配置值，不连接数据库、DNS、Docker 或任何付费服务；它也不会打开采集开关。`--env path` 可检查其他配置文件。后续正式启用采集/模型时用 `--live` 复查；这个选项不会修改配置或启动服务。

此脚本不合并当前 shell 的环境变量，而 Compose 插值可能优先使用 shell 中导出的同名变量。`config --quiet` 只验证结构；部署前必须在受控终端核对实际渲染的 Compose 配置，特别是端口绑定、SITE_URL/SITE_DOMAIN、重启策略、镜像与资源限制，以及 api/worker 最终环境中的功能开关。完整渲染结果含密码，不能贴到聊天、提交到 Git 或保存为公开日志。使用 `--env path` 检查的文件也必须与 Compose 实际使用的 `.env` 一致；Compose 的 `--env-file` 插值文件不会自动替换服务中写明的 `env_file: .env`。

## 2. 空站预演，再开放 HTTPS

先保留 DNS/公网规则原状，启动内部服务并检查健康状态。若本机具备构建资源，可执行 build；否则通过 `APP_IMAGE=<固定标签或摘要>` 使用已经准备的匹配架构镜像并加 `--no-build`。

```bash
docker compose build
docker compose up -d --wait --wait-timeout 240 db setup api worker web
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

配置中的正式 HTTPS 地址用于链接和 Secure cookie；此时回环 HTTP 健康检查不等同于浏览器登录验收。真正登录/退出在 HTTPS 入口就绪后进行。

确认 80/443 无现有业务占用、目标 IP 正确、DNS 由运营者控制后再修改 DNS 与 Oracle 云端/主机入口规则。只增加所需 80/443 TCP；不要覆盖 SSH 22、24443 TCP/UDP 或其他现有规则。不要为了网站复用/重定向代理的 24443。若已有可信 HTTPS 反代，使用它并保留回环端口，不再启动第二套占用 80/443 的 Caddy。

```bash
docker compose --profile https up -d --no-deps caddy
curl --fail --retry 12 --retry-all-errors --retry-delay 5 --retry-max-time 120 https://rardar.dokitool.com/api/health
```

Caddy 根据 SITE_DOMAIN 申请和续期证书；此命令会联系证书服务并开放端口，只在部署阶段执行。Caddy 容器内通过 `web:3000` 访问网页服务。浏览器与 API 使用真实 HTTPS 域名，`TRUST_PROXY=true` 仅因读者不能绕过这条可信入口；不要再公开宿主机 3000，也不要把 3001/5432 映射出去。

在 Oracle 上共存的 systemhog 仍按其独立授权保持手动运行、整机目标约 25%、不开机自启。它会逐步调整内存，但不能作为突发内存保护。需要为构建暂时停止它时另行明确操作，不在本项目启动脚本里自动停止或改变其设置。

## 3. 首次公开验收

- 从真实浏览器通过 HTTPS 登录、退出、再次访问后台；复用旧 cookie 的 `/api/auth/check` 应返回 401，退出应清理 cookie 并回首页。检查 HTTPS cookie、反代请求头和 no-store 行为。
- 验证首页、详情、搜索、RSS 与健康端点；未登录不能访问管理 API，管理员写操作仍要求 CSRF。
- 核对反馈坏图请求/并发保护与图片下载额度的回归测试已通过；在预演环境使用合成数据验证 429/503，不向生产站发送压测流量。
- 确认公网不能访问 3000/3001/5432。核对新证书、DNS、服务器时钟和日志。
- 记录运行内存、CPU、容器重启/OOM、错误率、队列积压和磁盘增长；在少量信源下观察后再增加。确认 SSH 与 24443 TCP/UDP 代理仍可实际使用，仅监听端口存在不算代理验收。
- 完成本节之后的成对备份与隔离恢复；保存部署 SHA、镜像摘要和验收日期。没有完成的项目明确标为待验收。

## 4. 仅采集试运行，再决定是否启用模型

先在后台只启用 3 个经过确认的 RSS 信源，核对全文权限、抓取周期和历史回填范围。`COLLECT_ENABLED=true`、`MODEL_CALLS_ENABLED=false` 是仅采集模式：资料进入后台，等待后续处理；不消耗分析失败次数，也不创建新的公开文章投影。中文、缺正文的文章及遗留处理任务同样受此边界约束，后台重建不能绕过。已公开内容不会因关闭模型而全部消失，既有内容的撤回和权限收紧仍正常生效。

模型关闭时不注册自动报告生成任务，旧报告定时队列会清退；遗留的报告生成调用返回跳过，不把有意留在后台的资料当成上游故障反复报错。已经保存的报告仍可读取。以后明确启用模型后，待处理文章由正常扫描恢复处理，报告调度恢复；此操作不包含在初次采集验收中。

仅采集模式不允许把已有撤回/隔离记录重新提升为公开。如果已公开文章被采集器读到实质内容更新，该条暂时撤回，避免公开详情和全文RSS读到尚未处理的新正文；未变化的旧内容继续可用。此自动等待不写入管理员永久撤回决定，恢复模型并处理完成后可正常重新发布。

对已经公开的文章，如果本次只有HTML排版或图片列表变化、没有可处理的正文修订，仅采集期间保留旧展示，不覆盖这部分数据；恢复模型后再次读取来源才会应用。这样不会把新图片或排版内容绕过处理直接公开，也不承诺保存每一次展示变化的历史快照。

首批建议每源120分钟、`_aihot.initialBackfillLimit=3`、`sortByPublishedAt=true`，`publishedAfter`设为试运行前7天的固定UTC时刻。首次最多9条不是每天或后续轮次上限；后续抓取可补齐时间窗口内的其他条目。默认尊重人工间隔，仅设置`_aihot.adaptiveInterval=true`的源参与每日自动调频。暂停源不再参与图标抓取。详细配置见[信源说明](sources.md)。

实际启用前先备份并核对有效环境，只重建需要配置变更的worker，不操作共享反代、SSH、代理或systemhog。Compose `environment`会覆盖`env_file`，只改`.env`未必生效；`docker compose restart`也不会读取新环境。先做30–60分钟人工观察，再做24小时观察。核对信源/正文请求、队列、CPU/内存、数据库增长、公开详情/API/RSS无新增资料，付费回执仍为0；不要把本机RSS可读当作生产采集通过。

保持模型、付费采集、向量、飞书、IndexNow关闭且不填凭据。模型开关不阻止Jina等付费采集：需要零付费保险时，在后台将对应服务预算设为0；不要给`PAID_REQUESTS_*`环境变量填0，它们只接受正整数。`site_fulltext=false`限制公开展示，不禁止内部正文提取。仅采集模式不自动生成中文精选，也不是无模型RSS发布模式。

应用级 PAID_REQUESTS_PER_MINUTE/HOUR/DAY 与每服务预算都按**请求次数**限制，不等于金额或 token 上限；重试也会消耗请求次数。必须在实际模型供应商侧设定可用的消费/余额上限。数据库中的每服务预算同样需要确认，不能用删除预算行当成禁用。

工作队列并发通过 WORKER_CONCURRENCY_ANALYZE/FETCH/EXTRACT/DIGEST 启动时读取，改完需要重建 worker。仅采集试运行建议1/1/1/1。图片上游流量和并发由 IMGPROXY_UPSTREAM_MB_PER_MINUTE、IMGPROXY_UPSTREAM_GB_PER_DAY、IMGPROXY_MAX_CONCURRENCY 限制；这不是免费采集的总请求或流量上限，免费采集目前没有每日总量硬熔断。

CPU和内存配额是上限，不是预占资源：实际用量随负载变化，CPU超额受限速、内存到硬上限可能OOM退出。保留现有worker 0.5核/1536MiB等配额，先观察再决定是否调整，不通过增加资源替代采集边界。停止试采只执行`docker compose stop worker`，确认退出后再以采集关闭的配置重建；普通业务队列和数据保留，下次开启前应检查遗留手动任务。部署继续手动运行、不启用开机自启。

修改 `.env` 后先运行 `node scripts/check-public-deployment.ts --live`，然后通过 Compose 重建需要新环境变量的 api/worker/web 容器，验证 `/api/health` 的发布标识与后台配置。不要只运行 `docker compose restart`：它不会读取修改后的环境变量。

## 5. 成对备份与恢复演练

公开运行前准备可控的维护窗口和安全的异地存储。应用内每天自动异地备份仅在 DB_BACKUP_STORE_* 配置完整后生效；保留期由对象存储生命周期配置管理。不要把只留在同一服务器上的文件当作异地备份。

下面是在仓库根目录执行的 **Linux Bash 手动维护命令**。开始前确认 `.env` 与正在运行的配置一致，`git rev-parse HEAD` 是实际镜像对应提交，`docker compose images` 中 api/worker/web 使用同一个已验收镜像；备份不会自动捕获 shell 覆盖值或未提交源码。停止所有应用写入者后，把数据库和文件卷保存为同一组，避免分别取自不同时间。`stop` 保留容器和卷；不要运行 `down -v`。

```bash
set -euo pipefail
backup_dir="$(pwd)/.backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
docker compose --profile https stop caddy web api worker
docker compose exec -T db pg_dump -U aihot -d aihot --format=custom --no-owner > "$backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar setup -czf - -C /data --exclude=./backups . > "$backup_dir/files.tar.gz"
cp .env "$backup_dir/environment.env"
git rev-parse HEAD > "$backup_dir/commit.txt"
git archive HEAD > "$backup_dir/code.tar"
docker image inspect "$(docker compose images -q web)" --format '{{.Id}}' > "$backup_dir/image-id.txt"
docker image save "$(cat "$backup_dir/image-id.txt")" -o "$backup_dir/app-image.tar"
(cd "$backup_dir" && sha256sum database.dump files.tar.gz environment.env commit.txt code.tar image-id.txt app-image.tar > SHA256SUMS)
chmod 600 "$backup_dir"/*
docker compose exec -T db pg_restore --list < "$backup_dir/database.dump" > /dev/null
tar -tzf "$backup_dir/files.tar.gz" > /dev/null
docker compose --profile https start api worker web caddy
curl --fail --retry 12 --retry-all-errors --retry-delay 5 --retry-max-time 120 https://rardar.dokitool.com/api/health
```

把整组备份加密传到另一台机器/对象存储。environment.env 含密钥，必须与数据库、上传文件一样限制访问。Caddy 的证书卷也需要保留（或预先确认灾备时可重新申请证书）；不要删除原卷。备份命令中任何一步失败，应先检查已产生的文件和原因，不把半组备份标记成功。`set -e` 会在失败时退出，应用可能仍处于停止状态；排除问题后用上述 `start` 恢复原有容器并验收。备份期间不要更换代码或镜像；这里用 `start` 恢复既有容器，不触发配置重建或迁移。

恢复演练应在**另一台隔离机器**使用独立代码目录、Compose 项目名和全新数据卷，关闭采集、模型与推送，不开放公网。使用备份的 commit/code.tar 对应代码；生成演练专用 `.env`，不直接使用含生产凭证的 environment.env。清空模型、采集、飞书、对象存储等外部服务凭证。不要把演练目录指向生产数据卷。首次数据恢复只启动 API/web，保持 worker 停止：备份中可能存在待处理队列，关闭采集不等于禁止其他后台任务处理恢复数据。

```bash
# 在隔离恢复机、固定代码版本目录内；.env 使用演练专用密钥、回环地址和 false 开关。
set -euo pipefail
(cd /secure-backup && sha256sum --check SHA256SUMS)
docker image load -i /secure-backup/app-image.tar
export APP_IMAGE="$(cat /secure-backup/image-id.txt)"
docker compose -p dokihot-restore up -d --wait --wait-timeout 180 db
docker compose -p dokihot-restore exec -T db pg_restore -U aihot -d aihot --no-owner --exit-on-error < /secure-backup/database.dump
docker compose -p dokihot-restore run --rm --no-deps -T --entrypoint tar setup -xzf - -C /data < /secure-backup/files.tar.gz
docker compose -p dokihot-restore up -d --no-build --wait --wait-timeout 240 setup api web
curl --fail http://127.0.0.1:3000/api/health
```

恢复目标必须是新建的空数据库/数据卷；脚本不会清空已有数据库。恢复后核对文章数量、实际本地图片/上传文件可读、管理员登录和健康状态，记录结果，再结束演练。演练地址若是回环 HTTP，使用对应的 `SITE_URL=http://localhost:3000` 和 `TRUST_PROXY=false`；公开部署的 HTTPS 配置检查不适用于此隔离地址。外部图片或信源访问、worker 队列处理另用合成数据验收，不用恢复的真实任务试跑。`pg_restore --list` 和 tar 能列出文件仅证明归档可读取，不能代替这次实际恢复。

## 6. 升级、回退与停止

升级流程：固定新 SHA/镜像 → 完成测试 → 成对备份 → 停止旧 API/worker/web → 执行 setup 迁移 → 启动 → 健康和业务验收。保留前一版本代码、镜像及匹配的备份；迁移包含结构变化时，回退需要旧代码与旧数据库/文件成对恢复，不能仅切回旧镜像。

```bash
docker compose --profile https stop caddy web api worker
docker compose run --rm setup
docker compose --profile https up -d --wait --wait-timeout 240 api worker web caddy
curl --fail --retry 12 --retry-all-errors --retry-delay 5 --retry-max-time 120 https://rardar.dokitool.com/api/health
```

需要回退时，先停止新版本应用，保留其容器、数据库和文件卷供排查。按照上一节把匹配的旧代码、镜像与成对备份恢复到另一台隔离机器验收；同机恢复则必须另建 `dokihot-rollback` 项目和数据卷，将临时 `PORT` 设为 `127.0.0.1:3002`，健康检查也改到 3002。旧数据通过核对后，仍在该恢复目录以相同项目名继续操作：恢复正式 HTTPS 地址、原签名密钥及按需外部凭证，通过配置检查，确认旧入口 Caddy 已停止，再手动启动该恢复项目的 HTTPS 入口。不要将恢复命令直接指向正在使用的 `aihot` 数据卷。

```bash
# 在已恢复并验收的同机旧版本目录；.env 已恢复正式 HTTPS 配置，旧 Caddy 已停止。
node scripts/check-public-deployment.ts
docker compose -p dokihot-rollback --profile https up -d --no-build --wait --wait-timeout 240 api worker web caddy
curl --fail --retry 12 --retry-all-errors --retry-delay 5 --retry-max-time 120 https://rardar.dokitool.com/api/health
```

这一步会恢复旧版本服务并处理恢复的队列；先保持采集、模型和推送关闭，核对 SSH、24443 代理与站点业务后，再按第 4 节启用。若生产已启用外部请求，回退数据库也会回退本地额度账本，供应商账单不会回退；保留其消费上限，不立即重放全部积压任务。

迁移失败时停止推进，不启动新业务容器；不要跳过迁移账本或手工改历史迁移。正常手动停止整套项目用 `docker compose --profile https stop`，数据卷保留。后续若选择 `RESTART_POLICY=unless-stopped`，记录该选择；它只控制本项目容器，与 systemhog 的开机策略互不关联。
