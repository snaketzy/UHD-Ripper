import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ffprobePath } from './binaries.js';
import { resolveTrackName } from './trackName.js';

/** 可无损/正常转换为 SRT 的文本字幕编码 */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'utf8',
  'subviewer', 'subviewer1', 'microdvd', 'jacosub', 'sami', 'realtext',
  'stl', 'vplayer', 'eia_608', 'hdmv_text_subtitle', 'ttml',
]);

/** 图形字幕，无法转换为文本字幕（SRT / WebVTT） */
const GRAPHIC_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext',
]);

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseRate(value) {
  if (!value || typeof value !== 'string') return null;
  const [numStr, denStr] = value.split('/');
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const rate = num / den;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ffprobe 解析失败：${String(stderr || error.message).trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`ffprobe 输出无法解析：${parseError.message}`));
        }
      }
    );
  });
}

function parsePid(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const parsed = normalized.startsWith('0x') ? Number.parseInt(normalized.slice(2), 16) : Number(normalized);
  return Number.isInteger(parsed) ? parsed : null;
}

function guessClipInfoPath(filePath) {
  const normalized = path.normalize(filePath);
  const match = normalized.match(/^(.*)[/\\]BDMV[/\\]STREAM[/\\]([^/\\]+)\.m2ts$/i);
  if (!match) return null;
  return path.join(match[1], 'BDMV', 'CLIPINF', `${match[2]}.clpi`);
}

function parseClpiProgramInfo(data) {
  const out = [];
  if (data.length < 6) return out;

  const numPrograms = data[5];
  let pos = 6;

  for (let i = 0; i < numPrograms; i += 1) {
    if (pos + 8 > data.length) return out;
    const numStreams = data[pos + 6];
    pos += 8;

    for (let j = 0; j < numStreams; j += 1) {
      if (pos + 3 > data.length) return out;
      const pid = (data[pos] << 8) | data[pos + 1];
      const sciLength = data[pos + 2];
      const sciEnd = pos + 3 + sciLength;
      if (sciLength < 1 || sciEnd > data.length) return out;

      const sci = data.subarray(pos + 3, sciEnd);
      const codingType = sci[0];
      let language = '';

      if ((codingType >= 0x80 && codingType <= 0x86) || codingType === 0xa1 || codingType === 0xa2) {
        if (sci.length >= 5) language = sci.subarray(2, 5).toString('utf8');
      } else if (codingType === 0x90 || codingType === 0x91) {
        if (sci.length >= 4) language = sci.subarray(1, 4).toString('utf8');
      }

      out.push({ pid, codingType, language: language.trim().toLowerCase() || null });
      pos = sciEnd;
    }
  }

  return out;
}

async function readClpiLanguageMap(filePath) {
  const clipInfoPath = guessClipInfoPath(filePath);
  if (!clipInfoPath) return new Map();

  let raw;
  try {
    raw = await fs.readFile(clipInfoPath);
  } catch {
    return new Map();
  }

  if (raw.length < 20 || raw.subarray(0, 4).toString('ascii') !== 'HDMV') return new Map();

  const programInfoStart = raw.readUInt32BE(12);
  if (!programInfoStart || programInfoStart + 6 > raw.length) return new Map();

  const streams = parseClpiProgramInfo(raw.subarray(programInfoStart));
  const map = new Map();
  for (const stream of streams) {
    if (!stream.language) continue;
    map.set(stream.pid, stream.language);
  }
  return map;
}

/**
 * 取某条字幕轨首包的 PTS（秒），即第一条字幕出现的时刻。
 * MKV 的流级 start_time 恒为 0，只有首包时间戳才有意义。
 */
function runFfprobeFirstPts(filePath, streamIndex) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      [
        '-v', 'error',
        '-select_streams', String(streamIndex),
        '-show_packets',
        '-read_intervals', '%+#1',
        '-show_entries', 'packet=pts_time',
        '-print_format', 'json',
        filePath,
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(toNumber(JSON.parse(stdout).packets?.[0]?.pts_time));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function baseTrack(stream, kind, indexInType) {
  return {
    kind,
    indexInType,
    streamIndex: stream.index,
    codec: stream.codec_name || 'unknown',
    codecLongName: stream.codec_long_name || null,
    profile: stream.profile || null,
    language: stream.tags?.language || null,
    title: stream.tags?.title || null,
    isDefault: stream.disposition?.default === 1,
    isForced: stream.disposition?.forced === 1,
    tags: stream.tags || {},
  };
}

function mapVideo(stream, indexInType) {
  return {
    ...baseTrack(stream, 'video', indexInType),
    width: toNumber(stream.width),
    height: toNumber(stream.height),
    fps: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
    bitrate: toNumber(stream.bit_rate),
    pixelFormat: stream.pix_fmt || null,
    level: toNumber(stream.level),
    bitDepth: toNumber(stream.bits_per_raw_sample) ?? toNumber(stream.bits_per_sample),
    colorSpace: stream.color_space && stream.color_space !== 'unknown' ? stream.color_space : null,
    colorTransfer: stream.color_transfer && stream.color_transfer !== 'unknown' ? stream.color_transfer : null,
    colorPrimaries: stream.color_primaries && stream.color_primaries !== 'unknown' ? stream.color_primaries : null,
    fieldOrder: stream.field_order && stream.field_order !== 'unknown' ? stream.field_order : null,
    sampleAspectRatio: stream.sample_aspect_ratio || null,
    displayAspectRatio: stream.display_aspect_ratio || null,
    frameCount: toNumber(stream.nb_frames),
    durationSec: toNumber(stream.duration),
    rotation: stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? null,
  };
}

function mapAudio(stream, indexInType) {
  return {
    ...baseTrack(stream, 'audio', indexInType),
    sampleRate: toNumber(stream.sample_rate),
    channels: toNumber(stream.channels),
    channelLayout: stream.channel_layout || null,
    bitrate: toNumber(stream.bit_rate),
    bitDepth: toNumber(stream.bits_per_raw_sample) ?? toNumber(stream.bits_per_sample),
    durationSec: toNumber(stream.duration),
  };
}

function mapSubtitle(stream, indexInType) {
  const codec = stream.codec_name || 'unknown';
  const isTextBased = TEXT_SUBTITLE_CODECS.has(codec);
  const isGraphic = GRAPHIC_SUBTITLE_CODECS.has(codec);
  const isPgs = codec === 'hdmv_pgs_subtitle';
  return {
    ...baseTrack(stream, 'subtitle', indexInType),
    isTextBased,
    convertibleToSrt: isTextBased,
    convertibleToWebVtt: isTextBased,
    // PGS 无法转文本，但可以原样抽取为 .sup
    convertibleToSup: isPgs,
    startTimeSec: null,
    note: isGraphic ? '图形字幕（PGS/VobSub），无法转换为 SRT / WebVTT' : null,
  };
}

const MAPPERS = { video: mapVideo, audio: mapAudio, subtitle: mapSubtitle };

/**
 * 解析媒体文件，返回归一化后的轨道信息
 */
export async function probeMedia(filePath, fileName) {
  const raw = await runFfprobe(filePath);
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const clpiLanguageMap = await readClpiLanguageMap(filePath);
  const tracks = { video: [], audio: [], subtitle: [] };
  const counters = { video: 0, audio: 0, subtitle: 0 };

  for (const stream of streams) {
    const kind = stream.codec_type;
    const mapper = MAPPERS[kind];
    if (!mapper) continue;
    const indexInType = counters[kind];
    counters[kind] += 1;
    const track = mapper(stream, indexInType);
    const pid = parsePid(stream.id);
    if (!track.language && pid !== null && clpiLanguageMap.has(pid)) {
      track.language = clpiLanguageMap.get(pid);
    }
    track.name = resolveTrackName(track, kind, indexInType);
    tracks[kind].push(track);
  }

  // 字幕轨额外取首包 PTS，作为「起始时间」展示
  await Promise.all(
    tracks.subtitle.map(async (track) => {
      track.startTimeSec = await runFfprobeFirstPts(filePath, track.streamIndex);
    })
  );

  const format = raw.format || {};
  const durationSec = toNumber(format.duration)
    ?? (Math.max(0, ...streams.map((s) => toNumber(s.duration) || 0)) || null);

  const extension = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';

  return {
    file: {
      name: fileName,
      extension,
      sizeBytes: toNumber(format.size),
    },
    format: {
      name: format.format_name || null,
      longName: format.format_long_name || null,
      durationSec,
      bitrate: toNumber(format.bit_rate),
      sizeBytes: toNumber(format.size),
      streamCount: streams.length,
      tags: format.tags || {},
    },
    counts: {
      video: tracks.video.length,
      audio: tracks.audio.length,
      subtitle: tracks.subtitle.length,
    },
    tracks,
  };
}
