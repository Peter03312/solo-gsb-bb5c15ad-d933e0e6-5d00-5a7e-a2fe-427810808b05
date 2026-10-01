# 离心转子配平（Rotor Balance）

实验室离心转子装载配平 Web 应用：录入转子参数、本次离心管称重数据与可选配重块，
系统按约束求**可行装载图**，优化目标依次为：

1. **配重块使用数量最少**；
2. **各对对径孔质量差之和最小**；
3. 目标完全相同时，按**孔位编号对应的物件编号序列字典序取小**
   （次序约定：离心管编号 → 配重块 `质量组#组内序号` → 空孔；即小编号离心管优先占据低编号孔位）。

无解时明确列出原因。发布时在**单个数据库事务**内重读当前数据、重新求解并用独立校验器复核，
通过后冻结装载图及其数据依据（哈希）。此后录入数据的任何修改**不会改动旧图**，
但旧图会被标记为「**不可用于当前装载**」。

**现场装载核验**：现场按已发布装载图核验实际装载。选择一条「可用于当前装载」的发布记录，
按孔位录入实际物件编号与有限正数实测质量（空孔保持为空、质量 0）。草稿可暂存并恢复；
同一发布记录只保留一份未完成核验；更新须携带版本号，服务端以乐观锁拒绝覆盖他人的修改
（`409` 并回传当前草稿）。完成时在**同一事务**内重读发布快照与当前数据，逐项判定：

- 各孔实际物件编号必须与冻结图一致（错位/缺件/多件均定位到**孔位**）；
- 实测质量不得超过对应孔的最大承重（定位到**孔位**）；
- 各对径孔实测质量差不得超过冻结容差（定位到**孔对**）；
- 发布记录的数据指纹仍与当前录入一致（仍可用于当前装载）。

核验不通过时原因定位到孔位/孔对，**草稿保留且不生成完成记录**；通过后冻结实测值、逐孔/逐对
判定明细与发布编号。完成是**幂等**的：重复完成返回同一份冻结结果、不产生第二份记录；
此后再修改录入数据不会改写已完成核验。


## 约束模型

- 孔位编号 `0 … N-1`，孔位数 N 为 4–12 的偶数；孔 `i` 与孔 `i + N/2` 对径。
- 每孔**最多一件**物件（一支离心管或一枚配重块），空孔质量按 0 计。
- 全部离心管**必须装入**；每枚配重块**最多使用一次**。
- 任一孔内物件质量不得超过该孔最大承重；离心管只能放入其声明的可用孔位。
- 每对对径孔的质量差不得超过允许对径差（容差）。
- 非法质量（非数、≤0 等）、重复编号、孔位越界一律拒绝，**不留下任何部分数据**
  （整表替换在一个 SQLite 事务中完成，校验失败即回滚）。

求解算法：按对径孔对逐对做动态规划（状态 = 已用离心管位图 + 各配重组已用数量），
同状态只保留目标三元组最优的路径（Pareto 保优），规模上界 N=12。

## 一键启动（Docker Compose）

前置要求：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

首次启动会自动：

1. 安装全部依赖（容器内编译 better-sqlite3 原生模块）；
2. 初始化 SQLite 数据库与全部表结构（服务启动时自动建表，无需手工脚本）。

访问地址：

- **http://localhost:8080** （浏览器界面）

停止 / 查看日志：

```bash
docker compose down        # 停止（数据卷保留）
docker compose logs -f     # 查看日志
```

数据持久化在命名卷 `rotor-data`（容器内 `/app/data/rotor.db`）。
如需彻底清空：`docker compose down -v`。

## 本地直接运行（不使用 Docker）

需要 Node.js ≥ 20；better-sqlite3 为原生模块，首次安装需要 Python 3 / make / g++。

```bash
npm install
npm start
```

运行测试：

```bash
npm test
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内）；Compose 中可用同名变量改主机映射端口，如 `PORT=9090 docker compose up -d` |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/rotor.db`（本地）/ `/app/data/rotor.db`（容器） | SQLite 数据库文件路径，目录不存在会自动创建 |

## 使用流程

1. **转子配置**：选择孔位数（4–12 偶数）、允许对径差（g）、各孔最大承重，保存。
2. **离心管**：逐行录入编号、称重质量、可用孔位（勾选），保存后自动配平。
3. **配重块**：按“质量 + 数量”录入每种可选配重规格（同质量自动归为一组），保存后自动配平。
4. **装载图草稿**：保存任一类数据后自动重算；称重或配重数据变化后，旧草稿显示
   「基于旧数据」警示且**禁止直接发布**，须点「按当前数据重算」。
5. **发布**：点「发布并冻结」。服务端在事务内重新读取当前数据 → 重新求解 →
   独立复核（承重、容差、管全装入、配重不超量、孔位可用、质量一致）→ 写入冻结记录。
   无解时拒绝发布并给出原因。
6. **已发布装载图**：列表中每条记录带状态徽标：
   - ✓ 可用于当前装载：记录的数据指纹与当前录入完全一致；
   - ✗ 不可用于当前装载：录入数据已变化；旧图内容保持冻结不变，可点开查看其当时的数据快照。
7. **现场装载核验**：在「已发布装载图」点「现场核验」（或在第 6 节打开已有核验）：
   - 按孔位逐行核对/录入实际物件编号与实测质量；空孔保持为空（质量自动按 0，无需录入）。
   - 页面实时显示录入进度、逐孔提示（错件/超承重/重复编号）与各对径孔实测差预览。
   - 「暂存草稿」可随时中断并在之后恢复；同一发布记录只有一份草稿，版本过期会提示并恢复最新版。
   - 「完成核验并冻结」在服务端事务内复核；不通过时弹窗给出定位到孔位/孔对的原因并保留草稿；
     通过后冻结结果。已完成核验只读，重复完成不生成新结果。

## 现场核验 HTTP API 与调用示例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/verifications` | 全部核验记录（含草稿/完成状态、进度与发布可用性） |
| GET | `/api/publications/:id/verification` | 某发布记录的核验（草稿或已冻结结果），无则 `verification:null` |
| PUT | `/api/publications/:id/verification` | 创建（首次无需 `version`）或更新（须带 `version`）核验草稿 |
| POST | `/api/publications/:id/verification/complete` | 携带 `version` 完成核验；事务内复核并冻结，重复完成幂等 |

`PUT` 请求体：`{"version": 1, "entries": [{"hole":0,"ref":"A","mass":50.2}, …]}`。
条目数组长度必须等于孔位数且按孔位升序；空孔为 `{"hole":h,"ref":"","mass":0}`，
实占孔的 `ref` 为实际物件编号、`mass` 为有限正数。首次创建返回 `201`，更新返回 `200`，
响应中的 `verification.version` 为最新版本（每次保存/完成自增）。
完成请求体：`{"version": <草稿当前版本>}`。

状态码：`400` 录入非法或核验不通过（`errors` 中原因定位到孔位/孔对，草稿保留）；
`409` 版本冲突或核验已冻结（响应体 `current` 为服务器最新草稿/结果，可据此恢复）；
`404` 发布记录不存在。发布记录已不可用于当前装载时，创建/更新草稿与完成核验均返回 `400`。

curl 示例（4 孔、冻结图为孔 0=A、孔 2=B，孔 1/3 空）：

```bash
BASE=http://localhost:8080

# 1) 首次暂存草稿（空条目；空孔 ref 为空、质量 0）
curl -s -X PUT $BASE/api/publications/1/verification \
  -H 'Content-Type: application/json' \
  -d '{"entries":[
    {"hole":0,"ref":"","mass":0},
    {"hole":1,"ref":"","mass":0},
    {"hole":2,"ref":"","mass":0},
    {"hole":3,"ref":"","mass":0}]}'
# -> 201 {"ok":true,"created":true,"verification":{"status":"draft","version":1,...}}

# 2) 录入实测并暂存（更新须带 version）
curl -s -X PUT $BASE/api/publications/1/verification \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"entries":[
    {"hole":0,"ref":"A","mass":50.2},
    {"hole":1,"ref":"","mass":0},
    {"hole":2,"ref":"B","mass":50.3},
    {"hole":3,"ref":"","mass":0}]}'
# -> 200 {"ok":true,"verification":{"version":2,...}}

# 3) 完成核验（事务内复核 + 冻结）
curl -s -X POST $BASE/api/publications/1/verification/complete \
  -H 'Content-Type: application/json' -d '{"version":2}'
# -> 200 {"ok":true,"verification":{"status":"completed","result":{"passed":true,
#        "details":{"holes":[...逐孔判定...],"pairs":[...逐对判定...]}, ...}}}

# 不通过示例（孔 0 录成 B，且对径差超限）：
# -> 400 {"errors":["孔 0 物件不一致：冻结图要求「A」，实际录入「B」",
#                   "孔 2 物件不一致：冻结图要求「B」，实际录入「A」",
#                   "对径孔对（0 ↔ 2）实测质量差 5.5 超过冻结容差 1"]}
# 草稿保持原版本不变，不产生完成记录。

# 4) 版本冲突：他人已先存（当前版本 3），你仍带 version=2
# -> 409 {"error":"版本已过期…","current":{ ...服务器最新草稿... }}

# 5) 重复完成：幂等返回已冻结结果
curl -s -X POST $BASE/api/publications/1/verification/complete \
  -H 'Content-Type: application/json' -d '{"version":3}'
# -> 200 {"ok":true,"repeated":true,"verification":{ ...同一份冻结结果... }}
```

## REST API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前录入数据、数据指纹、草稿（含是否过期）、发布列表 |
| PUT | `/api/config` | 整体替换转子配置（孔位数、容差、各孔最大承重），事务 |
| PUT | `/api/tubes` | 整体替换全部离心管，事务，校验失败回滚 |
| PUT | `/api/weights` | 整体替换全部配重规格，事务，校验失败回滚 |
| POST | `/api/solve` | 按当前数据重算草稿 |
| POST | `/api/publish` | 事务内求解 + 独立复核 + 冻结发布；无解返回 400 |
| GET | `/api/publications` | 发布记录列表（含当前可用性标记） |
| GET | `/api/publications/:id` | 单条冻结记录详情（含发布时数据快照） |
| GET | `/api/verifications` | 全部现场核验记录（草稿/冻结结果、进度、发布可用性） |
| GET | `/api/publications/:id/verification` | 单条核验（草稿或已冻结结果），无则 `verification:null` |
| PUT | `/api/publications/:id/verification` | 创建/暂存核验草稿（更新须带 `version` 乐观锁） |
| POST | `/api/publications/:id/verification/complete` | 事务内复核并冻结；不通过 400 且保留草稿；重复完成幂等 |

错误统一返回 `400 {"error","errors":[...]}`；版本冲突/已冻结返回 `409`（含 `current`）。

## 目录结构

```
src/
  server.js       Express 服务与路由、原子发布/核验事务
  db.js           SQLite 连接、建表、数据访问
  solver.js       求解器、独立复核、数据指纹（纯函数，含测试）
  validate.js     输入校验（非法质量/重复编号/越界）
  verification.js 现场核验：草稿录入校验 + 完成时事务判定（纯函数，含测试）
public/           浏览器界面（原生 HTML/CSS/JS，无需构建）
test/             node --test 测试（求解器 + HTTP API + 核验，共 45 项）
Dockerfile / docker-compose.yml
```
