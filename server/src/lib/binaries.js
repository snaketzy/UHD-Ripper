import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const COMMON_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/local/bin',
  '/snap/bin',
  // MakeMKV 在 macOS 上的默认安装位置，不会出现在 PATH 中
  '/Applications/MakeMKV.app/Contents/MacOS',
];

const cache = new Map();

function isExecutable(target) {
  if (!target) return false;
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchSystem(name) {
  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  if (isExecutable(explicit)) return explicit;

  const dirs = [...COMMON_DIRS, ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** 仅 ffmpeg / ffprobe 有可内置的 npm 二进制包；makemkvcon 是闭源软件，没有内置兜底 */
function searchBundled(name) {
  try {
    if (name === 'ffmpeg') {
      const bundled = require('ffmpeg-static');
      if (typeof bundled === 'string' && isExecutable(bundled)) return bundled;
    } else if (name === 'ffprobe') {
      const bundled = require('ffprobe-static');
      const target = bundled?.path;
      if (isExecutable(target)) return target;
    }
  } catch {
    // 未安装内置二进制包时忽略
  }
  return null;
}

const INSTALL_HINTS = {
  ffmpeg: '请执行 brew install ffmpeg，或运行 npm install 以启用内置二进制。',
  ffprobe: '请执行 brew install ffmpeg，或运行 npm install 以启用内置二进制。',
  makemkvcon: '请先安装 MakeMKV（https://www.makemkv.com/download/），并确保 makemkvcon 命令可执行。',
};

function resolve(name) {
  if (cache.has(name)) return cache.get(name);

  let result = { name, path: null, source: null };
  const system = searchSystem(name);
  if (system) {
    result = { name, path: system, source: 'system' };
  } else {
    const bundled = searchBundled(name);
    if (bundled) result = { name, path: bundled, source: 'bundled' };
  }

  if (!result.path) {
    throw new Error(`未找到可执行文件 ${name}。${INSTALL_HINTS[name] || ''}`);
  }

  cache.set(name, result);
  return result;
}

export function ffmpegPath() {
  return resolve('ffmpeg').path;
}

export function ffprobePath() {
  return resolve('ffprobe').path;
}

export function makemkvconPath() {
  return resolve('makemkvcon').path;
}

function version(binary, args = ['-version']) {
  return new Promise((resolveVersion) => {
    execFile(binary, args, { timeout: 10000 }, (error, stdout) => {
      if (error) return resolveVersion(null);
      const first = String(stdout).split('\n')[0] || '';
      const match = first.match(/version\s+v?(\S+)/i) || first.match(/v(\d+\.\d+\.\d+)/i);
      resolveVersion(match ? match[1] : first.trim() || null);
    });
  });
}

export async function describeBinaries() {
  const info = {};
  for (const name of ['ffmpeg', 'ffprobe', 'makemkvcon']) {
    try {
      const resolved = resolve(name);
      info[name] = {
        available: true,
        path: resolved.path,
        source: resolved.source,
        // makemkvcon 没有轻量的版本查询子命令，避免每次健康检查都触发一次完整调用
        version: name === 'makemkvcon' ? null : await version(resolved.path),
      };
    } catch (error) {
      info[name] = { available: false, path: null, source: null, version: null, message: error.message };
    }
  }
  return info;
}
