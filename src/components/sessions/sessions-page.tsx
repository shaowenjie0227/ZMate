import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, CheckCircle2, CircleDashed, Loader2, RefreshCw } from "lucide-react";

import { api } from "@/lib/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SessionTransferDialog } from "@/components/sessions/session-transfer-dialog";
import { usePageStage } from "@/components/layout/page-stage";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function formatMillis(ms: number | null | undefined, withTime: boolean): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const date = d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function SessionsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const refreshAction = useBusyAction({ minVisibleMs: 500 });
  // 「会话迁移」按钮挂到顶栏（SiteHeader 的 #site-header-actions 容器）。
  // 路由保活会让本页在离开后仍保持挂载，非可见态必须停渲染，按钮才不会残留在别的页面
  const stage = usePageStage();
  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  useEffect(() => {
    setHeaderActionsEl(document.getElementById("site-header-actions"));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const listQuery = useQuery({
    queryKey: ["sessions", debouncedSearch, includeArchived],
    queryFn: () => api.listSessions(debouncedSearch || undefined, includeArchived, 100, 0),
  });

  const overviewQuery = useQuery({
    queryKey: ["session-overview"],
    queryFn: () => api.getSessionOverview(),
  });
  const overview = overviewQuery.data?.data;

  const sessions = listQuery.data?.data.items ?? [];

  const detailQuery = useQuery({
    queryKey: ["session-detail", selectedId],
    queryFn: () => api.getSessionDetail(selectedId!),
    enabled: !!selectedId,
  });
  const statsQuery = useQuery({
    queryKey: ["session-stats", selectedId],
    queryFn: () => api.getSessionStats(selectedId!),
    enabled: !!selectedId,
  });

  const refresh = async () => {
    await refreshAction.run(async () => {
      await Promise.all([
        listQuery.refetch(),
        overviewQuery.refetch(),
        selectedId ? detailQuery.refetch() : Promise.resolve(),
        selectedId ? statsQuery.refetch() : Promise.resolve(),
      ]);
    });
  };

  return (
    <div className="space-y-3.5">
      {headerActionsEl &&
        stage === "active" &&
        createPortal(
          <Button variant="outline" onClick={() => setTransferOpen(true)}>
            <ArrowRightLeft />
            {t("sessions.transfer.button")}
          </Button>,
          headerActionsEl,
        )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("sessions.description")}</p>
        <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshAction.busy}>
          {refreshAction.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-4 gap-3">
        <SessionStatCard
          label={t("sessions.statTotal")}
          value={overview ? String(overview.totalSessions) : undefined}
          loading={overviewQuery.isLoading}
        />
        <SessionStatCard
          label={t("sessions.statStorage")}
          value={overview ? formatBytes(overview.storageBytes) : undefined}
          loading={overviewQuery.isLoading}
        />
        <SessionStatCard
          label={t("sessions.statActiveDays")}
          value={overview ? String(overview.activeDays) : undefined}
          loading={overviewQuery.isLoading}
        />
        <SessionStatCard
          label={t("sessions.statDailyAvg")}
          value={overview ? overview.avgPerActiveDay.toFixed(1) : undefined}
          loading={overviewQuery.isLoading}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("sessions.searchPlaceholder")}
          className="h-9 max-w-xs"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Checkbox
            checked={includeArchived}
            onCheckedChange={(checked) => setIncludeArchived(checked === true)}
          />
          {t("sessions.includeArchived")}
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("sessions.total", { count: listQuery.data?.data.total ?? 0 })}
        </span>
      </div>

      {listQuery.data && !listQuery.data.data.dbExists ? (
        <EmptyState title={t("sessions.dbMissing")} description={t("sessions.dbMissingDesc")} />
      ) : listQuery.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-5">
          <div className="space-y-2 lg:col-span-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 w-full rounded-2xl lg:col-span-3" />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState title={t("sessions.empty")} description={t("sessions.emptyDesc")} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-5">
          <div className="max-h-[62vh] space-y-1.5 overflow-y-auto pr-1 lg:col-span-2">
            {sessions.map((session) => (
              <button
                key={session.taskId}
                type="button"
                onClick={() => setSelectedId(session.taskId)}
                className={cn(
                  "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                  selectedId === session.taskId
                    ? "border-primary bg-primary/8"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <div className="flex items-center gap-2">
                  {session.status === "running" ? (
                    <CircleDashed className="size-3.5 shrink-0 text-sky-500" />
                  ) : (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {session.title || session.taskId}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground">
                  <span>{formatMillis(session.updatedAt, true)}</span>
                  {session.model && <span className="truncate font-mono">{session.model}</span>}
                  {session.archived && <span>· {t("sessions.includeArchived")}</span>}
                </div>
              </button>
            ))}
          </div>

          <SessionDetail
            taskId={selectedId}
            detailQueryLoading={detailQuery.isLoading}
            detailQueryError={detailQuery.error instanceof Error ? detailQuery.error.message : null}
            detail={detailQuery.data?.data ?? null}
            stats={statsQuery.data?.data ?? null}
          />
        </div>
      )}

      <SessionTransferDialog open={transferOpen} onClose={() => setTransferOpen(false)} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function SessionStatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value: string | undefined;
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      {loading || value == null ? (
        <Skeleton className="mt-2 h-8 w-20" />
      ) : (
        <p className="mt-1 text-2xl font-bold tabular-nums leading-tight">{value}</p>
      )}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function SessionDetail({
  taskId,
  detail,
  stats,
  detailQueryLoading,
  detailQueryError,
}: {
  taskId: string | null;
  detail: {
    taskId: string;
    title: string;
    directory: string | null;
    messages: {
      id: string;
      role: string;
      timeCreated: number;
      parts: { kind: string; text: string }[];
    }[];
    truncated: boolean;
  } | null;
  stats: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    totalDurationMs: number;
    toolCallCount: number;
  } | null;
  detailQueryLoading: boolean;
  detailQueryError: string | null;
}) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"trace" | "answer">("trace");

  if (!taskId) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground lg:col-span-3">
        {t("sessions.detail.selectHint")}
      </div>
    );
  }

  return (
    <div className="max-h-[62vh] space-y-3 overflow-y-auto rounded-2xl border border-border bg-card p-4 lg:col-span-3">
      {detailQueryLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : detailQueryError ? (
        <p className="text-sm text-destructive">{t("sessions.detail.loadFailed")}</p>
      ) : !detail ? null : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold">{detail.title || detail.taskId}</h3>
              {detail.directory && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t("sessions.detail.workspace")}: {detail.directory}
                </p>
              )}
            </div>
            <div className="shrink-0 rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
              <AnimatedSegmentedControl
                items={[
                  { value: "trace", label: t("sessions.detail.viewTrace") },
                  { value: "answer", label: t("sessions.detail.viewAnswer") },
                ]}
                value={viewMode}
                onValueChange={(v) => setViewMode(v as "trace" | "answer")}
                className="gap-0.5"
                indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
                itemClassName="rounded-full whitespace-nowrap px-3 py-1 text-xs font-medium"
                activeItemClassName="text-foreground"
                inactiveItemClassName="text-muted-foreground hover:text-foreground"
              />
            </div>
          </div>

          {stats && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatMini label={t("sessions.detail.requests")} value={formatTokens(stats.requestCount)} />
              <StatMini label={t("sessions.detail.inputTokens")} value={formatTokens(stats.inputTokens)} />
              <StatMini label={t("sessions.detail.outputTokens")} value={formatTokens(stats.outputTokens)} />
              <StatMini label={t("sessions.detail.reasoningTokens")} value={formatTokens(stats.reasoningTokens)} />
              <StatMini label={t("sessions.detail.cacheRead")} value={formatTokens(stats.cacheReadTokens)} />
              <StatMini label={t("sessions.detail.duration")} value={formatDurationMs(stats.totalDurationMs)} />
              <StatMini label={t("sessions.detail.toolCalls")} value={formatTokens(stats.toolCallCount)} />
            </div>
          )}

          {detail.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("sessions.detail.truncatedHint")}
            </p>
          )}

          {/* 轨迹 = 完整执行流；回答 = 按轮次的「提问 + 已工作 + 最终结论」 */}
          {(() => {
            if (viewMode === "trace") {
              if (detail.messages.length === 0) {
                return (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("sessions.detail.noMessages")}
                  </p>
                );
              }
              return (
                <div className="space-y-3">
                  {detail.messages.map((message) => (
                    <div key={message.id} className="space-y-1.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {message.role === "user"
                          ? t("sessions.detail.roleUser")
                          : message.role === "assistant"
                            ? t("sessions.detail.roleAssistant")
                            : message.role || "-"}
                      </p>
                      {message.parts.map((part, index) => {
                        if (part.kind === "text") {
                          return (
                            <div
                              key={index}
                              className={cn(
                                "rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                                message.role === "user" ? "bg-primary/8" : "bg-muted/40",
                              )}
                            >
                              {part.text}
                            </div>
                          );
                        }
                        if (part.kind === "reasoning") {
                          return (
                            <details key={index} className="rounded-xl bg-muted/20 px-3 py-1.5">
                              <summary className="cursor-pointer text-xs italic text-muted-foreground">
                                {t("sessions.detail.reasoning")}
                              </summary>
                              <p className="mt-1 text-xs italic text-muted-foreground whitespace-pre-wrap">
                                {part.text}
                              </p>
                            </details>
                          );
                        }
                        if (part.kind === "tool") {
                          return (
                            <pre
                              key={index}
                              className="overflow-x-auto rounded-xl bg-muted/60 px-3 py-2 font-mono text-[11px] text-muted-foreground"
                            >
                              {part.text}
                            </pre>
                          );
                        }
                        return null;
                      })}
                    </div>
                  ))}
                </div>
              );
            }

            // 回答视图：按用户提问切轮次；每轮展示提问气泡、可折叠的工作过程、最终文字结论
            interface Turn {
              id: string;
              question: string | null;
              questionTime: number | null;
              workMs: number | null;
              intermediate: { kind: string; text: string }[];
              answer: string | null;
            }
            const turns: Turn[] = [];
            let current: Turn | null = null;
            const flatParts: { turn: Turn; kind: string; text: string }[] = [];
            for (const m of detail.messages) {
              if (m.role === "user") {
                const text = m.parts
                  .filter((p) => p.kind === "text")
                  .map((p) => p.text)
                  .join("\n")
                  .trim();
                current = {
                  id: m.id,
                  question: text || null,
                  questionTime: m.timeCreated,
                  workMs: null,
                  intermediate: [],
                  answer: null,
                };
                turns.push(current);
                continue;
              }
              if (!current) {
                current = { id: m.id, question: null, questionTime: null, workMs: null, intermediate: [], answer: null };
                turns.push(current);
              }
              if (m.timeCreated > 0) {
                current.workMs = Math.max(
                  0,
                  m.timeCreated - (current.questionTime ?? m.timeCreated),
                );
              }
              for (const p of m.parts) {
                if (p.text.trim()) flatParts.push({ turn: current, kind: p.kind, text: p.text });
              }
            }

            // 每轮最后一个非空 text 视为最终结论，其余进入可折叠过程
            for (let i = flatParts.length - 1; i >= 0; i--) {
              const entry = flatParts[i];
              if (entry.kind === "text") {
                entry.turn.answer = entry.text;
                flatParts.splice(i, 1);
                break;
              }
            }
            for (const entry of flatParts) {
              entry.turn.intermediate.push({ kind: entry.kind, text: entry.text });
            }
            const visibleTurns = turns.filter((turn) => turn.question || turn.answer || turn.intermediate.length > 0);

            if (visibleTurns.length === 0) {
              return (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("sessions.detail.noMessages")}
                </p>
              );
            }

            return (
              <div className="space-y-5">
                {visibleTurns.map((turn) => (
                  <div key={turn.id} className="space-y-2.5">
                    {turn.question && (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl bg-primary/8 px-3.5 py-2 text-sm whitespace-pre-wrap">
                          {turn.question}
                        </div>
                      </div>
                    )}
                    {turn.intermediate.length > 0 && (
                      <details className="group">
                        <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                          {turn.workMs != null && turn.workMs > 0
                            ? t("sessions.detail.workedFor", {
                                time: formatDurationMs(turn.workMs),
                              })
                            : t("sessions.detail.workedGeneric")}
                          <span className="ml-1 inline-block transition-transform group-open:rotate-90">
                            ›
                          </span>
                        </summary>
                        <div className="mt-1.5 space-y-1.5 border-l-2 border-border pl-3">
                          {turn.intermediate.map((part, index) =>
                            part.kind === "text" ? (
                              <p
                                key={index}
                                className="rounded-xl bg-muted/30 px-3 py-2 text-xs whitespace-pre-wrap"
                              >
                                {part.text}
                              </p>
                            ) : part.kind === "reasoning" ? (
                              <p
                                key={index}
                                className="rounded-xl bg-muted/20 px-3 py-1.5 text-xs italic text-muted-foreground whitespace-pre-wrap"
                              >
                                {part.text}
                              </p>
                            ) : (
                              <pre
                                key={index}
                                className="overflow-x-auto rounded-xl bg-muted/60 px-3 py-2 font-mono text-[11px] text-muted-foreground"
                              >
                                {part.text}
                              </pre>
                            ),
                          )}
                        </div>
                      </details>
                    )}
                    {turn.answer && (
                      <div className="rounded-xl bg-muted/40 px-3.5 py-2.5 text-sm whitespace-pre-wrap">
                        {turn.answer}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
