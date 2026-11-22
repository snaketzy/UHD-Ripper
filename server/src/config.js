import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(currentDir, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');

export const PORT = Number(process.env.PORT || 8090);
export const HOST = process.env.HOST || '127.0.0.1';

/** 上传源文件（本地视频文件，非必须路径）的存放根目录 */
export const UPLOAD_ROOT = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(SERVER_ROOT, 'data', 'uploads');

/** MakeMKV 解密提取出的 MKV 暂存根目录：每个 Title 一个子目录 */
export const RIP_ROOT = process.env.RIP_ROOT
  ? path.resolve(process.env.RIP_ROOT)
  : path.join(SERVER_ROOT, 'data', 'rips');

/** 单个上传文件体积上限，默认 60GB（本系统主要走光盘提取，上传接口作为兜底） */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 60 * 1024 * 1024 * 1024);

/** 单批次最多处理的文件 / Title 数 */
export const MAX_BATCH_FILES = Number(process.env.MAX_BATCH_FILES || 10);

/** 任务记录（含暂存文件）保留时长，默认 6 小时 */
export const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 6 * 60 * 60 * 1000);

/** 导出音频时的目标码率 */
export const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';

/** 是否允许调用系统原生文件/目录选择框（DISABLE_FOLDER_PICKER=1 关闭） */
export const FOLDER_PICKER_ENABLED = process.env.DISABLE_FOLDER_PICKER !== '1';

/** 兜底输出目录：当所选目录不可用时使用 */
export const DEFAULT_OUTPUT_DIR = process.env.DEFAULT_OUTPUT_DIR
  ? path.resolve(process.env.DEFAULT_OUTPUT_DIR)
  : path.join(PROJECT_ROOT, 'output');

/** MakeMKV 扫描光盘的超时时间，默认 5 分钟（首次联网更新解密 key 可能较慢） */
export const DISC_SCAN_TIMEOUT_MS = Number(process.env.DISC_SCAN_TIMEOUT_MS || 5 * 60 * 1000);
