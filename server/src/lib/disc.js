import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makemkvconPath } from './binaries.js';
import { DISC_SCAN_TIMEOUT_MS } from '../config.js';

/**
 * MakeMKV 机器人模式（-r）输出是逐行的 "TAG:field1,field2,...,"quoted string""。
 * 字符串字段带引号，控制字符与引号本身会被反斜杠转义，数字字段不带引号。
 * 这里按「不在引号内的逗号」切分字段，再对带引号的字段去除引号与转义。
 */
function splitRobotFields(rest) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (inQuotes) {
      if (char === '\\' && i + 1 < rest.length) {
        current += rest[i + 1];
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseRobotLine(line) {
  const separator = line.indexOf(':');
  if (separator < 0) return null;
  const tag = line.slice(0, separator);
  const fields = splitRobotFields(line.slice(separator + 1));
  return { tag, fields };
}

function formatMakemkvFailure({ messages, stderrTail, code, signal }) {
  const meaningful = messages
    .map((message) => String(message || '').trim())
    .filter(Boolean)
    .filter(
      (message) =>
        !/started$/i.test(message) && !/The program can't find any usable optical drives\./i.test(message)
    );

  if (signal) {
    const lastMessage = meaningful.at(-1);
    if (lastMessage) return `${lastMessage}（makemkvcon 崩溃，信号 ${signal}）`;
    return `makemkvcon 扫描时崩溃（信号 ${signal}）`;
  }

  return (
    meaningful.slice(-3).join('；') ||
    stderrTail.trim().split('\n').slice(-3).join(' ') ||
    `makemkvcon 退出码 ${code}`
  );
}

/** "H:MM:SS" 或 "MM:SS" -> 秒数 */
function parseDurationLabel(label) {
  if (!label) return null;
  const parts = String(label).split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * 已知的 MakeMKV AP_ItemAttributeId（来自 apdefs.h，社区文档广泛引用的子集）
 * 标题/流共用同一套属性编号，含义随上下文（TINFO / SINFO）不同
 */
const ATTR = {
  NAME: 2,
  LANG_CODE: 3,
  LANG_NAME: 4,
  CODEC_ID: 5,
  CODEC_SHORT: 6,
  CODEC_LONG: 7,
  CHAPTER_COUNT: 8,
  DURATION: 9,
  DISK_SIZE: 10,
  DISK_SIZE_BYTES: 11,
  BITRATE: 13,
  AUDIO_CHANNELS: 14,
  AUDIO_SAMPLE_RATE: 17,
  VIDEO_SIZE: 19,
  OUTPUT_FILE_NAME: 27,
  STREAM_TYPE: 1,
};

function buildIsoPathError(inputPath) {
  return new Error(`路径不存在：${inputPath}`);
}

/**
 * 根据用户提供的路径，构造 MakeMKV 的 source_spec
 *  - .iso 文件 -> iso:<path>
 *  - BDMV 光盘根目录（或其 BDMV 子目录本身）-> file:<disc root>
 */
export async function buildSourceSpec(inputPath) {
  const resolved = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw buildIsoPathError(resolved);
  }

  if (stat.isFile()) {
    if (!resolved.toLowerCase().endsWith('.iso')) {
      throw new Error('不支持的文件类型：请提供 .iso 镜像文件');
    }
    return { sourceSpec: `iso:${resolved}`, discLabel: path.basename(resolved, path.extname(resolved)) };
  }

  if (!stat.isDirectory()) {
    throw new Error('不支持的输入：请提供 .iso 文件或 BDMV 光盘根目录');
  }

  let discRoot = resolved;
  if (path.basename(resolved) === 'BDMV') {
    discRoot = path.dirname(resolved);
  }

  const hasBdmv = await fs.stat(path.join(discRoot, 'BDMV')).then(() => true).catch(() => false);
  if (!hasBdmv) {
    throw new Error('未找到 BDMV 目录结构，请确认选择的是光盘根目录（包含 BDMV 子文件夹）');
  }

  return { sourceSpec: `file:${discRoot}`, discLabel: path.basename(discRoot) };
}

export async function findMainStreamFile(inputPath) {
  const resolved = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw buildIsoPathError(resolved);
  }

  if (!stat.isDirectory()) {
    throw new Error('请提供 BDMV 光盘根目录或其 BDMV 子目录');
  }

  let discRoot = resolved;
  if (path.basename(resolved) === 'BDMV') {
    discRoot = path.dirname(resolved);
  }

  const streamDir = path.join(discRoot, 'BDMV', 'STREAM');
  const entries = await fs.readdir(streamDir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    throw new Error('未找到 BDMV/STREAM 目录，请确认选择的是完整蓝光目录');
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('._')) continue;
    if (!entry.name.toLowerCase().endsWith('.m2ts')) continue;
    const fullPath = path.join(streamDir, entry.name);
    const fileStat = await fs.stat(fullPath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size <= 0) continue;
    candidates.push({ path: fullPath, size: fileStat.size, name: entry.name });
  }

  if (candidates.length === 0) {
    throw new Error('BDMV/STREAM 中未找到可用的 .m2ts 文件');
  }

  candidates.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return candidates[0];
}

function execMakemkv(args, { timeoutMs, onLine, onChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(makemkvconPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);

    let stdoutBuffer = '';
    let stderrTail = '';
    let settled = false;
    const messages = [];

    const processLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      if (line.startsWith('MSG:')) {
        const parsed = parseRobotLine(line);
        if (parsed) messages.push(parsed.fields[3] || '');
      }
      onLine?.(line);
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          child.kill('SIGKILL');
          settled = true;
          reject(new Error(`makemkvcon 执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const rawLine of lines) processLine(rawLine);
    });

    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`无法启动 makemkvcon：${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 异常退出时，最后一行可能没有换行符；这里补处理，避免真实错误被吞掉。
      if (stdoutBuffer) {
        processLine(stdoutBuffer);
        stdoutBuffer = '';
      }
      if (code === 0) {
        resolve({ messages });
        return;
      }
      const detail = formatMakemkvFailure({ messages, stderrTail, code, signal });
      const error = new Error(detail || `makemkvcon 退出码 ${code}${signal ? `（信号 ${signal}）` : ''}`);
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
  });
}

/**
 * 扫描光盘源（ISO / BDMV 目录），列出可提取的 Title
 */
export async function scanDisc(sourceSpec) {
  const disc = { type: null, name: null };
  /** titleId -> { attrs: Map, streams: Map<streamId, Map> } */
  const titles = new Map();

  const ensureTitle = (titleId) => {
    if (!titles.has(titleId)) titles.set(titleId, { attrs: new Map(), streams: new Map() });
    return titles.get(titleId);
  };

  await execMakemkv(['-r', '--cache=1', 'info', sourceSpec], {
    timeoutMs: DISC_SCAN_TIMEOUT_MS,
    onLine: (line) => {
      const parsed = parseRobotLine(line);
      if (!parsed) return;
      const { tag, fields } = parsed;

      if (tag === 'CINFO') {
        const [attrId, , value] = fields;
        if (Number(attrId) === ATTR.STREAM_TYPE) disc.type = value;
        if (Number(attrId) === ATTR.NAME) disc.name = value;
        return;
      }

      if (tag === 'TINFO') {
        const [titleId, attrId, , value] = fields;
        ensureTitle(Number(titleId)).attrs.set(Number(attrId), value);
        return;
      }

      if (tag === 'SINFO') {
        const [titleId, streamId, attrId, , value] = fields;
        const title = ensureTitle(Number(titleId));
        if (!title.streams.has(Number(streamId))) title.streams.set(Number(streamId), new Map());
        title.streams.get(Number(streamId)).set(Number(attrId), value);
      }
    },
  }).catch((error) => {
    if (error?.signal === 'SIGSEGV') {
      const extra = sourceSpec.startsWith('file:')
        ? '该 BDMV 目录会触发 MakeMKV 自身崩溃，通常是盘结构元数据兼容性问题。建议重新拷贝/重新制作 ISO，或直接改走主片 m2ts 文件。'
        : 'MakeMKV 在扫描该来源时发生原生崩溃。';
      throw new Error(`扫描光盘失败：${extra}`);
    }
    throw new Error(`扫描光盘失败：${error.message}`);
  });

  if (titles.size === 0) {
    throw new Error('未解析到任何 Title，请确认光盘内容完整、MakeMKV 解密密钥已更新');
  }

  const result = [...titles.entries()].map(([id, title]) => {
    const name = title.attrs.get(ATTR.NAME) || null;
    const chapters = Number(title.attrs.get(ATTR.CHAPTER_COUNT)) || 0;
    const durationLabel = title.attrs.get(ATTR.DURATION) || null;
    const durationSec = parseDurationLabel(durationLabel);
    const sizeLabel = title.attrs.get(ATTR.DISK_SIZE) || null;
    const sizeBytes = Number(title.attrs.get(ATTR.DISK_SIZE_BYTES)) || 0;
    const suggestedFileName = title.attrs.get(ATTR.OUTPUT_FILE_NAME) || null;

    let videoCount = 0;
    const audioTracks = [];
    let subtitleCount = 0;
    for (const stream of title.streams.values()) {
      const type = (stream.get(ATTR.STREAM_TYPE) || '').toLowerCase();
      if (type === 'video') {
        videoCount += 1;
      } else if (type === 'audio') {
        audioTracks.push({
          langCode: stream.get(ATTR.LANG_CODE) || null,
          langName: stream.get(ATTR.LANG_NAME) || null,
          codec: stream.get(ATTR.CODEC_SHORT) || stream.get(ATTR.CODEC_ID) || null,
          channels: Number(stream.get(ATTR.AUDIO_CHANNELS)) || null,
        });
      } else if (type.includes('subtitle')) {
        subtitleCount += 1;
      }
    }

    return {
      id,
      name,
      chapters,
      durationSec,
      durationLabel,
      sizeBytes,
      sizeLabel,
      suggestedFileName,
      videoCount,
      audioTracks,
      subtitleCount,
    };
  });

  result.sort((a, b) => a.id - b.id);
  const maxSize = Math.max(...result.map((title) => title.sizeBytes));
  for (const title of result) {
    title.isLikelyMainMovie = maxSize > 0 && title.sizeBytes === maxSize;
  }

  return {
    discName: disc.name || null,
    discType: disc.type || null,
    titles: result,
  };
}

/**
 * 提取单个 Title：调用 makemkvcon 解密并生成 MKV 文件到 outputDir
 * 返回生成的 MKV 文件绝对路径
 */
export async function ripTitle({ sourceSpec, titleId, outputDir, onProgress, onChild }) {
  await fs.mkdir(outputDir, { recursive: true });
  const before = new Set(await fs.readdir(outputDir).catch(() => []));

  let lastStage = null;

  try {
    await execMakemkv(['-r', '--cache=1', '--progress=-same', 'mkv', sourceSpec, String(titleId), outputDir], {
      timeoutMs: 0,
      onChild,
      onLine: (line) => {
        const parsed = parseRobotLine(line);
        if (!parsed) return;
        if (parsed.tag === 'PRGV') {
          const [current, , max] = parsed.fields.map(Number);
          if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
            onProgress?.({ percent: Math.min(99.5, (current / max) * 100), stage: lastStage });
          }
          return;
        }
        if (parsed.tag === 'PRGC' || parsed.tag === 'PRGT') {
          lastStage = parsed.fields[2] || parsed.fields[1] || lastStage;
          onProgress?.({ stage: lastStage });
        }
      },
    });
  } catch (error) {
    throw new Error(`提取 Title ${titleId} 失败：${error.message}`);
  }

  const after = await fs.readdir(outputDir).catch(() => []);
  const createdFiles = after.filter((name) => !before.has(name) && name.toLowerCase().endsWith('.mkv'));

  let mkvName = createdFiles[0] || null;
  if (createdFiles.length > 1) {
    const stats = await Promise.all(
      createdFiles.map(async (name) => ({ name, size: (await fs.stat(path.join(outputDir, name))).size }))
    );
    stats.sort((a, b) => b.size - a.size);
    mkvName = stats[0].name;
  }
  if (!mkvName) {
    const fallback = after.filter((name) => name.toLowerCase().endsWith('.mkv'));
    mkvName = fallback[0] || null;
  }
  if (!mkvName) {
    throw new Error(`提取 Title ${titleId} 完成，但未在输出目录中找到生成的 MKV 文件`);
  }

  return { mkvPath: path.join(outputDir, mkvName) };
}
