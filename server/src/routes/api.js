import { Router } from 'express';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DEFAULT_OUTPUT_DIR,
  FOLDER_PICKER_ENABLED,
  MAX_BATCH_FILES,
  MAX_UPLOAD_BYTES,
  RIP_ROOT,
  UPLOAD_ROOT,
} from '../config.js';
import { describeBinaries } from '../lib/binaries.js';
import { probeMedia } from '../lib/probe.js';
import { buildPlan, normalizeSubtitleFormat } from '../lib/export.js';
import { cancelBatchJob, runBatchJob } from '../lib/batch.js';
import { buildSourceSpec, findMainStreamFile, scanDisc } from '../lib/disc.js';
import { isIsoPath, mountIso, releaseIso } from '../lib/iso.js';
import { cancelRipJob, runRipJob } from '../lib/ripRunner.js';
import { baseNameOf, uniqueFileName } from '../lib/trackName.js';
import {
  createBatchJob,
  createDiscJob,
  createMediaJob,
  createRipJob,
  dropMediaJob,
  getBatchJob,
  getDiscJob,
  getMediaJob,
  getRipJob,
  serializeBatch,
  serializeDiscJob,
  serializeMedia,
  serializeRipJob,
} from '../lib/jobs.js';
import { FolderPickerUnsupportedError, pickDirectory, pickFile } from '../lib/folderPicker.js';

export const apiRouter = Router();

function discRootName(inputPath) {
  const resolved = path.resolve(inputPath);
  return path.basename(path.basename(resolved) === 'BDMV' ? path.dirname(resolved) : resolved);
}

function importedMainTitleName(discPath, mainFilePath) {
  return `${discRootName(discPath)}${path.extname(mainFilePath).toLowerCase()}`;
}

/**
 * 定位主片：BDMV 目录直接查找；ISO 镜像先自动挂载为只读卷再查找。
 * 返回主片文件、ISO 来源路径（用于后续卸载）与命名基名。
 */
async function locateMainTitle(resolvedPath) {
  if (!isIsoPath(resolvedPath)) {
    const mainFile = await findMainStreamFile(resolvedPath);
    return { mainFile, isoPath: null, nameBase: null };
  }

  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error('ISO 文件不存在');
  }

  const mountPoint = await mountIso(resolvedPath);
  try {
    const mainFile = await findMainStreamFile(mountPoint);
    return { mainFile, isoPath: resolvedPath, nameBase: path.basename(resolvedPath, path.extname(resolvedPath)) };
  } catch (error) {
    await releaseIso(resolvedPath);
    throw error;
  }
}

/** 从 BDMV 目录或 ISO 镜像导入体积最大的主片，生成可直接导出的 mediaJob */
async function importMainTitle(resolvedPath) {
  const { mainFile, isoPath, nameBase } = await locateMainTitle(resolvedPath);
  try {
    const originalName = nameBase
      ? `${nameBase}${path.extname(mainFile.path).toLowerCase()}`
      : importedMainTitleName(resolvedPath, mainFile.path);
    const mediaInfo = await probeMedia(mainFile.path, originalName);
    const job = createMediaJob({
      originalName,
      storedPath: mainFile.path,
      mediaInfo,
      sizeBytes: mainFile.size,
      uploadDir: null,
      cleanupDir: null,
      isoPath,
    });
    return { sourcePath: mainFile.path, job };
  } catch (error) {
    // mediaJob 未创建成功时没有任务负责释放挂载，这里立即卸载，避免 ISO 一直挂着
    if (isoPath) await releaseIso(isoPath);
    throw error;
  }
}

function toStreamIndexes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

apiRouter.get('/health', async (_req, res) => {
  const binaries = await describeBinaries();
  res.json({
    ok: Boolean(binaries.ffmpeg.available && binaries.ffprobe.available),
    binaries,
  });
});

apiRouter.get('/config', (_req, res) => {
  res.json({
    folderPickerSupported: FOLDER_PICKER_ENABLED && process.platform === 'darwin',
    folderPickerDisabled: !FOLDER_PICKER_ENABLED,
    platform: process.platform,
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxBatchFiles: MAX_BATCH_FILES,
  });
});

/* ------------------------------------------------------------------ */
/* 光盘来源：扫描 ISO / BDMV 目录，选择 Title 并调用 MakeMKV 解密提取   */
/* ------------------------------------------------------------------ */

/** 调起系统原生选择框，挑选 ISO 文件或 BDMV 光盘根目录 */
apiRouter.post('/disc/pick-source', async (req, res, next) => {
  const kind = req.body?.kind === 'folder' ? 'folder' : 'iso';
  try {
    const result =
      kind === 'folder'
        ? await pickDirectory({ prompt: '请选择 BDMV 光盘根目录' })
        : await pickFile({ prompt: '请选择 ISO 镜像文件' });
    res.json(result);
  } catch (error) {
    if (error instanceof FolderPickerUnsupportedError) {
      res.status(501).json({ error: error.message, folderPickerSupported: false });
      return;
    }
    next(error);
  }
});

/** 调起系统原生选择框，挑选本地媒体文件（例如主片 m2ts / mkv） */
apiRouter.post('/media/pick-file', async (_req, res, next) => {
  try {
    const result = await pickFile({ prompt: '请选择本地媒体文件或 ISO 镜像（如主片 m2ts / mkv / iso）' });
    res.json(result);
  } catch (error) {
    if (error instanceof FolderPickerUnsupportedError) {
      res.status(501).json({ error: error.message, folderPickerSupported: false });
      return;
    }
    next(error);
  }
});

/** 扫描光盘源，列出可提取的 Title */
apiRouter.post('/disc/scan', async (req, res, next) => {
  try {
    const sourcePath = String(req.body?.sourcePath || '').trim();
    if (!sourcePath) {
      res.status(400).json({ error: '请先选择 ISO 文件或 BDMV 光盘根目录' });
      return;
    }
    if (!path.isAbsolute(sourcePath)) {
      res.status(400).json({ error: '光盘来源路径必须是绝对路径' });
      return;
    }

    const { sourceSpec } = await buildSourceSpec(sourcePath);
    const scan = await scanDisc(sourceSpec);
    const job = createDiscJob({ sourcePath, sourceSpec, scan });
    res.json(serializeDiscJob(job));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/disc/:id', (req, res) => {
  const job = getDiscJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '光盘扫描结果不存在或已过期，请重新扫描' });
    return;
  }
  res.json(serializeDiscJob(job));
});

/** 直接按绝对路径导入本地媒体文件，绕过 MakeMKV 扫描/提取流程 */
apiRouter.post('/media/import-path', async (req, res, next) => {
  try {
    const sourcePath = String(req.body?.sourcePath || '').trim();
    if (!sourcePath) {
      res.status(400).json({ error: '请先选择或填写本地媒体文件路径' });
      return;
    }
    if (!path.isAbsolute(sourcePath)) {
      res.status(400).json({ error: '媒体文件路径必须是绝对路径' });
      return;
    }

    const resolved = path.resolve(sourcePath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      res.status(400).json({ error: '媒体文件不存在' });
      return;
    }

    if (stat.isDirectory() || (stat.isFile() && isIsoPath(resolved))) {
      const { job } = await importMainTitle(resolved);
      res.json(serializeMedia(job));
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: '请选择单个媒体文件，或填写 BDMV 光盘根目录' });
      return;
    }

    const originalName = path.basename(resolved);
    const mediaInfo = await probeMedia(resolved, originalName);
    const job = createMediaJob({
      originalName,
      storedPath: resolved,
      mediaInfo,
      sizeBytes: stat.size,
      uploadDir: null,
      cleanupDir: null,
    });
    res.json(serializeMedia(job));
  } catch (error) {
    next(error);
  }
});

/** 从 BDMV 目录或 ISO 镜像中自动选择体积最大的 m2ts 作为主片并导入 */
apiRouter.post('/media/import-main-title', async (req, res, next) => {
  try {
    const sourcePath = String(req.body?.sourcePath || '').trim();
    if (!sourcePath) {
      res.status(400).json({ error: '请先选择或填写 BDMV 光盘根目录或 ISO 镜像路径' });
      return;
    }
    if (!path.isAbsolute(sourcePath)) {
      res.status(400).json({ error: 'BDMV 路径必须是绝对路径' });
      return;
    }

    const resolved = path.resolve(sourcePath);
    const { sourcePath: mainPath, job } = await importMainTitle(resolved);
    res.json({
      sourcePath: mainPath,
      media: serializeMedia(job),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 发起批量提取：对选中的若干 Title 依次调用 makemkvcon 解密生成 MKV，
 * 成功后自动 ffprobe 解析轨道，生成的 mediaJob 可直接用于后续轨道选择 / 导出接口
 */
apiRouter.post('/disc/:id/rip', async (req, res, next) => {
  try {
    const discJob = getDiscJob(req.params.id);
    if (!discJob) {
      res.status(404).json({ error: '光盘扫描结果不存在或已过期，请重新扫描' });
      return;
    }

    const titleIds = Array.isArray(req.body?.titleIds)
      ? [...new Set(req.body.titleIds.map((value) => Number(value)))]
      : [];
    if (titleIds.length === 0) {
      res.status(400).json({ error: '请至少选择一个 Title' });
      return;
    }
    if (titleIds.length > MAX_BATCH_FILES) {
      res.status(400).json({ error: `每批最多提取 ${MAX_BATCH_FILES} 个 Title，当前 ${titleIds.length} 个` });
      return;
    }

    const titleById = new Map(discJob.scan.titles.map((title) => [title.id, title]));
    const usedNames = new Set();
    const entries = [];
    for (const titleId of titleIds) {
      const title = titleById.get(titleId);
      if (!title) {
        res.status(400).json({ error: `Title ${titleId} 不存在，请重新扫描` });
        return;
      }
      const base = discJob.scan.discName || path.basename(discJob.sourcePath);
      const titleName = uniqueFileName(`${base}.Title${String(titleId).padStart(2, '0')}`, usedNames);
      entries.push({
        titleId,
        titleName,
        stagingDir: path.join(RIP_ROOT, randomUUID()),
      });
    }

    const ripJob = createRipJob({ discJobId: discJob.id, sourceSpec: discJob.sourceSpec, entries });
    runRipJob(ripJob).catch((error) => {
      ripJob.status = 'failed';
      ripJob.error = error.message;
    });

    res.status(202).json(serializeRipJob(ripJob));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/disc/rip/:id', (req, res) => {
  const job = getRipJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '提取任务不存在' });
    return;
  }
  res.json(serializeRipJob(job));
});

apiRouter.post('/disc/rip/:id/cancel', (req, res) => {
  const job = getRipJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '提取任务不存在' });
    return;
  }
  if (job.status === 'queued' || job.status === 'running') {
    cancelRipJob(job);
  }
  res.json(serializeRipJob(job));
});

/* ------------------------------------------------------------------ */
/* 媒体文件：无论来自光盘提取还是直接上传，共用同一套轨道选择 / 导出接口 */
/* ------------------------------------------------------------------ */

/**
 * 上传本地视频/MKV 文件（兜底入口）：请求体直接是文件二进制，文件名通过 x-file-name 头传递
 */
apiRouter.post('/media', async (req, res, next) => {
  const rawName = req.get('x-file-name');
  if (!rawName) {
    res.status(400).json({ error: '缺少 x-file-name 请求头' });
    return;
  }

  let originalName = rawName;
  try {
    originalName = decodeURIComponent(rawName);
  } catch {
    // 保留原始值
  }
  originalName = path.basename(originalName).trim() || 'input';

  const declaredLength = Number(req.get('content-length') || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `文件体积超过上限（${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)}GB）` });
    return;
  }

  const id = randomUUID();
  const uploadDir = path.join(UPLOAD_ROOT, id);
  const extension = path.extname(originalName).toLowerCase();
  const storedPath = path.join(uploadDir, `source${extension}`);

  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        callback(new Error(`文件体积超过上限（${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(1)}GB）`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await pipeline(req, counter, createWriteStream(storedPath));

    if (received === 0) throw new Error('未接收到文件内容');

    const mediaInfo = await probeMedia(storedPath, originalName);
    const job = createMediaJob({ originalName, storedPath, mediaInfo, sizeBytes: received });
    res.json(serializeMedia(job));
  } catch (error) {
    await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    next(error);
  }
});

apiRouter.get('/media/:id', (req, res) => {
  const job = getMediaJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '媒体任务不存在或已过期，请重新提取 / 选择文件' });
    return;
  }
  res.json(serializeMedia(job));
});

apiRouter.delete('/media/:id', async (req, res, next) => {
  try {
    const removed = await dropMediaJob(req.params.id);
    if (!removed) {
      res.status(404).json({ error: '媒体任务不存在' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** 服务端弹出原生目录选择框（用于选择导出根目录） */
apiRouter.post('/media/:id/pick-directory', async (req, res, next) => {
  try {
    const result = await pickDirectory({ prompt: req.body?.prompt || '请选择导出目录' });
    res.json(result);
  } catch (error) {
    if (error instanceof FolderPickerUnsupportedError) {
      res.status(501).json({ error: error.message, folderPickerSupported: false });
      return;
    }
    next(error);
  }
});

/**
 * 创建批次导出任务
 * body: { outputRoot, items: [{ mediaId, streams, defaultAudio, subtitleFormat }] }
 * 每个 Title/文件的结果写入 <outputRoot>/<源文件基名>/ 下的独立目录，便于下游项目（如 convert-to-hls）按目录消费
 */
apiRouter.post('/batch/export', async (req, res, next) => {
  try {
    const outputRoot = String(req.body?.outputRoot || '').trim();
    if (!outputRoot) {
      res.status(400).json({ error: '请先选择导出目录' });
      return;
    }
    if (!path.isAbsolute(outputRoot)) {
      res.status(400).json({ error: '导出目录必须是绝对路径' });
      return;
    }

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length === 0) {
      res.status(400).json({ error: '请先选择要导出的 Title / 文件' });
      return;
    }
    if (rawItems.length > MAX_BATCH_FILES) {
      res.status(400).json({ error: `每批最多处理 ${MAX_BATCH_FILES} 个文件，当前 ${rawItems.length} 个` });
      return;
    }

    // 同批出现同名基名时，后一个目录追加 -2
    const usedDirNames = new Set();
    const entries = [];

    for (const raw of rawItems) {
      const job = getMediaJob(String(raw?.mediaId || ''));
      if (!job) {
        res.status(404).json({ error: '有文件的临时任务已过期，请重新提取/选择后再导出' });
        return;
      }

      const streams = raw?.streams || {};
      const selection = {
        video: toStreamIndexes(streams.video),
        audio: toStreamIndexes(streams.audio),
        subtitle: toStreamIndexes(streams.subtitle),
      };

      const audioTracks = job.mediaInfo.tracks.audio;
      // 注意：Number(null) === 0，未指定默认音轨时必须显式当作「未选择」
      const rawDefaultAudio = raw?.defaultAudio;
      const parsedDefaultAudio =
        rawDefaultAudio === null || rawDefaultAudio === undefined || rawDefaultAudio === ''
          ? NaN
          : Number(rawDefaultAudio);
      const defaultAudio =
        Number.isInteger(parsedDefaultAudio) && parsedDefaultAudio >= 0 ? parsedDefaultAudio : null;

      // 导出视频时必须指定默认音轨，用于封装进 MP4
      if (selection.video.length > 0 && audioTracks.length > 0) {
        if (defaultAudio === null) {
          res.status(400).json({ error: `${job.originalName}：请先为视频选择默认音轨` });
          return;
        }
        if (!audioTracks.some((track) => track.streamIndex === defaultAudio)) {
          res.status(400).json({ error: `${job.originalName}：默认音轨不存在，请重新选择` });
          return;
        }
      }
      selection.defaultAudio = defaultAudio;
      // 字幕导出格式：srt / webvtt，缺省为 webvtt
      selection.subtitleFormat = normalizeSubtitleFormat(raw?.subtitleFormat);

      const dirName = uniqueFileName(baseNameOf(job.originalName), usedDirNames);
      const outputDir = path.join(outputRoot, dirName);

      const { items, skipped } = buildPlan(job.mediaInfo, outputDir, selection);
      if (items.length === 0) {
        res.status(400).json({ error: `${job.originalName}：未选中任何可导出的轨道`, skipped });
        return;
      }

      entries.push({ media: job, outputDir, items, skipped });
    }

    const batchJob = createBatchJob({ outputRoot, entries });
    runBatchJob(batchJob).catch((error) => {
      batchJob.status = 'failed';
      batchJob.error = error.message;
      batchJob.finishedAt = new Date().toISOString();
    });

    res.status(202).json(serializeBatch(batchJob));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/batch/:id', (req, res) => {
  const job = getBatchJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '批次任务不存在' });
    return;
  }
  res.json(serializeBatch(job));
});

apiRouter.post('/batch/:id/cancel', (req, res) => {
  const job = getBatchJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '批次任务不存在' });
    return;
  }
  if (job.status === 'queued' || job.status === 'running') {
    cancelBatchJob(job);
  }
  res.json(serializeBatch(job));
});
