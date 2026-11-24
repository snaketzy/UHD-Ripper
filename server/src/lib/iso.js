import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ISO_MOUNT_ROOT } from '../config.js';

const HDIUTIL = '/usr/bin/hdiutil';

/**
 * 已挂载的 ISO 注册表：绝对路径 -> { mountPoint, refCount }
 * 同一个 ISO 被多次导入时只挂载一次，引用归零后再卸载。
 */
const mountedIsos = new Map();

export function isIsoPath(target) {
  return typeof target === 'string' && target.toLowerCase().endsWith('.iso');
}

function runHdiutil(args) {
  return new Promise((resolve, reject) => {
    execFile(HDIUTIL, args, { maxBuffer: 8 * 1024 * 1024, timeout: 5 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** 每个 ISO 固定一个挂载点目录，便于服务重启后清理遗留挂载 */
function mountPointFor(resolvedIso) {
  const hash = createHash('sha1').update(resolvedIso).digest('hex').slice(0, 16);
  return path.join(ISO_MOUNT_ROOT, hash);
}

/**
 * 以只读方式挂载 ISO，返回挂载点绝对路径。
 * 同一 ISO 重复挂载时复用已有挂载点并累加引用计数。
 */
export async function mountIso(isoPath) {
  if (process.platform !== 'darwin') {
    throw new Error('自动挂载 ISO 目前仅支持 macOS（依赖 hdiutil），请手动挂载后再填写 BDMV 目录路径');
  }

  const resolved = path.resolve(isoPath);
  const cached = mountedIsos.get(resolved);
  if (cached) {
    cached.refCount += 1;
    return cached.mountPoint;
  }

  const mountPoint = mountPointFor(resolved);
  await fs.mkdir(mountPoint, { recursive: true });
  try {
    await runHdiutil(['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint, resolved]);
  } catch (error) {
    await fs.rmdir(mountPoint).catch(() => {});
    throw new Error(`挂载 ISO 失败：${error.message}`);
  }

  mountedIsos.set(resolved, { mountPoint, refCount: 1 });
  return mountPoint;
}

/** 释放一次引用；引用归零时卸载 ISO 并删除挂载点目录 */
export async function releaseIso(isoPath) {
  const resolved = path.resolve(isoPath);
  const entry = mountedIsos.get(resolved);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  mountedIsos.delete(resolved);
  await runHdiutil(['detach', entry.mountPoint]).catch(() => {});
  await fs.rmdir(entry.mountPoint).catch(() => {});
}

/** 服务启动时清理上次运行遗留的 ISO 挂载（内存注册表已丢失，无法按引用计数释放） */
export async function sweepIsoMounts() {
  if (process.platform !== 'darwin') return;
  const entries = await fs.readdir(ISO_MOUNT_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(ISO_MOUNT_ROOT, entry.name);
    await runHdiutil(['detach', target]).catch(() => {});
    // 仅在目录为空（已卸载）时才能删除；仍在挂载时 rmdir 会失败并被忽略
    await fs.rmdir(target).catch(() => {});
  }
}
