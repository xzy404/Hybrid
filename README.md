# Hybrid Lock + Team Hack Contest

这是为 **Hydro v5.0.4** 实现的“个人 OI 题锁定 + 团队题 Hack”赛制 addon。它实现后端题目显隐、锁题不可逆、锁题后队内讨论、统一团队题池、Hack 配额、正确/错误 Hack 计分和团队榜单。

> 插件补丁依赖 Hydro v5.0.4 的比赛与题目处理器内部 API。升级 Hydro 前必须先在预发布环境回归测试，不可跳过。

## 本次更新（Hack 改为正解比对）

1. **Hack 判定改为「正解比对」**：修复了旧版本提交 hack 即报 `SE, 0 System Error: Cannot read properties of undefined (reading 'file')` 的问题。旧版本复用了 Hydro 核心 hack judge，而团队题没有配置 `validator`，导致评测端崩溃。
   - 现在管理员在 `/hybrid/manage` 为每道团队题配置「正解代码 + 语言」；
   - 选手提交 hack 输入后，系统分别用正解与被 hack 代码跑该输入，得到两份输出，做归一化比对（忽略行尾空格与末尾空行）；
   - 输出相同 → hack 失败；输出不同（或正解 AC 但被 hack 代码 RE/TLE/MLE）→ hack 成功；
   - 正解本身非 AC → 记为系统错误（`error`），不计成功也不计失败。
2. **Hack 成功的收尾逻辑修正**：成功 hack 后，把该 hack 输入作为题目新测试点、标准答案写为正解输出（此前误写为空输出 `/dev/null`），并用正确的 `hackRejudge` meta 对目标队伍的最新 AC 提交重测。
3. **Hack 记录展示**：hack 列表页新增「我的 Hack 记录」，实时显示评测中/成功/失败/系统错误结果。

> 注意：hack 评测改为在插件侧比对（走 pretest 评测），不再依赖 Hydro 核心 hack judge，因此团队题无需配置 `validator` / `checker` 也能正常 hack。

## 上一轮更新（相对上一修复版）

1. **管理配置支持题目编号**：`personalPid` / `teamPids` 既可填写题目序号（数字 docId，如 `15`），也可填写题目编号（字符串，如 `C1000`）。保存时统一通过 `ProblemModel.get` 解析为数字 docId 后存储（内部仍全链路数字，保证与 Hydro 核心类型严格比较兼容）；管理页回显配置时也会把数字 docId 还原为题目编号，方便阅读。填写了不存在的编号会报 `ValidationError: pids:<编号>`。
2. **移除「清理克隆题目」功能**：按需求删除了管理页的克隆题检测展示、一键清理入口及对应的后端路由（`/contest/<tid>/hybrid/manage/cleanup`）。

## 上一轮修复（相对 hybrid-query-tid-fix-final）

1. **pid 全链路改为数字 docId**：旧版本把 pid 以字符串写入 `tdoc.pids`，导致
   - Hydro 核心 `tdoc.pids.includes(pdoc.docId)`（数字严格比较）永远为 false → 打开题目报 `ContestNotFoundError`；
   - 题目列表 `$in` 查询匹配不到 → 选手端题目列表为空。
2. **移除团队题克隆逻辑**：旧版本在选手创建队伍时会把 5 道团队题 `ProblemModel.copy` 一份进题库并追加到 `tdoc.pids`，导致题库被污染、管理端题目列表团队题出现两遍。现在所有队伍共用管理员配置的统一题池，不再复制题目。
3. **管理页增强**：保存配置时校验每个 pid 对应题目确实存在；保存时重写 `tdoc.pids`，顺带清除历史版本写入的字符串 pid 等脏数据；比赛未配置时 `/hybrid` 显示友好提示而非报错。

## 从旧版本迁移

1. 部署本版本后重启 Hydro；
2. 打开 `/contest/<比赛ID>/hybrid/manage`，重新粘贴并保存一次 JSON 配置（会把 `tdoc.pids` 规范化为数字）。

> 旧版本克隆进题库的重复题目不再由插件清理，如需删除请在题库管理中手动处理。

## 安装

```bash
cd /绝对路径/hybrid-lock-hack-contest
yarn --production
hydrooj addon add /绝对路径/hybrid-lock-hack-contest
pm2 restart hydrooj
```

创建比赛时选择 **Hybrid Lock + Team Hack**，再于开赛前访问：

```text
/contest/<比赛ID>/hybrid/manage
```

粘贴完整 JSON 配置（示例，两种写法均可，可混用）：

```json
{
  "personalPid": "C1000",
  "teamPids": ["C1001", "C1002", "C1003", "C1004", "C1005"]
}
```

并在同页「团队题正解配置」为每道团队题选择语言、粘贴正解代码，一并保存。未配置正解的团队题无法被 hack。

选手从下列地址进入控制台：

```text
/contest/<比赛ID>/hybrid
```

所有比赛题建议设为隐藏。团队题为统一题池：所有队伍看到相同的 5 个 pid；Hack 成功的输入数据会追加为题目的一个测试点并对被 Hack 队伍的最新 AC 提交重测。
