# HarmonyRealApps

本目录维护供 ArkLifeguard 测试使用的鸿蒙真实应用清单，记录各项目的 Git 版本、声明的 SDK 版本和源码规模。

| 源码规模（`size.lines`，总物理行数） | 项目数 |
| ------------------------------------- | -----: |
| 少于 1,000 行                         |      3 |
| 1,000–9,999 行                        |     36 |
| 10,000–49,999 行                      |     15 |
| 50,000–99,999 行                      |      4 |
| 100,000 行及以上                      |      9 |
| 合计                                  |     67 |

`meta.json` 是真实应用集合的清单。每个项目只需要手动填写仓库地址：

```json
{
    "projects": [
        {
            "repo": "https://gitee.com/harmonyos_codelabs/OxHornCampus.git"
        },
        {
            "repo": "https://github.com/Z-P-J/AnimeZ.git"
        }
    ]
}
```

然后运行：

```bash
npm run sync:real-apps
```

脚本会克隆本地不存在的仓库，并更新 `meta.json`。对于已经存在的项目，脚本读取当前干净的工作区。

## 项目字段

| 字段                   | 含义                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `repo`                 | 仓库地址，唯一需要手动填写的字段。                                                               |
| `name`                 | 从仓库地址提取的项目名，也是本地目录名。                                                         |
| `path`                 | 项目目录相对于清单的路径，例如 `projects/AnimeZ`。                                               |
| `revision`             | 当前 Git 分支名，处于 detached HEAD 时记录完整提交哈希。                                         |
| `resolvedCommit`       | 当前 HEAD 的完整 Git 提交哈希。                                                                  |
| `compileSdkVersion`    | 项目根目录 `build-profile.json5` 声明的编译 SDK 版本。                                           |
| `compatibleSdkVersion` | 同一配置声明的兼容 SDK 版本。                                                                    |
| `targetSdkVersion`     | 同一配置声明的目标 SDK 版本。                                                                    |
| `size.lines`           | 物理行数，包含空白行和注释行。文件末尾的换行符只结束当前行，空文件计 0 行。                      |
| `size.nonBlankLines`   | 含至少一个非空白字符的行数，包含注释行。                                                         |
| `error`                | 同步失败的原因。失败条目只包含 `repo` 和 `error`，下次同步会重试。                               |

SDK 版本保留配置中的字符串或数字，缺失的字段记录为 `null`。
