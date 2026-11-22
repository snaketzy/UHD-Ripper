# UHD-Ripper

基于 MakeMKV + FFmpeg 的 UHD/BD 原盘视频/音频/字幕轨道分离 Web 系统。输入 ISO 镜像或已解密的 BDMV 光盘根目录，选择 Title 后自动解密提取并按轨道分离为独立文件，输出目录可直接供 [convert-video-to-hls](../convert-video-to-hls) 等下游项目消费。

## 功能

- 选择 ISO 镜像文件或 BDMV 光盘根目录（原生文件/目录选择框，或直接粘贴绝对路径）
- 调用本机安装的 MakeMKV（`makemkvcon`）扫描光盘，列出全部 Title（时长、章节数、大小、音频语言、字幕数），并自动推荐体积最大的 Title 为「主标题」
- 可多选 Title，批量调用 MakeMKV 解密生成 MKV（过程含 AACS/AACS2/BD+ 解密，进度实时展示）
- 解密完成后自动用 `ffprobe` 解析轨道参数，与 Title 一一对应展示视频/音频/字幕轨道详情
- 按轨道勾选导出：视频/音频优先无损复制（`-c copy`），PGS 图形字幕原样导出为 `.sup`，文本字幕可选 SRT / WebVTT
- 多个 Title 可一次性批量导出，每个 Title 的结果写入 `<输出根目录>/<Title 名>/` 独立子目录

## 依赖

- **MakeMKV**：负责 UHD/BD 原盘的 AACS/AACS2/BD+ 解密与 Title 提取，本系统不包含任何解密逻辑，完全依赖本机安装的 `makemkvcon`
  - macOS：从 https://www.makemkv.com/download/ 下载安装 MakeMKV.app（本系统会自动在 `/Applications/MakeMKV.app/Contents/MacOS` 下查找 `makemkvcon`）
  - Linux：参考发行版的 MakeMKV 安装方式，确保 `makemkvcon` 在 `PATH` 中
  - MakeMKV 处于长期 Beta，需定期在 [MakeMKV 论坛](https://www.makemkv.com/forum/) 获取免费 Beta Key 并在 MakeMKV 设置中更新，否则解密会失败
- **FFmpeg / FFprobe**：负责轨道解析与导出，优先使用系统已安装版本（`brew install ffmpeg`），未安装时自动回退到 npm 依赖 `ffmpeg-static` / `ffprobe-static` 自带二进制
- Node.js >= 18.18（建议 20+）

## 安装

```bash
npm install
```

## 运行

开发模式（后端 8090 + 前端 Vite 5171，已配置 `/api` 代理）：

```bash
npm run dev
```

生产模式（构建前端后由后端统一托管）：

```bash
npm run serve
```

启动后访问 http://127.0.0.1:8090 。查看 FFmpeg/FFprobe/MakeMKV 就绪状态：`curl http://127.0.0.1:8090/api/health`

## 使用流程

1. 点击「选择 ISO 文件」或「选择 BDMV 文件夹」，或直接粘贴绝对路径，点击「解析光盘」
2. 在 Title 列表中勾选需要提取的 Title（默认已勾选推荐的主标题），点击「提取所选 Title」
3. 提取完成后，在「轨道参数」中为每个 Title 勾选需要导出的视频/音频/字幕轨道；多 Title 时可用「应用到全部」统一配置
4. 在「导出到本地目录」选择输出根目录，点击「开始批量导出」

## 目录结构

```
server/          后端：Express + MakeMKV + FFmpeg
  src/lib/binaries.js       ffmpeg/ffprobe/makemkvcon 路径解析
  src/lib/disc.js           调用 makemkvcon 扫描光盘 / 解密提取 Title
  src/lib/ripRunner.js      批量提取 Title 的串行执行器
  src/lib/probe.js          ffprobe 输出归一化
  src/lib/export.js         导出计划与 FFmpeg 执行（含进度解析）
  src/lib/batch.js          批次导出串行执行器与取消
  src/lib/jobs.js           光盘扫描/提取/媒体/导出任务注册表
  src/lib/folderPicker.js   macOS 原生文件/目录选择（osascript）
  src/routes/api.js         HTTP 接口
  data/rips/                MakeMKV 解密生成的 MKV 暂存目录（随任务过期自动清理）
  data/uploads/             本地文件直传的暂存目录（兜底入口）
web/             前端：React 19 + Vite + Tailwind CSS + shadcn/ui + Redux Toolkit
  src/components/DiscSourceCard.tsx   光盘来源选择、Title 列表与提取进度
  src/components/TrackTables.tsx      轨道参数与勾选
  src/components/ExportCard.tsx       导出目录与批量导出进度
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | FFmpeg/FFprobe/MakeMKV 就绪状态与版本 |
| GET | `/api/config` | 目录选择支持情况、上传上限、每批数量上限、默认输出目录 |
| POST | `/api/disc/pick-source` | 调起原生选择框，`{ kind: 'iso' \| 'folder' }` |
| POST | `/api/disc/scan` | 扫描光盘，`{ sourcePath }`，返回 Title 列表 |
| GET | `/api/disc/:id` | 重新获取某次光盘扫描结果 |
| POST | `/api/disc/:id/rip` | 发起批量提取，`{ titleIds: number[] }` |
| GET | `/api/disc/rip/:id` | 查询提取进度 |
| POST | `/api/disc/rip/:id/cancel` | 取消提取 |
| POST | `/api/media` | 本地文件直传（兜底入口），body 为文件二进制 |
| GET | `/api/media/:id` | 获取媒体轨道信息 |
| DELETE | `/api/media/:id` | 删除媒体任务与暂存文件 |
| POST | `/api/media/:id/pick-directory` | 调起原生目录选择框（选择导出根目录） |
| POST | `/api/batch/export` | 创建批次导出任务，body：`{ outputRoot, items: [{ mediaId, streams, defaultAudio, subtitleFormat }] }` |
| GET | `/api/batch/:id` | 查询批次导出进度 |
| POST | `/api/batch/:id/cancel` | 取消批次导出 |

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8090` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址，改为 `0.0.0.0` 可供局域网访问 |
| `FFMPEG_PATH` / `FFPROBE_PATH` / `MAKEMKVCON_PATH` | 自动探测 | 指定二进制路径 |
| `AUDIO_BITRATE` | `192k` | MP3 导出码率 |
| `MAX_UPLOAD_BYTES` | `64424509440` | 单文件上传上限（60GB） |
| `MAX_BATCH_FILES` | `10` | 单批次最多处理的 Title / 文件数 |
| `RIP_ROOT` | `server/data/rips` | MakeMKV 解密生成的 MKV 暂存目录 |
| `UPLOAD_ROOT` | `server/data/uploads` | 本地文件直传暂存目录 |
| `JOB_TTL_MS` | `21600000` | 暂存文件保留时长（6 小时） |
| `DISC_SCAN_TIMEOUT_MS` | `300000` | 扫描光盘超时时间（5 分钟） |
| `DISABLE_FOLDER_PICKER` | — | 设为 `1` 关闭原生选择框，改为页面上手动填写路径 |
| `DEFAULT_OUTPUT_DIR` | `<项目>/output` | 页面上提示的默认输出目录 |
