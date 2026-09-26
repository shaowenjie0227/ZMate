import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  Globe,
  LoaderCircle,
  Play,
  Server,
  Terminal,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api } from "@/lib/api";
import type {
  ProviderApiType,
  ProviderSummary,
  StreamTestProgressEvent,
  StreamTestStage,
} from "@/types";
import { Button } from "@/components/ui/button";
import { ButtonBusyContent } from "@/components/ui/button-busy-content";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface StreamTestOutcome {
  success: boolean;
  firstPacketMs: number | null;
  message: string;
}

interface TestState {
  httpStatus: number | null;
  statusMs: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  ok: boolean | null;
  error: string | null;
}

const INITIAL_TEST: TestState = {
  httpStatus: null,
  statusMs: null,
  firstTokenMs: null,
  totalMs: null,
  ok: null,
  error: null,
};

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function latencyTone(ms: number): "ok" | "warn" | "error" {
  if (ms <= 3000) return "ok";
  if (ms <= 7000) return "warn";
  return "error";
}

function safeHost(base_url: string): string {
  try {
    return new URL(base_url).host;
  } catch {
    return base_url;
  }
}

function displayPath(apiType: ProviderApiType, baseUrl: string): string {
  let pathname = "";
  try {
    pathname = new URL(baseUrl).pathname.replace(/\/$/, "");
  } catch {
    // baseUrl 非法时退化为纯后缀
  }
  const suffix =
    apiType === "anthropic-messages"
      ? "/v1/messages"
      : apiType === "openai-chat-completions"
        ? "/chat/completions"
        : "/responses";
  return `${pathname}${suffix}`;
}

type ChipTone = "neutral" | "ok" | "warn" | "error" | "info";

function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: ChipTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1 rounded-full border px-2.5 text-xs font-medium",
        tone === "neutral" && "border-border bg-muted text-muted-foreground",
        tone === "ok" &&
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        tone === "warn" &&
          "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        tone === "error" &&
          "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
        tone === "info" && "border-primary/25 bg-primary/10 text-primary",
        className,
      )}
    >
      {children}
    </span>
  );
}

function TestStep({
  index,
  reached,
  failedStep,
  running,
  label,
  ms,
  scaleMs,
  icon: Icon,
  isLast,
}: {
  index: number;
  reached: number;
  failedStep: number | null;
  running: boolean;
  label: string;
  ms?: number | null;
  scaleMs?: number;
  icon: LucideIcon;
  isLast?: boolean;
}) {
  const isReached = reached >= index;
  const isFailed = failedStep === index;
  const isActive = !isReached && !isFailed && running && reached === index - 1;
  const hasBar = isReached && ms != null && ms > 0 && (scaleMs ?? 0) > 0;
  const width = hasBar ? Math.min(((ms ?? 0) / (scaleMs ?? 1)) * 100, 100) : 0;

  return (
    <div className="relative flex items-start gap-3 pb-5 last:pb-0">
      {isLast ? null : (
        <span
          className={cn(
            "absolute left-[13px] top-7 bottom-0 w-px transition-colors duration-500",
            isReached ? "bg-primary/40" : "bg-border",
          )}
          aria-hidden
        />
      )}
      <div className="relative z-10 shrink-0">
        <div
          className={cn(
            "flex h-[27px] w-[27px] items-center justify-center rounded-full border-2 transition-all duration-300",
            isFailed
              ? "border-red-500 bg-red-500/15 text-red-500"
              : isReached
                ? "border-primary bg-primary/15 text-primary"
                : isActive
                  ? "animate-pulse border-foreground/40 bg-muted text-foreground/80"
                  : "border-border bg-card text-muted-foreground/50",
          )}
        >
          {isReached ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-[27px] items-center justify-between gap-2">
          <p
            className={cn(
              "text-xs font-medium transition-colors",
              isFailed
                ? "text-red-500"
                : isReached
                  ? "text-foreground/90"
                  : isActive
                    ? "text-foreground"
                    : "text-muted-foreground/60",
            )}
          >
            {label}
          </p>
          {ms != null && ms > 0 ? (
            <span
              className={cn(
                "font-mono text-xs transition-opacity duration-500",
                isReached ? "text-muted-foreground" : "opacity-0",
              )}
            >
              {formatMs(ms)}
            </span>
          ) : null}
        </div>
        {hasBar ? (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="relative h-full rounded-full bg-primary transition-all duration-700 ease-out"
              style={{ width: `${width}%` }}
            >
              <span className="absolute bottom-0 right-0 top-0 w-3 bg-gradient-to-l from-white/40 to-transparent" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StreamTestDialog({
  provider,
  initialModelId,
  onClose,
  onFinished,
}: {
  provider: ProviderSummary;
  initialModelId: string;
  onClose: () => void;
  onFinished: (providerId: string, outcome: StreamTestOutcome) => void;
}) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState(initialModelId);
  const [running, setRunning] = useState(false);
  const [hasUrl, setHasUrl] = useState(false);
  const [reply, setReply] = useState("");
  const [test, setTest] = useState<TestState>(INITIAL_TEST);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const runTokenRef = useRef(0);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reply]);

  const failed = test.ok === false || test.error !== null;
  const passed = test.ok === true;
  const hasContent = running || hasUrl || test.ok !== null;

  let reached = 0;
  if (hasUrl) reached = 1;
  if (test.statusMs !== null) reached = 2;
  if (test.firstTokenMs !== null) reached = 3;
  if (passed && test.totalMs !== null) reached = 4;
  const failedStep = failed ? reached + 1 : null;
  const scaleMs = Math.max(
    test.totalMs ?? 0,
    test.firstTokenMs ?? 0,
    test.statusMs ?? 0,
    1,
  );
  const statusOk =
    test.httpStatus != null && test.httpStatus >= 200 && test.httpStatus < 300;

  const requestHost =
    hasUrl || test.ok !== null
      ? (safeHost(provider.baseUrl))
      : null;
  const requestPath = displayPath(provider.apiType, provider.baseUrl);

  const runTest = async () => {
    if (running || !modelId) return;
    const token = ++runTokenRef.current;
    setRunning(true);
    setReply("");
    setHasUrl(true);
    setTest(INITIAL_TEST);

    unlistenRef.current?.();
    unlistenRef.current = await listen<StreamTestProgressEvent>(
      "provider-stream-test-progress",
      (event) => {
        if (token !== runTokenRef.current) return;
        const payload = event.payload;
        if (payload.providerId !== provider.providerId) return;
        if (payload.modelId !== modelId) return;
        setTest((prev) => {
          switch (payload.stage as StreamTestStage) {
            case "headers":
              return {
                ...prev,
                httpStatus: payload.statusCode,
                statusMs: payload.elapsedMs,
              };
            case "first-packet":
              return { ...prev, firstTokenMs: payload.elapsedMs };
            case "done":
              return { ...prev, totalMs: payload.elapsedMs };
            default:
              return prev;
          }
        });
      },
    );

    try {
      const response = await api.streamTestProviderModel(
        provider.providerId,
        modelId,
      );
      if (token !== runTokenRef.current) return;
      const data = response.data;
      setTest({
        httpStatus: data.statusCode,
        statusMs: data.headerMs,
        firstTokenMs: data.firstPacketMs,
        totalMs: data.totalMs,
        ok: data.success,
        error: data.success ? null : data.message,
      });
      setReply(data.reply);
      onFinished(provider.providerId, {
        success: data.success,
        firstPacketMs: data.firstPacketMs,
        message: data.message,
      });
    } catch (e) {
      if (token !== runTokenRef.current) return;
      setTest((prev) => ({
        ...prev,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      if (token === runTokenRef.current) {
        setRunning(false);
        unlistenRef.current?.();
        unlistenRef.current = null;
      }
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !running && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Wifi className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <DialogTitle>{t("providers.streamTestTitle")}</DialogTitle>
            <DialogDescription className="mt-1">
              {t("providers.streamTestDesc", { name: provider.providerName })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/40 p-3 dark:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {t("providers.testModelLabel")}
            </span>
            <Select
              value={modelId}
              onValueChange={setModelId}
              disabled={running || provider.models.length <= 1}
            >
              <SelectTrigger className="h-9 w-auto min-w-0 max-w-[260px] rounded-[8px] font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {provider.models.map((model) => (
                  <SelectItem
                    key={model.modelId}
                    value={model.modelId}
                    className="font-mono text-xs"
                  >
                    {model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {running ? (
              <Chip tone="info">
                <LoaderCircle className="h-3 w-3 animate-spin" />
                {t("providers.testRunning")}
              </Chip>
            ) : null}
            {passed ? (
              <Chip tone="ok">
                <CheckCircle2 className="h-3 w-3" />
                {t("providers.testPassed")}
              </Chip>
            ) : null}
            {failed ? (
              <Chip tone="error">{t("providers.testFailed")}</Chip>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 items-center gap-5 md:grid-cols-[180px_1fr]">
          <div className="md:pl-1">
            <TestStep
              index={1}
              reached={reached}
              failedStep={failedStep}
              running={running}
              label={t("providers.stageSent")}
              icon={Globe}
            />
            <TestStep
              index={2}
              reached={reached}
              failedStep={failedStep}
              running={running}
              label={t("providers.stageHeaders")}
              ms={test.statusMs}
              scaleMs={scaleMs}
              icon={Server}
            />
            <TestStep
              index={3}
              reached={reached}
              failedStep={failedStep}
              running={running}
              label={t("providers.stageFirstPacket")}
              ms={test.firstTokenMs}
              scaleMs={scaleMs}
              icon={Zap}
            />
            <TestStep
              index={4}
              reached={reached}
              failedStep={failedStep}
              running={running}
              label={t("providers.stageDone")}
              ms={test.totalMs}
              scaleMs={scaleMs}
              icon={CheckCircle2}
              isLast
            />
          </div>

          <div className="flex min-h-[180px] flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-950 font-mono text-[11px]">
            <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.04] px-3 py-2">
              <span className="flex min-w-0 items-center gap-1.5 text-zinc-400">
                <Terminal className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{requestHost ?? "—"}</span>
              </span>
              {test.httpStatus != null ? (
                <Chip tone={statusOk ? "ok" : "error"} className="font-mono">
                  HTTP {test.httpStatus}
                </Chip>
              ) : null}
            </div>
            <div ref={scrollRef} className="max-h-72 flex-1 overflow-y-auto">
              {hasContent ? (
                <>
                  {requestHost ? (
                    <div className="select-none px-3 py-3 leading-relaxed text-zinc-500">
                      <div>
                        <span className="text-primary">POST</span>{" "}
                        <span className="text-zinc-300">{requestPath}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Host:</span>{" "}
                        <span className="text-zinc-400">{requestHost}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500">Accept:</span>{" "}
                        <span className="text-zinc-400">
                          text/event-stream
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {reply || running || failed ? (
                    <div className="border-t border-white/5" aria-hidden />
                  ) : null}
                  {failed && test.error ? (
                    <div className="px-3 py-3 leading-relaxed">
                      <p className="mb-1 text-zinc-500">
                        {"// " + t("providers.responseStream")}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-red-400">
                        {test.error}
                      </p>
                    </div>
                  ) : reply || running ? (
                    <div className="px-3 py-3 leading-relaxed">
                      <p className="mb-1 text-zinc-500">
                        {"// " + t("providers.responseStream")}
                      </p>
                      <p
                        className={cn(
                          "whitespace-pre-wrap break-words transition-colors duration-300",
                          passed ? "text-emerald-300" : "text-zinc-300",
                        )}
                      >
                        {reply}
                        {running ? (
                          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
                        ) : null}
                      </p>
                    </div>
                  ) : null}
                  {passed || failed ? (
                    <>
                      <div className="border-t border-white/5" aria-hidden />
                      <div
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-2.5",
                          passed ? "text-emerald-400" : "text-red-400",
                        )}
                      >
                        {passed ? (
                          <Check className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <span className="shrink-0 text-[13px] leading-none">
                            ×
                          </span>
                        )}
                        <span>
                          {t(
                            passed
                              ? "providers.testPassed"
                              : "providers.testFailed",
                          )}
                        </span>
                      </div>
                    </>
                  ) : null}
                </>
              ) : (
                <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 px-3 py-4 text-zinc-600">
                  <Play className="h-7 w-7 opacity-25" />
                  <span>{t("providers.streamTestIdleHint")}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5 transition-all duration-500",
            test.statusMs != null ? "opacity-100" : "pointer-events-none h-0 opacity-0",
          )}
        >
          {test.statusMs != null ? (
            <Chip className="font-mono">
              {t("providers.chipStatus", { ms: formatMs(test.statusMs) })}
            </Chip>
          ) : null}
          {test.firstTokenMs != null ? (
            <Chip tone={latencyTone(test.firstTokenMs)} className="font-mono">
              {t("providers.chipFirstPacket", {
                ms: formatMs(test.firstTokenMs),
              })}
            </Chip>
          ) : null}
          {test.totalMs != null ? (
            <Chip className="font-mono">
              {t("providers.chipTotal", { ms: formatMs(test.totalMs) })}
            </Chip>
          ) : null}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("providers.streamTestNote")}
        </p>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={onClose}
          >
            {t("common.close")}
          </Button>
          <Button
            size="sm"
            disabled={running || !modelId}
            onClick={() => void runTest()}
          >
            <ButtonBusyContent
              busy={running}
              idleLabel={t(hasContent ? "providers.retest" : "providers.startTest")}
              busyLabel={t("providers.testRunning")}
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
