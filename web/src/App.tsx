import { useEffect } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Disc3, Loader2, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiscSourceCard } from '@/components/DiscSourceCard';
import { ExportCard } from '@/components/ExportCard';
import { MediaSummaryCard } from '@/components/MediaSummaryCard';
import { TrackTables } from '@/components/TrackTables';
import { bootstrap } from '@/store/mediaSlice';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

function BinaryStatus() {
  const { bootstrapStatus, health } = useAppSelector((state) => state.media);

  if (bootstrapStatus === 'loading' || bootstrapStatus === 'idle') {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin" />
        检测环境
      </Badge>
    );
  }

  if (!health) {
    return (
      <Badge variant="destructive">
        <TriangleAlert />
        无法连接后端
      </Badge>
    );
  }

  const { ffmpeg, ffprobe, makemkvcon } = health.binaries;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={ffmpeg.available && ffprobe.available ? 'secondary' : 'destructive'} title={ffmpeg.path ?? undefined}>
        {ffmpeg.available ? `FFmpeg ${ffmpeg.version}` : '未检测到 FFmpeg'}
      </Badge>
      <Badge variant={makemkvcon.available ? 'secondary' : 'destructive'} title={makemkvcon.path ?? undefined}>
        {makemkvcon.available ? 'MakeMKV 已就绪' : '未检测到 MakeMKV'}
      </Badge>
    </div>
  );
}

function SectionPins({ showExport }: { showExport: boolean }) {
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const scrollToExport = () => {
    document.getElementById('export-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="pointer-events-none fixed inset-y-0 left-1/2 z-20 w-full max-w-6xl -translate-x-1/2 px-6">
      <div className="pointer-events-auto absolute top-1/2 right-0 flex -translate-y-1/2 flex-col gap-2">
        <Button
          variant="outline"
          size="icon"
          className="bg-background/90 shadow-md backdrop-blur"
          title="回到顶部"
          aria-label="回到顶部"
          onClick={scrollToTop}
        >
          <ArrowUpToLine />
        </Button>
        {showExport && (
          <Button
            variant="outline"
            size="icon"
            className="bg-background/90 shadow-md backdrop-blur"
            title="导出到本地目录"
            aria-label="跳转到导出到本地目录"
            onClick={scrollToExport}
          >
            <ArrowDownToLine />
          </Button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const dispatch = useAppDispatch();
  const { bootstrapStatus, bootstrapError, health } = useAppSelector((state) => state.media);
  const readyCount = useAppSelector(
    (state) => state.media.items.filter((item) => item.media).length
  );

  useEffect(() => {
    void dispatch(bootstrap());
  }, [dispatch]);

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-background sticky top-0 z-10 border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
              <Disc3 className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">UHD/BD 原盘轨道分离工具</h1>
              <p className="text-muted-foreground text-xs">
                MakeMKV 解密提取 Title，FFmpeg 按轨道分离视频/音频/字幕，输出目录可直接供 convert-to-hls 消费
              </p>
            </div>
          </div>
          <BinaryStatus />
        </div>
      </header>

      <SectionPins showExport={readyCount > 0} />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        {bootstrapStatus === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>
              {bootstrapError || '无法连接后端服务'}；请确认后端已启动（npm run dev / npm start）。
            </AlertDescription>
          </Alert>
        )}

        {bootstrapStatus === 'ready' && health && !health.binaries.makemkvcon.available && (
          <Alert variant="destructive">
            <AlertDescription>
              后端未找到 MakeMKV（makemkvcon）：{health.binaries.makemkvcon.message}
              。请先安装 MakeMKV 并确保命令行工具可用，才能解密提取 UHD/BD 原盘。
            </AlertDescription>
          </Alert>
        )}

        {bootstrapStatus === 'ready' && health && (!health.binaries.ffmpeg.available || !health.binaries.ffprobe.available) && (
          <Alert variant="destructive">
            <AlertDescription>
              后端未找到 FFmpeg/FFprobe：{health.binaries.ffmpeg.message || health.binaries.ffprobe.message}
              。可执行 <span className="font-mono">brew install ffmpeg</span>，或在 server 目录执行{' '}
              <span className="font-mono">npm install</span> 以启用内置二进制。
            </AlertDescription>
          </Alert>
        )}

        <DiscSourceCard />
        {readyCount > 0 && <MediaSummaryCard />}
        {readyCount > 0 && <TrackTables />}
        {readyCount > 0 && <ExportCard />}
      </main>
    </div>
  );
}
