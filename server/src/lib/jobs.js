import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JOB_TTL_MS, RIP_ROOT, UPLOAD_ROOT } from '../config.js';
import { releaseIso } from './iso.js';

/** mediaId -> 媒体任务（含暂存文件路径、探测结果）。无论来自本地上传还是光盘提取，结构一致 */
const mediaJobs = new Map();
/** exportId -> 导出任务 */
const exportJobs = new Map();
/** batchId -> 批次导出任务 */
const batchJobs = new Map();
/** discId -> 光盘扫描结果 */
const discJobs = new Map();
/** ripId -> 批量提取 Title 任务 */
const ripJobs = new Map();

export function createMediaJob({
  originalName,
  storedPath,
  mediaInfo,
  sizeBytes,
  uploadDir = path.dirname(storedPath),
  cleanupDir = uploadDir,
  isoPath = null,
}) {
  const id = randomUUID();
  const job = {
    id,
    originalName,
    storedPath,
    sizeBytes,
    mediaInfo,
    uploadDir,
    cleanupDir,
    /** 若来源是自动挂载的 ISO，记录其路径，任务清理时据此卸载 */
    isoPath,
    createdAt: Date.now(),
  };
  mediaJobs.set(id, job);
  return job;
}

export function getMediaJob(id) {
  return mediaJobs.get(id) || null;
}

export function createExportJob(media, { outputDir, items, skipped }) {
  const id = randomUUID();
  const job = {
    id,
    mediaId: media.id,
    outputDir,
    items,
    skipped,
    status: 'queued',
    error: null,
    currentChild: null,
    createdAt: Date.now(),
    files: items.map((item) => ({
      kind: item.kind,
      streamIndex: item.streamIndex,
      trackName: item.trackName,
      codec: item.codec,
      fileName: item.fileName,
      outputPath: item.outputPath,
      audioTrackName: item.audio?.trackName ?? null,
      status: 'pending',
      percent: 0,
      speed: null,
      mode: null,
      notice: null,
      error: null,
      sizeBytes: null,
    })),
  };
  exportJobs.set(id, job);
  return job;
}

export function getExportJob(id) {
  return exportJobs.get(id) || null;
}

/**
 * 创建批次导出任务：每个文件一个导出任务，由调用方串行驱动
 * entries: [{ media, outputDir, items, skipped }]
 */
export function createBatchJob({ outputRoot, entries }) {
  const id = randomUUID();
  const job = {
    id,
    outputRoot,
    status: 'queued',
    error: null,
    cancelled: false,
    /** 当前正在跑的文件条目，取消时用于终止其 FFmpeg */
    currentEntry: null,
    createdAt: Date.now(),
    entries: entries.map(({ media, outputDir, items, skipped }) => ({
      mediaId: media.id,
      sourceFileName: media.originalName,
      outputDir,
      exportJob: createExportJob(media, { outputDir, items, skipped }),
    })),
  };
  batchJobs.set(id, job);
  return job;
}

export function getBatchJob(id) {
  return batchJobs.get(id) || null;
}

export function serializeMedia(job) {
  return {
    ...job.mediaInfo,
    id: job.id,
    file: {
      ...job.mediaInfo.file,
      name: job.originalName,
      sizeBytes: job.sizeBytes ?? job.mediaInfo.file.sizeBytes,
    },
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

export function serializeExport(job) {
  const files = job.files.map((file) => ({
    kind: file.kind,
    streamIndex: file.streamIndex,
    trackName: file.trackName,
    codec: file.codec,
    fileName: file.fileName,
    audioTrackName: file.audioTrackName ?? null,
    status: file.status,
    percent: file.percent,
    speed: file.speed,
    mode: file.mode,
    notice: file.notice,
    error: file.error,
    sizeBytes: file.sizeBytes,
  }));
  return {
    id: job.id,
    mediaId: job.mediaId,
    outputDir: job.outputDir,
    status: job.status,
    error: job.error,
    skipped: job.skipped,
    files,
    total: files.length,
    completed: files.filter((f) => f.status === 'done' || f.status === 'failed').length,
    failed: files.filter((f) => f.status === 'failed').length,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

/** 导出任务状态 -> 批次内单个文件条目的状态 */
const ENTRY_STATUS = {
  queued: 'pending',
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function serializeBatch(job) {
  const entries = job.entries.map((entry) => {
    const data = serializeExport(entry.exportJob);
    return {
      mediaId: entry.mediaId,
      sourceFileName: entry.sourceFileName,
      outputDir: entry.outputDir,
      status: ENTRY_STATUS[entry.exportJob.status] || 'pending',
      error: data.error,
      skipped: data.skipped,
      files: data.files,
      total: data.total,
      completed: data.completed,
      failed: data.failed,
    };
  });

  const files = entries.flatMap((entry) => entry.files);
  const total = files.length;
  const settled = files.filter((file) => file.status === 'done' || file.status === 'failed');
  const percent = total
    ? Math.round(
        (files.reduce(
          (sum, file) => sum + (file.status === 'done' || file.status === 'failed' ? 100 : file.percent),
          0
        ) /
          total) *
          10
      ) / 10
    : 0;

  return {
    id: job.id,
    outputRoot: job.outputRoot,
    status: job.status,
    error: job.error,
    entries,
    total,
    completed: settled.length,
    failed: files.filter((file) => file.status === 'failed').length,
    percent,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

/** 光盘扫描结果缓存，供后续发起提取时复用（避免重复传输/重新扫描） */
export function createDiscJob({ sourcePath, sourceSpec, scan }) {
  const id = randomUUID();
  const job = { id, sourcePath, sourceSpec, scan, createdAt: Date.now() };
  discJobs.set(id, job);
  return job;
}

export function getDiscJob(id) {
  return discJobs.get(id) || null;
}

export function serializeDiscJob(job) {
  return {
    id: job.id,
    sourcePath: job.sourcePath,
    discName: job.scan.discName,
    discType: job.scan.discType,
    titles: job.scan.titles,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

/**
 * 批量提取 Title 任务：每个 Title 一个条目，串行调用 makemkvcon 解密生成 MKV，
 * 成功后对 MKV 执行 ffprobe，生成的 mediaJob 与「上传文件」完全同构，后续轨道选择/导出复用同一套接口。
 * entries: [{ titleId, titleName, stagingDir }]
 */
export function createRipJob({ discJobId, sourceSpec, entries }) {
  const id = randomUUID();
  const job = {
    id,
    discJobId,
    sourceSpec,
    status: 'queued',
    error: null,
    cancelled: false,
    currentChild: null,
    createdAt: Date.now(),
    entries: entries.map((entry) => ({
      titleId: entry.titleId,
      titleName: entry.titleName,
      stagingDir: entry.stagingDir,
      status: 'pending',
      percent: 0,
      stage: null,
      error: null,
      mediaId: null,
    })),
  };
  ripJobs.set(id, job);
  return job;
}

export function getRipJob(id) {
  return ripJobs.get(id) || null;
}

export function serializeRipJob(job) {
  const entries = job.entries.map((entry) => ({
    titleId: entry.titleId,
    titleName: entry.titleName,
    status: entry.status,
    percent: entry.percent,
    stage: entry.stage,
    error: entry.error,
    mediaId: entry.mediaId,
  }));
  const settled = entries.filter((entry) => entry.status === 'done' || entry.status === 'failed');
  return {
    id: job.id,
    discJobId: job.discJobId,
    status: job.status,
    error: job.error,
    entries,
    total: entries.length,
    completed: settled.length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
    createdAt: new Date(job.createdAt).toISOString(),
  };
}

async function removeDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响主流程
  }
}

/** 删除单个媒体任务及其暂存文件（上传文件或光盘提取出的 MKV） */
export async function dropMediaJob(id) {
  const job = mediaJobs.get(id);
  if (!job) return false;
  mediaJobs.delete(id);
  for (const [exportId, exportJob] of exportJobs) {
    if (exportJob.mediaId === id) exportJobs.delete(exportId);
  }
  if (job.cleanupDir) await removeDir(job.cleanupDir);
  if (job.isoPath) await releaseIso(job.isoPath);
  return true;
}

/** 清理某个根目录下，没有对应 mediaJob 的孤儿暂存目录（例如服务重启后遗留的目录） */
async function sweepOrphanDirsIn(root) {
  const activeDirs = new Set(
    [...mediaJobs.values()]
      .map((job) => job.uploadDir)
      .filter(Boolean)
      .map((dir) => path.basename(dir))
  );
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || activeDirs.has(entry.name)) continue;
    await removeDir(path.join(root, entry.name));
  }
}

export async function sweepOrphanUploadDirs() {
  await sweepOrphanDirsIn(UPLOAD_ROOT);
  await sweepOrphanDirsIn(RIP_ROOT);
}

/** 定期清理过期任务与暂存文件 */
export async function sweepExpired() {
  const deadline = Date.now() - JOB_TTL_MS;
  for (const [id, job] of mediaJobs) {
    if (job.createdAt < deadline) {
      await dropMediaJob(id);
    }
  }
  for (const [id, job] of exportJobs) {
    if (job.createdAt < deadline) exportJobs.delete(id);
  }
  for (const [id, job] of batchJobs) {
    if (job.createdAt < deadline) batchJobs.delete(id);
  }
  for (const [id, job] of discJobs) {
    if (job.createdAt < deadline) discJobs.delete(id);
  }
  for (const [id, job] of ripJobs) {
    if (job.createdAt < deadline) ripJobs.delete(id);
  }
  await sweepOrphanUploadDirs();
}

export async function ensureUploadRoot() {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.mkdir(RIP_ROOT, { recursive: true });
}
