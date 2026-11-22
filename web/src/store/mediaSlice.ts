import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from '@reduxjs/toolkit';

import { api, type BatchExportItem } from '@/lib/api';
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
import type { RootState } from '@/store';

export interface MediaItemState {
  /** 前端列表 key，与后端 mediaId 解耦 */
  key: string;
  /** 来源说明：disc 提取出的 Title 还是本地文件 */
  sourceLabel: string;

  media: MediaInfo | null;
  selected: Record<TrackKind, number[]>;
  /** 并入视频的默认音轨（streamIndex），仅在导出视频时生效 */
  defaultAudio: number | null;
  /** 字幕导出格式，按文件独立设置 */
  subtitleFormat: SubtitleFormat;
}

export type DiscSourceKind = 'iso' | 'folder';
export type DiscScanStatus = 'idle' | 'picking' | 'scanning' | 'ready' | 'error';
export type RipStatus = 'idle' | 'starting' | 'running' | 'done' | 'error';

export interface DiscState {
  sourceKind: DiscSourceKind;
  sourcePath: string;
  pickerBusy: boolean;
  pickerError: string | null;
  scanStatus: DiscScanStatus;
  scanError: string | null;
  scan: DiscScanResult | null;
  selectedTitleIds: number[];
  ripStatus: RipStatus;
  ripError: string | null;
  ripJob: RipJob | null;
  /** 已经写入 items 列表的 mediaId，避免轮询重复添加 */
  importedMediaIds: string[];
}

export interface MediaState {
  bootstrapStatus: 'idle' | 'loading' | 'ready' | 'error';
  health: HealthPayload | null;
  config: AppConfig | null;
  bootstrapError: string | null;

  disc: DiscState;

  localMediaPath: string;
  localMediaPickerBusy: boolean;
  localMediaPickerError: string | null;
  localMediaImportBusy: boolean;
  localMediaImportError: string | null;

  /** 已提取 / 已就绪、可参与导出的 Title 列表（即一个导出批次） */
  items: MediaItemState[];
  activeKey: string | null;

  outputDir: string;
  pickerStatus: 'idle' | 'opening' | 'unsupported' | 'error';
  pickerError: string | null;

  batchJob: BatchJob | null;
  exportStarting: boolean;
  exportError: string | null;
}

const initialState: MediaState = {
  bootstrapStatus: 'idle',
  health: null,
  config: null,
  bootstrapError: null,

  disc: {
    sourceKind: 'iso',
    sourcePath: '',
    pickerBusy: false,
    pickerError: null,
    scanStatus: 'idle',
    scanError: null,
    scan: null,
    selectedTitleIds: [],
    ripStatus: 'idle',
    ripError: null,
    ripJob: null,
    importedMediaIds: [],
  },

  localMediaPath: '',
  localMediaPickerBusy: false,
  localMediaPickerError: null,
  localMediaImportBusy: false,
  localMediaImportError: null,

  items: [],
  activeKey: null,

  outputDir: '',
  pickerStatus: 'idle',
  pickerError: null,

  batchJob: null,
  exportStarting: false,
  exportError: null,
};

function allStreamIndexes(media: MediaInfo): Record<TrackKind, number[]> {
  return {
    video: media.tracks.video.map((track) => track.streamIndex),
    audio: media.tracks.audio.map((track) => track.streamIndex),
    subtitle: media.tracks.subtitle
      .filter((track) => track.convertibleToSrt || track.convertibleToWebVtt || track.convertibleToSup)
      .map((track) => track.streamIndex),
  };
}

/** 该文件是否有字幕轨可用指定格式导出 */
export function subtitleFormatAvailable(tracks: MediaInfo['tracks']['subtitle'], format: SubtitleFormat): boolean {
  return tracks.some((track) =>
    format === 'webvtt' ? track.convertibleToWebVtt : track.convertibleToSrt
  );
}

/**
 * 计算真正下发给后端的导出选择
 * 导出视频时默认音轨会并入 MP4，因此不再单独导出为 mp3
 */
export function buildExportSelection(
  media: MediaInfo,
  selected: Record<TrackKind, number[]>,
  defaultAudio: number | null,
  subtitleFormat: SubtitleFormat
) {
  const requiresDefaultAudio = selected.video.length > 0 && media.tracks.audio.length > 0;
  return {
    requiresDefaultAudio,
    defaultAudio: requiresDefaultAudio ? defaultAudio : null,
    subtitleFormat,
    video: selected.video,
    audio: requiresDefaultAudio ? selected.audio.filter((index) => index !== defaultAudio) : selected.audio,
    subtitle: selected.subtitle,
    total: selected.video.length + selected.audio.length + selected.subtitle.length,
  };
}

/** 当前正在编辑的 Title / 文件条目 */
export function selectActiveItem(state: RootState): MediaItemState | null {
  const { items, activeKey } = state.media;
  if (!activeKey) return null;
  return items.find((item) => item.key === activeKey) ?? null;
}

/** 已就绪、可参与导出的条目 */
export function selectReadyItems(state: RootState): MediaItemState[] {
  return state.media.items.filter((item) => item.media);
}

export const bootstrap = createAsyncThunk('media/bootstrap', async () => {
  const [health, config] = await Promise.all([api.health(), api.config()]);
  return { health, config };
});

/* ------------------------------------------------------------------ */
/* 光盘来源：选择 -> 扫描 -> 选 Title -> 提取（解密生成 MKV 并解析轨道） */
/* ------------------------------------------------------------------ */

export const pickDiscSource = createAsyncThunk<
  { path?: string; cancelled?: boolean },
  DiscSourceKind,
  { rejectValue: { message: string; unsupported: boolean } }
>('media/pickDiscSource', async (kind, { rejectWithValue }) => {
  try {
    return await api.pickDiscSource(kind);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return rejectWithValue({
      message: error instanceof Error ? error.message : '打开选择框失败',
      unsupported: status === 501,
    });
  }
});

export const scanDiscSource = createAsyncThunk<DiscScanResult, void, { state: RootState; rejectValue: string }>(
  'media/scanDiscSource',
  async (_arg, { getState, rejectWithValue }) => {
    const sourcePath = getState().media.disc.sourcePath.trim();
    if (!sourcePath) return rejectWithValue('请先选择 ISO 文件或 BDMV 光盘根目录');
    try {
      return await api.scanDisc(sourcePath);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '扫描光盘失败');
    }
  }
);

export const pickLocalMediaFile = createAsyncThunk<
  { path?: string; cancelled?: boolean },
  void,
  { rejectValue: { message: string; unsupported: boolean } }
>('media/pickLocalMediaFile', async (_arg, { rejectWithValue }) => {
  try {
    return await api.pickMediaFile();
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return rejectWithValue({
      message: error instanceof Error ? error.message : '打开选择框失败',
      unsupported: status === 501,
    });
  }
});

export const importLocalMedia = createAsyncThunk<MediaInfo, void, { state: RootState; rejectValue: string }>(
  'media/importLocalMedia',
  async (_arg, { getState, rejectWithValue }) => {
    const sourcePath = getState().media.localMediaPath.trim();
    if (!sourcePath) return rejectWithValue('请先选择或填写本地媒体文件路径');
    try {
      return await api.importMediaFromPath(sourcePath);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '导入媒体文件失败');
    }
  }
);

export const importMainTitleFromDisc = createAsyncThunk<
  { sourcePath: string; media: MediaInfo },
  void,
  { state: RootState; rejectValue: string }
>('media/importMainTitleFromDisc', async (_arg, { getState, rejectWithValue }) => {
  const sourcePath = getState().media.disc.sourcePath.trim();
  if (!sourcePath) return rejectWithValue('请先选择或填写 BDMV 光盘根目录');
  try {
    return await api.importMainTitleFromDiscPath(sourcePath);
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : '自动导入主片失败');
  }
});

export const startRip = createAsyncThunk<RipJob, void, { state: RootState; rejectValue: string }>(
  'media/startRip',
  async (_arg, { getState, rejectWithValue }) => {
    const { scan, selectedTitleIds } = getState().media.disc;
    if (!scan) return rejectWithValue('请先扫描光盘');
    if (selectedTitleIds.length === 0) return rejectWithValue('请至少选择一个 Title');
    try {
      return await api.startRip(scan.id, selectedTitleIds);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '提取失败');
    }
  }
);

/** 轮询提取进度；一旦某个 Title 提取完成，立即拉取轨道信息并加入待导出列表 */
export const refreshRip = createAsyncThunk<RipJob, string, { state: RootState; rejectValue: string }>(
  'media/refreshRip',
  async (ripJobId, { getState, dispatch, rejectWithValue }) => {
    let job: RipJob;
    try {
      job = await api.getRip(ripJobId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '获取提取进度失败');
    }

    const imported = new Set(getState().media.disc.importedMediaIds);
    for (const entry of job.entries) {
      if (entry.status !== 'done' || !entry.mediaId || imported.has(entry.mediaId)) continue;
      try {
        const media = await api.getMedia(entry.mediaId);
        dispatch(itemFromDiscAdded({ mediaId: entry.mediaId, media, sourceLabel: entry.titleName }));
      } catch {
        // 媒体信息获取失败时跳过，下一轮轮询会再次尝试
      }
    }

    return job;
  }
);

export const cancelRip = createAsyncThunk<RipJob, string, { rejectValue: string }>(
  'media/cancelRip',
  async (ripJobId, { rejectWithValue }) => {
    try {
      return await api.cancelRip(ripJobId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '取消提取失败');
    }
  }
);

/* ------------------------------------------------------------------ */
/* 导出：与来源无关，统一对 items 里已就绪的 Title / 文件进行批量导出    */
/* ------------------------------------------------------------------ */

export const removeItem = createAsyncThunk<void, string, { state: RootState }>(
  'media/removeItem',
  async (key, { getState, dispatch }) => {
    const item = getState().media.items.find((entry) => entry.key === key);
    if (item?.media) {
      await api.deleteMedia(item.media.id).catch(() => undefined);
    }
    dispatch(itemRemoved(key));
  }
);

export const pickOutputDirectory = createAsyncThunk<
  { path?: string; cancelled?: boolean },
  void,
  { state: RootState; rejectValue: { message: string; unsupported: boolean } }
>('media/pickOutputDirectory', async (_arg, { getState, rejectWithValue }) => {
  const anchor = getState().media.items.find((item) => item.media);
  if (!anchor?.media) {
    return rejectWithValue({ message: '请先提取或选择媒体文件', unsupported: false });
  }
  try {
    return await api.pickDirectory(anchor.media.id);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    return rejectWithValue({
      message: error instanceof Error ? error.message : '打开目录选择框失败',
      unsupported: status === 501,
    });
  }
});

export const startBatchExport = createAsyncThunk<BatchJob, void, { state: RootState; rejectValue: string }>(
  'media/startBatchExport',
  async (_arg, { getState, rejectWithValue }) => {
    const { items, outputDir } = getState().media;
    const ready = items.filter((item) => item.media);
    if (ready.length === 0) return rejectWithValue('请先提取或选择媒体文件');
    if (!outputDir.trim()) return rejectWithValue('请先选择导出目录');

    const payload: BatchExportItem[] = [];
    for (const item of ready) {
      const media = item.media;
      if (!media) continue;
      const plan = buildExportSelection(media, item.selected, item.defaultAudio, item.subtitleFormat);
      if (plan.requiresDefaultAudio && plan.defaultAudio === null) {
        return rejectWithValue(`${media.file.name}：请先为视频选择默认音轨`);
      }
      if (plan.total === 0) {
        return rejectWithValue(`${media.file.name}：请至少勾选一条轨道`);
      }
      payload.push({
        mediaId: media.id,
        streams: { video: plan.video, audio: plan.audio, subtitle: plan.subtitle },
        defaultAudio: plan.defaultAudio,
        subtitleFormat: plan.subtitleFormat,
      });
    }

    try {
      return await api.startBatchExport(outputDir.trim(), payload);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '导出失败');
    }
  }
);

export const refreshBatch = createAsyncThunk<BatchJob, string, { rejectValue: string }>(
  'media/refreshBatch',
  async (batchId, { rejectWithValue }) => {
    try {
      return await api.getBatch(batchId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '获取导出进度失败');
    }
  }
);

export const cancelBatch = createAsyncThunk<BatchJob, string, { rejectValue: string }>(
  'media/cancelBatch',
  async (batchId, { rejectWithValue }) => {
    try {
      return await api.cancelBatch(batchId);
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '取消导出失败');
    }
  }
);

const mediaSlice = createSlice({
  name: 'media',
  initialState,
  reducers: {
    discSourceKindChanged(state, action: PayloadAction<DiscSourceKind>) {
      state.disc.sourceKind = action.payload;
    },
    discSourcePathChanged(state, action: PayloadAction<string>) {
      state.disc.sourcePath = action.payload;
      state.disc.pickerError = null;
    },
    localMediaPathChanged(state, action: PayloadAction<string>) {
      state.localMediaPath = action.payload;
      state.localMediaPickerError = null;
      state.localMediaImportError = null;
    },
    discSelectedTitlesSet(state, action: PayloadAction<number[]>) {
      state.disc.selectedTitleIds = action.payload;
    },
    discTitleToggled(state, action: PayloadAction<number>) {
      const ids = state.disc.selectedTitleIds;
      state.disc.selectedTitleIds = ids.includes(action.payload)
        ? ids.filter((id) => id !== action.payload)
        : [...ids, action.payload];
    },
    itemFromDiscAdded(
      state,
      action: PayloadAction<{ mediaId: string; media: MediaInfo; sourceLabel: string }>
    ) {
      const { mediaId, media, sourceLabel } = action.payload;
      if (state.disc.importedMediaIds.includes(mediaId)) return;
      state.disc.importedMediaIds.push(mediaId);

      const key = mediaId;
      state.items.push({
        key,
        sourceLabel,
        media,
        selected: allStreamIndexes(media),
        defaultAudio: null,
        subtitleFormat: 'webvtt',
      });
      if (!state.activeKey) state.activeKey = key;
      state.batchJob = null;
      state.exportError = null;
    },
    itemRemoved(state, action: PayloadAction<string>) {
      const index = state.items.findIndex((entry) => entry.key === action.payload);
      if (index < 0) return;
      state.items.splice(index, 1);
      state.disc.importedMediaIds = state.disc.importedMediaIds.filter((id) => id !== action.payload);
      if (state.activeKey === action.payload) {
        const fallback = state.items[index] ?? state.items[index - 1] ?? null;
        state.activeKey = fallback ? fallback.key : null;
      }
    },
    activeKeyChanged(state, action: PayloadAction<string>) {
      state.activeKey = action.payload;
    },
    trackToggled(state, action: PayloadAction<{ key: string; kind: TrackKind; streamIndex: number }>) {
      const item = state.items.find((entry) => entry.key === action.payload.key);
      if (!item) return;
      const { kind, streamIndex } = action.payload;
      const list = item.selected[kind];
      item.selected[kind] = list.includes(streamIndex)
        ? list.filter((value) => value !== streamIndex)
        : [...list, streamIndex];
    },
    kindSelectionSet(
      state,
      action: PayloadAction<{ key: string; kind: TrackKind; streamIndexes: number[] }>
    ) {
      const item = state.items.find((entry) => entry.key === action.payload.key);
      if (!item) return;
      item.selected[action.payload.kind] = action.payload.streamIndexes;
    },
    defaultAudioChanged(state, action: PayloadAction<{ key: string; streamIndex: number | null }>) {
      const item = state.items.find((entry) => entry.key === action.payload.key);
      if (!item) return;
      item.defaultAudio = action.payload.streamIndex;
    },
    subtitleFormatChanged(state, action: PayloadAction<{ key: string; format: SubtitleFormat }>) {
      const item = state.items.find((entry) => entry.key === action.payload.key);
      if (!item) return;
      item.subtitleFormat = action.payload.format;
    },
    /** 把某个 Title 的勾选、默认音轨与字幕格式套用到其余 Title（轨道索引会按目标的实际轨道过滤） */
    selectionAppliedToAll(state, action: PayloadAction<string>) {
      const source = state.items.find((entry) => entry.key === action.payload && entry.media);
      if (!source || !source.media) return;
      for (const item of state.items) {
        if (item.key === source.key || !item.media) continue;
        const videoIndexes = new Set(item.media.tracks.video.map((track) => track.streamIndex));
        const audioIndexes = new Set(item.media.tracks.audio.map((track) => track.streamIndex));
        const subtitleIndexes = new Set(item.media.tracks.subtitle.map((track) => track.streamIndex));
        item.selected = {
          video: source.selected.video.filter((index) => videoIndexes.has(index)),
          audio: source.selected.audio.filter((index) => audioIndexes.has(index)),
          subtitle: source.selected.subtitle.filter((index) => subtitleIndexes.has(index)),
        };
        item.subtitleFormat = source.subtitleFormat;
        item.defaultAudio =
          source.defaultAudio !== null && audioIndexes.has(source.defaultAudio) ? source.defaultAudio : null;
      }
    },
    outputDirChanged(state, action: PayloadAction<string>) {
      state.outputDir = action.payload;
      state.pickerError = null;
      if (state.pickerStatus === 'error') state.pickerStatus = 'idle';
    },
    exportErrorCleared(state) {
      state.exportError = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(bootstrap.pending, (state) => {
        state.bootstrapStatus = 'loading';
      })
      .addCase(bootstrap.fulfilled, (state, action) => {
        state.bootstrapStatus = 'ready';
        state.health = action.payload.health;
        state.config = action.payload.config;
        state.bootstrapError = null;
      })
      .addCase(bootstrap.rejected, (state, action) => {
        state.bootstrapStatus = 'error';
        state.bootstrapError = action.error.message || '初始化失败';
      })

      .addCase(pickDiscSource.pending, (state) => {
        state.disc.pickerBusy = true;
        state.disc.pickerError = null;
      })
      .addCase(pickDiscSource.fulfilled, (state, action) => {
        state.disc.pickerBusy = false;
        if (action.payload.path) {
          state.disc.sourcePath = action.payload.path;
          state.disc.scanStatus = 'idle';
          state.disc.scan = null;
        }
      })
      .addCase(pickDiscSource.rejected, (state, action) => {
        state.disc.pickerBusy = false;
        state.disc.pickerError = action.payload?.message || action.error.message || '打开选择框失败';
      })

      .addCase(scanDiscSource.pending, (state) => {
        state.disc.scanStatus = 'scanning';
        state.disc.scanError = null;
      })
      .addCase(scanDiscSource.fulfilled, (state, action) => {
        state.disc.scanStatus = 'ready';
        state.disc.scan = action.payload;
        state.disc.selectedTitleIds = action.payload.titles
          .filter((title) => title.isLikelyMainMovie)
          .map((title) => title.id);
      })
      .addCase(scanDiscSource.rejected, (state, action) => {
        state.disc.scanStatus = 'error';
        state.disc.scanError = action.payload || action.error.message || '扫描光盘失败';
      })

      .addCase(pickLocalMediaFile.pending, (state) => {
        state.localMediaPickerBusy = true;
        state.localMediaPickerError = null;
      })
      .addCase(pickLocalMediaFile.fulfilled, (state, action) => {
        state.localMediaPickerBusy = false;
        if (action.payload.path) state.localMediaPath = action.payload.path;
      })
      .addCase(pickLocalMediaFile.rejected, (state, action) => {
        state.localMediaPickerBusy = false;
        state.localMediaPickerError = action.payload?.message || action.error.message || '打开选择框失败';
      })

      .addCase(importLocalMedia.pending, (state) => {
        state.localMediaImportBusy = true;
        state.localMediaImportError = null;
      })
      .addCase(importLocalMedia.fulfilled, (state, action) => {
        state.localMediaImportBusy = false;
        const media = action.payload;
        const key = media.id;
        state.items.push({
          key,
          sourceLabel: media.file.name,
          media,
          selected: allStreamIndexes(media),
          defaultAudio: null,
          subtitleFormat: 'webvtt',
        });
        state.activeKey = key;
        state.batchJob = null;
        state.exportError = null;
      })
      .addCase(importLocalMedia.rejected, (state, action) => {
        state.localMediaImportBusy = false;
        state.localMediaImportError = action.payload || action.error.message || '导入媒体文件失败';
      })

      .addCase(importMainTitleFromDisc.pending, (state) => {
        state.localMediaImportBusy = true;
        state.localMediaImportError = null;
      })
      .addCase(importMainTitleFromDisc.fulfilled, (state, action) => {
        state.localMediaImportBusy = false;
        state.localMediaPath = action.payload.sourcePath;
        const media = action.payload.media;
        const key = media.id;
        state.items.push({
          key,
          sourceLabel: media.file.name,
          media,
          selected: allStreamIndexes(media),
          defaultAudio: null,
          subtitleFormat: 'webvtt',
        });
        state.activeKey = key;
        state.batchJob = null;
        state.exportError = null;
      })
      .addCase(importMainTitleFromDisc.rejected, (state, action) => {
        state.localMediaImportBusy = false;
        state.localMediaImportError = action.payload || action.error.message || '自动导入主片失败';
      })

      .addCase(startRip.pending, (state) => {
        state.disc.ripStatus = 'starting';
        state.disc.ripError = null;
      })
      .addCase(startRip.fulfilled, (state, action) => {
        state.disc.ripStatus = 'running';
        state.disc.ripJob = action.payload;
      })
      .addCase(startRip.rejected, (state, action) => {
        state.disc.ripStatus = 'error';
        state.disc.ripError = action.payload || action.error.message || '提取失败';
      })

      .addCase(refreshRip.fulfilled, (state, action) => {
        if (state.disc.ripJob?.id !== action.payload.id) return;
        state.disc.ripJob = action.payload;
        if (action.payload.status === 'completed') state.disc.ripStatus = 'done';
        if (action.payload.status === 'cancelled') state.disc.ripStatus = 'idle';
        if (action.payload.status === 'failed') state.disc.ripStatus = 'error';
      })

      .addCase(cancelRip.fulfilled, (state, action) => {
        if (state.disc.ripJob?.id === action.payload.id) state.disc.ripJob = action.payload;
        state.disc.ripStatus = 'idle';
      })

      .addCase(pickOutputDirectory.pending, (state) => {
        state.pickerStatus = 'opening';
        state.pickerError = null;
      })
      .addCase(pickOutputDirectory.fulfilled, (state, action) => {
        state.pickerStatus = 'idle';
        if (action.payload.path) state.outputDir = action.payload.path;
      })
      .addCase(pickOutputDirectory.rejected, (state, action) => {
        const payload = action.payload;
        state.pickerStatus = payload?.unsupported ? 'unsupported' : 'error';
        state.pickerError = payload?.message || action.error.message || '打开目录选择框失败';
      })

      .addCase(startBatchExport.pending, (state) => {
        state.exportStarting = true;
        state.exportError = null;
      })
      .addCase(startBatchExport.fulfilled, (state, action) => {
        state.exportStarting = false;
        state.batchJob = action.payload;
      })
      .addCase(startBatchExport.rejected, (state, action) => {
        state.exportStarting = false;
        state.exportError = action.payload || action.error.message || '导出失败';
      })

      .addCase(refreshBatch.fulfilled, (state, action) => {
        if (state.batchJob?.id === action.payload.id) state.batchJob = action.payload;
      })

      .addCase(cancelBatch.fulfilled, (state, action) => {
        if (state.batchJob?.id === action.payload.id) state.batchJob = action.payload;
      });
  },
});

export const {
  discSourceKindChanged,
  discSourcePathChanged,
  localMediaPathChanged,
  discSelectedTitlesSet,
  discTitleToggled,
  itemFromDiscAdded,
  itemRemoved,
  activeKeyChanged,
  trackToggled,
  kindSelectionSet,
  defaultAudioChanged,
  subtitleFormatChanged,
  selectionAppliedToAll,
  outputDirChanged,
  exportErrorCleared,
} = mediaSlice.actions;

export default mediaSlice.reducer;
