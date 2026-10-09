# 一键 NAS 后台大小过滤

油猴脚本 2.8.5 起，一键 NAS 使用 `qbit-upload filter-torrents` 的后台过滤流程。添加成功后显示“已提交”，可以关闭网页，不需要等待磁力元数据。

使用前需运行 NAS 后台过滤服务，并让 `torrent_filter.tag` 使用 `filter-small`。文件大小阈值由该服务的 `torrent_filter.min_size_mb` 配置，浏览器不读取或固定阈值。

在油猴菜单“设置 NAS qBittorrent 地址”中填写 WebUI 地址。支持反向代理路径，认证沿用现有 WebUI 登录或访问控制。

入口先检查 `/api/v2/app/version`，支持 qBittorrent 4.5+ 和 5.x。随后在同一次 `POST /api/v2/torrents/add` 请求中提交：

| 字段 | 值 |
| --- | --- |
| `urls` | 当前磁力链接 |
| `tags` | `filter-small` |
| `stopCondition` | `MetadataReceived` |
| 4.x：`paused` / 5.x：`stopped` | `false` |

qBittorrent 先获取元数据，收到后停止；NAS 后台服务完成筛选和回读核验后启动下载。入口只确认添加成功，不轮询元数据，也不直接启动下载。后台服务未运行时，任务会在元数据到达后保持停止。

版本不支持、无法确认版本、添加失败时显示“添加失败”，不会退回普通下载流程。这里仅支持磁力提交；上传 `.torrent` 文件需以停止状态添加。
