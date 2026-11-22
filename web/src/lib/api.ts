import type {
  AppConfig,
  BatchJob,
  DiscScanResult,
  HealthPayload,
  MediaInfo,
  RipJob,
  SubtitleFormat,
  TrackKind,
} from '@/lib/types';

const API_BASE = '/api';

function errorMessageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = new Error(errorMessageFrom(payload, `请求失败（HTTP ${response.status}）`)) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return parseResponse<T>(response);
}

export const api = {
  health: () => request<HealthPayload>('/health'),

  config: () => request<AppConfig>('/config'),

  getMedia: (mediaId: string) => request<MediaInfo>(`/media/${mediaId}`),

  deleteMedia: (mediaId: string) => request<{ ok: boolean }>(`/media/${mediaId}`, { method: 'DELETE' }),

  pickDirectory: (mediaId: string) =>
    request<{ path?: string; cancelled?: boolean }>(`/media/${mediaId}/pick-directory`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** 单个 Title / 文件的批次导出请求项 */
  startBatchExport: (outputRoot: string, items: BatchExportItem[]) =>
    request<BatchJob>('/batch/export', {
      method: 'POST',
      body: JSON.stringify({ outputRoot, items }),
    }),

  getBatch: (batchId: string) => request<BatchJob>(`/batch/${batchId}`),

  cancelBatch: (batchId: string) =>
    request<BatchJob>(`/batch/${batchId}/cancel`, { method: 'POST', body: JSON.stringify({}) }),

  /** 调起系统原生选择框，挑选 ISO 文件或 BDMV 光盘根目录 */
  pickDiscSource: (kind: 'iso' | 'folder') =>
    request<{ path?: string; cancelled?: boolean }>('/disc/pick-source', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),

  /** 调起系统原生选择框，挑选本地媒体文件（例如主片 m2ts / mkv） */
  pickMediaFile: () =>
    request<{ path?: string; cancelled?: boolean }>('/media/pick-file', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  importMediaFromPath: (sourcePath: string) =>
    request<MediaInfo>('/media/import-path', {
      method: 'POST',
      body: JSON.stringify({ sourcePath }),
    }),

  importMainTitleFromDiscPath: (sourcePath: string) =>
    request<{ sourcePath: string; media: MediaInfo }>('/media/import-main-title', {
      method: 'POST',
      body: JSON.stringify({ sourcePath }),
    }),

  scanDisc: (sourcePath: string) =>
    request<DiscScanResult>('/disc/scan', {
      method: 'POST',
      body: JSON.stringify({ sourcePath }),
    }),

  startRip: (discJobId: string, titleIds: number[]) =>
    request<RipJob>(`/disc/${discJobId}/rip`, {
      method: 'POST',
      body: JSON.stringify({ titleIds }),
    }),

  getRip: (ripJobId: string) => request<RipJob>(`/disc/rip/${ripJobId}`),

  cancelRip: (ripJobId: string) =>
    request<RipJob>(`/disc/rip/${ripJobId}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
};

export interface BatchExportItem {
  mediaId: string;
  streams: Record<TrackKind, number[]>;
  defaultAudio: number | null;
  subtitleFormat: SubtitleFormat;
}
