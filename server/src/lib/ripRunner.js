import { promises as fs } from 'node:fs';
import { ripTitle } from './disc.js';
import { probeMedia } from './probe.js';
import { createMediaJob } from './jobs.js';
import { sanitizeName } from './trackName.js';

/**
 * 串行提取 ripJob 里的每个 Title：
 * 调用 makemkvcon 解密生成 MKV -> ffprobe 解析轨道 -> 落地为一个与「上传文件」同构的 mediaJob，
 * 后续轨道选择与批量导出接口无需区分来源，直接复用。
 */
export async function runRipJob(ripJob) {
  ripJob.status = 'running';

  for (const entry of ripJob.entries) {
    if (ripJob.cancelled) {
      entry.status = entry.status === 'pending' ? 'cancelled' : entry.status;
      continue;
    }

    entry.status = 'running';
    entry.stage = '正在解密并提取 Title…';

    try {
      const { mkvPath } = await ripTitle({
        sourceSpec: ripJob.sourceSpec,
        titleId: entry.titleId,
        outputDir: entry.stagingDir,
        onProgress: ({ percent, stage }) => {
          if (typeof percent === 'number') entry.percent = Math.round(percent * 10) / 10;
          if (stage) entry.stage = stage;
        },
        onChild: (child) => {
          ripJob.currentChild = child;
        },
      });

      entry.stage = '提取完成，正在解析轨道信息…';
      const originalName = `${sanitizeName(entry.titleName)}.mkv`;
      const mediaInfo = await probeMedia(mkvPath, originalName);
      const sizeBytes = (await fs.stat(mkvPath)).size;
      const mediaJob = createMediaJob({ originalName, storedPath: mkvPath, mediaInfo, sizeBytes });

      entry.mediaId = mediaJob.id;
      entry.status = 'done';
      entry.percent = 100;
      entry.stage = '完成';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message;
    } finally {
      ripJob.currentChild = null;
    }
  }

  ripJob.finishedAt = new Date().toISOString();
  ripJob.status = ripJob.cancelled ? 'cancelled' : 'completed';
  return ripJob;
}

/** 中止批量提取：杀掉当前 makemkvcon，并把还没开始的条目标记为已取消 */
export function cancelRipJob(ripJob) {
  ripJob.cancelled = true;
  ripJob.status = 'cancelled';
  ripJob.error = '用户已取消提取';

  if (ripJob.currentChild) {
    try {
      ripJob.currentChild.kill('SIGKILL');
    } catch {
      // 进程可能已退出
    }
  }

  for (const entry of ripJob.entries) {
    if (entry.status === 'pending') {
      entry.status = 'cancelled';
      entry.error = '用户已取消提取';
    }
  }

  return ripJob;
}
