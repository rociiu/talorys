import { useState, useRef } from "react";
import {
  Monitor,
  Play,
  Hand,
  RefreshCw,
  Power,
  X,
  Maximize2,
  ExternalLink,
  Globe,
} from "lucide-react";
import { useComputerStatus, useComputerActions } from "../hooks/computer";
import { Button, Badge, Spinner } from "./ui";

interface ComputerViewerProps {
  open: boolean;
  onClose: () => void;
}

export function ComputerViewer({ open, onClose }: ComputerViewerProps) {
  const { data, isLoading } = useComputerStatus();
  const { startSession, stopSession, takeControl, returnControl } = useComputerActions();
  const [iframeKey, setIframeKey] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  if (!open) return null;

  const session = data?.session;
  const isRunning = session?.status === "running";
  const isUserControlling = session?.controlMode === "user_controlling";

  const refreshIframe = () => setIframeKey((k) => k + 1);

  return (
    <div
      className={
        fullScreen
          ? "fixed inset-0 z-50 flex flex-col bg-surface"
          : "fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-surface shadow-2xl sm:w-[680px] lg:w-[820px]"
      }
    >
      {/* Top Header / Control Bar */}
      <div className="flex h-14 items-center justify-between border-b border-border px-4 py-2 bg-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <Monitor className="h-5 w-5 text-accent shrink-0" />
          <span className="font-semibold text-sm shrink-0">클라우드 컴퓨터</span>

          {isRunning ? (
            isUserControlling ? (
              <Badge tone="warning" className="shrink-0 flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-warning animate-pulse" />
                사용자 직접 조작
              </Badge>
            ) : (
              <Badge tone="accent" className="shrink-0 flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
                AI 조작 중
              </Badge>
            )
          ) : (
            <Badge tone="neutral" className="shrink-0">유휴 상태</Badge>
          )}

          {session?.currentUrl && isRunning && (
            <span className="hidden sm:flex items-center gap-1 text-xs text-fg-muted truncate ml-2 max-w-[240px]">
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{session.currentTitle || session.currentUrl}</span>
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning ? (
            <>
              {isUserControlling ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => returnControl.mutate()}
                  loading={returnControl.isPending}
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  <Play className="h-3.5 w-3.5" /> AI에게 넘기기
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => takeControl.mutate()}
                  loading={takeControl.isPending}
                  className="gap-1.5 border-warning/40 text-warning hover:bg-warning/10"
                >
                  <Hand className="h-3.5 w-3.5" /> 직접 조작하기
                </Button>
              )}

              <Button size="icon" variant="ghost" title="화면 새로고침" onClick={refreshIframe}>
                <RefreshCw className="h-4 w-4" />
              </Button>

              <Button
                size="icon"
                variant="ghost"
                title="컴퓨터 끄기"
                onClick={() => stopSession.mutate()}
                loading={stopSession.isPending}
                className="text-danger hover:bg-danger/10"
              >
                <Power className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => startSession.mutate()}
              loading={startSession.isPending}
              className="gap-1.5"
            >
              <Power className="h-3.5 w-3.5" /> 컴퓨터 켜기
            </Button>
          )}

          <Button
            size="icon"
            variant="ghost"
            title={fullScreen ? "원래 크기로" : "전체 화면"}
            onClick={() => setFullScreen(!fullScreen)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>

          <Button size="icon" variant="ghost" title="닫기" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Screen Display Area */}
      <div className="relative flex-1 bg-black overflow-hidden flex items-center justify-center">
        {isRunning ? (
          <>
            <iframe
              ref={iframeRef}
              key={iframeKey}
              title="Cloud Computer Display"
              src={`/api/computer/vnc/index.html?autoconnect=true&resize=remote${!isUserControlling ? "&view_only=true" : ""}`}
              className={`h-full w-full border-0 ${!isUserControlling ? "pointer-events-none select-none" : ""}`}
              allow="clipboard-read; clipboard-write"
            />

            {/* 관찰 모드 입력 차단 투명 오버레이 */}
            {!isUserControlling && (
              <div
                className="absolute inset-0 z-10 cursor-not-allowed bg-black/5"
                title="AI 관찰 모드입니다. 직접 조작하려면 상단의 [직접 조작하기]를 클릭하세요."
                onClick={() => {
                  takeControl.mutate();
                }}
              />
            )}

            {/* AI Control Notice Overlay (when not in user_controlling mode) */}
            {!isUserControlling && (
              <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-lg border border-border/80 bg-surface/90 px-3 py-2 text-xs backdrop-blur shadow-lg">
                <span className="h-2 w-2 rounded-full bg-accent animate-ping" />
                <span className="text-fg font-medium">AI 관찰 모드</span>
                <span className="text-fg-muted">· 화면을 클릭하거나 상단의 [직접 조작하기]를 누르면 사용자가 제어합니다.</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center p-8 text-center text-fg-muted">
            <Monitor className="h-16 w-16 mb-4 opacity-30" />
            <h3 className="text-base font-semibold text-fg">격리된 클라우드 컴퓨터</h3>
            <p className="mt-1 text-sm max-w-sm">
              AI에게 웹 탐색, 데이터 수집, 브라우저 작업을 지시하면 자동으로 컴퓨터가 켜지며 실시간으로 관찰할 수 있습니다.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 gap-2"
              onClick={() => startSession.mutate()}
              loading={startSession.isPending}
            >
              <Power className="h-4 w-4" /> 수동으로 컴퓨터 켜기
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
