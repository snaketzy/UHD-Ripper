export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface BaseTrack {
  kind: TrackKind;
  indexInType: number;
  streamIndex: number;
  codec: string;
  codecLongName: string | null;
  profile: string | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  name: string;
  durationSec: number | null;
}

export interface VideoTrack extends BaseTrack {
  kind: 'video';
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  pixelFormat: string | null;
  level: number | null;
  bitDepth: number | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  fieldOrder: string | null;
  displayAspectRatio: string | null;
  frameCount: number | null;
  rotation: number | null;
}

export interface AudioTrack extends BaseTrack {
  kind: 'audio';
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  bitrate: number | null;
  bitDepth: number | null;
}

/** 字幕导出格式（互斥单选） */
export type SubtitleFormat = 'srt' | 'webvtt';

export interface SubtitleTrack extends BaseTrack {
  kind: 'subtitle';
  isTextBased: boolean;
  convertibleToSrt: boolean;
  convertibleToWebVtt: boolean;
  /** PGS 图形字幕可原样抽取为 .sup */
  convertibleToSup: boolean;
  /** 首包 PTS（秒），即第一条字幕出现的时刻 */
  startTimeSec: number | null;
  note: string | null;
}

export type AnyTrack = VideoTrack | AudioTrack | SubtitleTrack;

export interface MediaInfo {
  id: string;
  createdAt: string;
  file: {
    name: string;
    extension: string;
    sizeBytes: number | null;
  };
  format: {
    name: string | null;
    longName: string | null;
    durationSec: number | null;
    bitrate: number | null;
    sizeBytes: number | null;
    streamCount: number;
  };
  counts: Record<TrackKind, number>;
  tracks: {
    video: VideoTrack[];
    audio: AudioTrack[];
    subtitle: SubtitleTrack[];
  };
}

export type ExportFileStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ExportFileState {
  kind: TrackKind;
  streamIndex: number;
  trackName: string;
  codec: string;
  fileName: string;
  /** 视频文件封装进 MP4 的默认音轨名，其他类型为 null */
  audioTrackName: string | null;
  status: ExportFileStatus;
  percent: number;
  speed: string | null;
  mode: 'copy' | 'transcode' | null;
  notice: string | null;
  error: string | null;
  sizeBytes: number | null;
}

export interface SkippedTrack {
  kind: TrackKind;
  streamIndex: number;
  trackName: string;
  reason: string;
}

export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 批次内单个文件的处理状态 */
export type BatchEntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BatchEntry {
  mediaId: string;
  sourceFileName: string;
  /** 该文件的导出目录（<输出根目录>/<源文件基名>） */
  outputDir: string;
  status: BatchEntryStatus;
  error: string | null;
  skipped: SkippedTrack[];
  files: ExportFileState[];
  total: number;
  completed: number;
  failed: number;
}

export interface BatchJob {
  id: string;
  outputRoot: string;
  status: ExportStatus;
  error: string | null;
  entries: BatchEntry[];
  /** 全部文件条目里的导出文件总数 */
  total: number;
  completed: number;
  failed: number;
  percent: number;
  createdAt: string;
}

export interface BinaryInfo {
  available: boolean;
  path: string | null;
  source: 'system' | 'bundled' | null;
  version: string | null;
  message?: string;
}

export interface HealthPayload {
  ok: boolean;
  binaries: Record<'ffmpeg' | 'ffprobe' | 'makemkvcon', BinaryInfo>;
}

export interface AppConfig {
  folderPickerSupported: boolean;
  folderPickerDisabled: boolean;
  platform: string;
  defaultOutputDir: string;
  maxUploadBytes: number;
  /** 单批次最多可处理的文件 / Title 数 */
  maxBatchFiles: number;
}

/* ------------------------------------------------------------------ */
/* 光盘来源：扫描 ISO / BDMV 目录，选择 Title 并调用 MakeMKV 解密提取   */
/* ------------------------------------------------------------------ */

export interface DiscAudioTrackPreview {
  langCode: string | null;
  langName: string | null;
  codec: string | null;
  channels: number | null;
}

export interface DiscTitle {
  id: number;
  name: string | null;
  chapters: number;
  durationSec: number | null;
  durationLabel: string | null;
  sizeBytes: number;
  sizeLabel: string | null;
  suggestedFileName: string | null;
  videoCount: number;
  audioTracks: DiscAudioTrackPreview[];
  subtitleCount: number;
  /** 磁盘占用最大的 Title，通常就是正片 */
  isLikelyMainMovie: boolean;
}

export interface DiscScanResult {
  id: string;
  sourcePath: string;
  discName: string | null;
  discType: string | null;
  titles: DiscTitle[];
  createdAt: string;
}

export type RipEntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RipEntry {
  titleId: number;
  titleName: string;
  status: RipEntryStatus;
  percent: number;
  stage: string | null;
  error: string | null;
  mediaId: string | null;
}

export interface RipJob {
  id: string;
  discJobId: string;
  status: ExportStatus;
  error: string | null;
  entries: RipEntry[];
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
}
