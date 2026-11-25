import { useEffect } from 'react';
import { Check, Disc3, FileSearch, FolderOpen, Loader2, RotateCcw, TriangleAlert, X } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration, formatGbBytes, formatText } from '@/lib/format';
import type { DiscTitle, RipEntry } from '@/lib/types';
import {
  cancelRip,
  discSelectedTitlesSet,
  discSourceKindChanged,
  discSourcePathChanged,
  discTitleToggled,
  importMainTitleFromDisc,
  importLocalMedia,
  localMediaPathChanged,
  pickLocalMediaFile,
  pickDiscSource,
  refreshRip,
  resetDiscSource,
  scanDiscSource,
  startRip,
} from '@/store/mediaSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

function titleAudioSummary(title: DiscTitle): string {
  if (title.audioTracks.length === 0) return '—';
  return title.audioTracks
    .map((track) => `${track.langName || track.langCode || '未知'}${track.codec ? `(${track.codec})` : ''}`)
    .join(' / ');
}

function RipEntryRow({ entry }: { entry: RipEntry }) {
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs break-all">{entry.titleName}</span>
        {entry.status === 'pending' && <Badge variant="outline">等待中</Badge>}
        {entry.status === 'running' && (
          <Badge variant="secondary">
            <Loader2 className="animate-spin" />
            提取中
          </Badge>
        )}
        {entry.status === 'done' && <Badge variant="success">已完成</Badge>}
        {entry.status === 'cancelled' && <Badge variant="outline">已取消</Badge>}
        {entry.status === 'failed' && <Badge variant="destructive">失败</Badge>}
        {entry.status === 'running' && (
          <span className="text-muted-foreground ml-auto text-xs">{entry.percent.toFixed(0)}%</span>
        )}
        {entry.status === 'done' && <Check className="ml-auto size-4 text-emerald-600" />}
      </div>
      {entry.status === 'running' && <Progress value={entry.percent} className="h-1.5" />}
      {entry.status === 'running' && entry.stage && (
        <p className="text-muted-foreground text-xs">{entry.stage}</p>
      )}
      {entry.status === 'failed' && entry.error && (
        <p className="text-destructive text-xs">失败原因：{entry.error}</p>
      )}
    </div>
  );
}

export function DiscSourceCard() {
  const dispatch = useAppDispatch();
  const disc = useAppSelector((state) => state.media.disc);
  const localMediaPath = useAppSelector((state) => state.media.localMediaPath);
  const localMediaPickerBusy = useAppSelector((state) => state.media.localMediaPickerBusy);
  const localMediaPickerError = useAppSelector((state) => state.media.localMediaPickerError);
  const localMediaImportBusy = useAppSelector((state) => state.media.localMediaImportBusy);
  const localMediaImportError = useAppSelector((state) => state.media.localMediaImportError);
  const { sourceKind, sourcePath, pickerBusy, pickerError, scanStatus, scanError, scan, selectedTitleIds, resetBusy } =
    disc;
  const { ripStatus, ripError, ripJob } = disc;

  const ripBusy = ripStatus === 'starting' || ripStatus === 'running';

  useEffect(() => {
    if (!ripJob || !ripBusy) return undefined;
    const timer = window.setInterval(() => {
      void dispatch(refreshRip(ripJob.id));
    }, 800);
    return () => window.clearInterval(timer);
  }, [dispatch, ripJob, ripBusy]);

  const titles = scan?.titles ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. 选择光盘来源并提取 Title</CardTitle>
        <CardDescription>
          支持 ISO 镜像文件或已解密的 BDMV 光盘根目录；后端调用本机安装的 MakeMKV 解密并生成 MKV，再由 FFmpeg 按轨道分离
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={sourceKind === 'iso' ? 'default' : 'outline'}
            disabled={pickerBusy}
            onClick={() => {
              dispatch(discSourceKindChanged('iso'));
              void dispatch(pickDiscSource('iso'));
            }}
          >
            {pickerBusy && sourceKind === 'iso' ? <Loader2 className="animate-spin" /> : <Disc3 />}
            选择 ISO 文件
          </Button>
          <Button
            variant={sourceKind === 'folder' ? 'default' : 'outline'}
            disabled={pickerBusy}
            onClick={() => {
              dispatch(discSourceKindChanged('folder'));
              void dispatch(pickDiscSource('folder'));
            }}
          >
            {pickerBusy && sourceKind === 'folder' ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            选择 BDMV 文件夹
          </Button>
          <Input
            value={sourcePath}
            onChange={(event) => dispatch(discSourcePathChanged(event.target.value))}
            placeholder="也可直接粘贴绝对路径，例如 /Volumes/Movies/MOVIE.iso"
            className="min-w-[16rem] flex-1 font-mono text-xs"
          />
          <Button
            disabled={!sourcePath.trim() || scanStatus === 'scanning'}
            onClick={() => void dispatch(scanDiscSource())}
          >
            {scanStatus === 'scanning' ? <Loader2 className="animate-spin" /> : <FileSearch />}
            {scanStatus === 'scanning' ? '扫描中…' : '解析光盘'}
          </Button>
          <Button
            variant="outline"
            title="清空扫描结果并释放自动挂载的 ISO"
            disabled={resetBusy || scanStatus === 'scanning'}
            onClick={() => void dispatch(resetDiscSource())}
          >
            {resetBusy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            重置
          </Button>
        </div>

        {pickerError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{pickerError}</AlertDescription>
          </Alert>
        )}
        {scanError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{scanError}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3 rounded-lg border border-dashed p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">MakeMKV 扫描崩溃时，直接导入主片文件</p>
            <p className="text-muted-foreground text-xs">
              可直接选择主片 <span className="font-mono">.m2ts / .mkv / .mp4</span> 文件，或粘贴 BDMV 根目录 /{' '}
              <span className="font-mono">.iso</span> 镜像路径；填目录或 ISO 时会自动识别体积最大的主片并导入（ISO 会自动挂载）
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={localMediaPickerBusy || localMediaImportBusy}
              onClick={() => void dispatch(pickLocalMediaFile())}
            >
              {localMediaPickerBusy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              选择主片文件
            </Button>
            <Input
              value={localMediaPath}
              onChange={(event) => dispatch(localMediaPathChanged(event.target.value))}
              placeholder="也可直接粘贴绝对路径，例如 /Volumes/.../BDMV/STREAM/00006.m2ts、/Volumes/.../电影目录 或 /Volumes/.../MOVIE.iso"
              className="min-w-[16rem] flex-1 font-mono text-xs"
            />
            <Button
              disabled={!localMediaPath.trim() || localMediaImportBusy}
              onClick={() => void dispatch(importLocalMedia())}
            >
              {localMediaImportBusy ? <Loader2 className="animate-spin" /> : <FileSearch />}
              {localMediaImportBusy ? '导入中…' : '导入媒体'}
            </Button>
            <Button
              variant="secondary"
              disabled={!sourcePath.trim() || localMediaImportBusy}
              onClick={() => void dispatch(importMainTitleFromDisc())}
            >
              {localMediaImportBusy ? <Loader2 className="animate-spin" /> : <Disc3 />}
              {localMediaImportBusy ? '识别中…' : '从当前来源自动导入主片'}
            </Button>
          </div>
          {localMediaPickerError && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{localMediaPickerError}</AlertDescription>
            </Alert>
          )}
          {localMediaImportError && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{localMediaImportError}</AlertDescription>
            </Alert>
          )}
        </div>

        {scan && (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              {formatText(scan.discName, '未知光盘')}
              <span className="text-muted-foreground ml-2 text-xs">
                共 {titles.length} 个 Title，已选 {selectedTitleIds.length} 个
              </span>
            </p>

            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Title</TableHead>
                    <TableHead>时长</TableHead>
                    <TableHead>章节</TableHead>
                    <TableHead>大小</TableHead>
                    <TableHead>视频</TableHead>
                    <TableHead>音频</TableHead>
                    <TableHead>字幕</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {titles.map((title) => (
                    <TableRow key={title.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedTitleIds.includes(title.id)}
                          onCheckedChange={() => dispatch(discTitleToggled(title.id))}
                          aria-label={`选择 Title ${title.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="font-medium">
                            #{title.id} {formatText(title.name, '')}
                            {title.isLikelyMainMovie && (
                              <Badge variant="secondary" className="ml-2">
                                推荐主标题
                              </Badge>
                            )}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{formatDuration(title.durationSec)}</TableCell>
                      <TableCell>{title.chapters || '—'}</TableCell>
                      <TableCell>{formatGbBytes(title.sizeBytes)}</TableCell>
                      <TableCell>{title.videoCount || '—'}</TableCell>
                      <TableCell className="max-w-[14rem] truncate text-xs" title={titleAudioSummary(title)}>
                        {titleAudioSummary(title)}
                      </TableCell>
                      <TableCell>{title.subtitleCount || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch(discSelectedTitlesSet(titles.map((title) => title.id)))}
              >
                全选
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dispatch(
                    discSelectedTitlesSet(titles.filter((title) => title.isLikelyMainMovie).map((title) => title.id))
                  )
                }
              >
                仅主标题
              </Button>
              <Button
                className="ml-auto"
                disabled={selectedTitleIds.length === 0 || ripBusy}
                onClick={() => void dispatch(startRip())}
              >
                {ripBusy ? <Loader2 className="animate-spin" /> : <Disc3 />}
                {ripBusy ? '提取中…' : '提取所选 Title（解密生成 MKV）'}
              </Button>
            </div>
          </div>
        )}

        {ripError && (
          <Alert variant="destructive">
            <AlertDescription>{ripError}</AlertDescription>
          </Alert>
        )}

        {ripJob && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                提取进度
                <span className="text-muted-foreground ml-2 text-xs">
                  {ripJob.completed} / {ripJob.total}
                  {ripJob.failed > 0 ? ` · 失败 ${ripJob.failed}` : ''}
                </span>
              </p>
              {ripBusy && (
                <Button variant="outline" size="sm" onClick={() => void dispatch(cancelRip(ripJob.id))}>
                  <X />
                  取消提取
                </Button>
              )}
            </div>
            <div className="divide-y rounded-lg border">
              {ripJob.entries.map((entry) => (
                <RipEntryRow key={entry.titleId} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
