import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Zap } from "lucide-react";

import { api } from "@/lib/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type RangeKey = "all" | "today" | "week" | "month";
type TypeKey = "all" | "consume" | "topup" | "error";

/** 可选每页条数；后端 page_size 上限 100 */
const PAGE_SIZES = [10, 20, 50, 100];

const TYPE_VALUE: Record<TypeKey, number> = { all: 0, consume: 2, topup: 1, error: 5 };
const TYPE_LABEL_KEY: Record<number, string> = {
  1: "usageLogs.typeTopup",
  2: "usageLogs.typeConsume",
  3: "usageLogs.typeManage",
  4: "usageLogs.typeSystem",
  5: "usageLogs.typeError",
  6: "usageLogs.typeRefund",
  7: "usageLogs.typeLogin",
};

function money(quota: number, quotaPerUnit: number): string {
  const unit = quotaPerUnit > 0 ? quotaPerUnit : 500_000;
  return `$${(quota / unit).toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatFirstToken(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function rangeToTimestamps(range: RangeKey): { start: number; end: number } {
  if (range === "all") return { start: 0, end: 0 };
  const now = Math.floor(Date.now() / 1000);
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { start: Math.floor(d.getTime() / 1000), end: 0 };
  }
  return { start: now - (range === "week" ? 7 : 30) * 86400, end: 0 };
}

export function UsageLogsPage() {
  const { t } = useTranslation();
  const refreshAction = useBusyAction({ minVisibleMs: 500 });
  const [range, setRange] = useState<RangeKey>("week");
  const [type, setType] = useState<TypeKey>("consume");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const connected = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.newapiWallet(),
    staleTime: 60_000,
    select: (data) => data.data.connected,
  }).data ?? false;

  const logWindow = useMemo(() => rangeToTimestamps(range), [range]);

  const logsQuery = useQuery({
    queryKey: ["site-logs", page, pageSize, range, type],
    queryFn: () =>
      api.newapiLogs(page, pageSize, TYPE_VALUE[type], logWindow.start, logWindow.end),
    staleTime: 30_000,
    enabled: connected,
  });
  const payload = logsQuery.data?.data;
  const items = payload?.items ?? [];
  const total = payload?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const unit = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.newapiWallet(),
    staleTime: 60_000,
    select: (data) => data.data.stats?.quotaPerUnit ?? 500_000,
  }).data ?? 500_000;

  const refresh = async () => {
    await refreshAction.run(async () => {
      await logsQuery.refetch();
    });
  };

  const switchFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex shrink-0 items-end justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("usageLogs.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("usageLogs.description")}</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshAction.busy}>
          {refreshAction.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {!connected ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="font-medium">{t("usageLogs.notConnected")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("usageLogs.notConnectedDesc")}</p>
        </div>
      ) : (
        <>
          {/* 筛选 */}
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <div className="rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
              <AnimatedSegmentedControl
                items={[
                  { value: "all", label: t("usageLogs.rangeAll") },
                  { value: "today", label: t("usageLogs.rangeToday") },
                  { value: "week", label: t("usageLogs.rangeWeek") },
                  { value: "month", label: t("usageLogs.rangeMonth") },
                ]}
                value={range}
                onValueChange={(v) => switchFilter(() => setRange(v as RangeKey))}
                className="gap-0.5"
                indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
                itemClassName="rounded-full whitespace-nowrap px-3 py-1.5 text-xs font-medium"
                activeItemClassName="text-foreground"
                inactiveItemClassName="text-muted-foreground hover:text-foreground"
              />
            </div>
            <div className="rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
              <AnimatedSegmentedControl
                items={[
                  { value: "consume", label: t("usageLogs.typeConsume") },
                  { value: "topup", label: t("usageLogs.typeTopup") },
                  { value: "error", label: t("usageLogs.typeError") },
                  { value: "all", label: t("usageLogs.typeAll") },
                ]}
                value={type}
                onValueChange={(v) => switchFilter(() => setType(v as TypeKey))}
                className="gap-0.5"
                indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
                itemClassName="rounded-full whitespace-nowrap px-3 py-1.5 text-xs font-medium"
                activeItemClassName="text-foreground"
                inactiveItemClassName="text-muted-foreground hover:text-foreground"
              />
            </div>
            <span className="ml-auto text-xs text-muted-foreground">
              {t("usageLogs.total", { count: total })}
            </span>
          </div>

          {/* 列表：内部滚动，底部分页栏固定 */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {logsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-12 text-center">
                <p className="font-medium">{t("usageLogs.empty")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm">{entry.modelName || "—"}</span>
                      {entry.logType !== 2 && (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t(TYPE_LABEL_KEY[entry.logType] ?? "usageLogs.typeOther")}
                        </Badge>
                      )}
                      {entry.isStream && (
                        <Badge variant="outline" className="border-primary/30 bg-primary/8 font-normal text-primary">
                          <Zap className="mr-0.5 size-3" />
                          {t("usageLogs.stream")}
                        </Badge>
                      )}
                      {entry.tokenName && (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          {entry.tokenName}
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {new Date(entry.createdAt * 1000).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {entry.logType === 2 ? (
                        <>
                          <span>
                            {t("usageLogs.inputTokens", { tokens: formatTokens(entry.promptTokens) })}
                            {entry.cacheTokens > 0 &&
                              ` ${t("usageLogs.cacheHit", { tokens: formatTokens(entry.cacheTokens) })}`}
                          </span>
                          <span>
                            {t("usageLogs.outputTokens", { tokens: formatTokens(entry.completionTokens) })}
                          </span>
                          <span className="font-medium text-foreground">
                            {money(entry.quota, unit)}
                          </span>
                          {entry.frtMs >= 0 && (
                            <span>{t("usageLogs.firstToken", { time: formatFirstToken(entry.frtMs) })}</span>
                          )}
                          {entry.useTime > 0 && (
                            <span>{t("usageLogs.useTime", { seconds: entry.useTime })}</span>
                          )}
                        </>
                      ) : (
                        entry.content && <span className="truncate">{entry.content}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 分页栏（固定底部）：每页条数 + 上一页 / 页码 / 下一页 */}
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(value) => switchFilter(() => setPageSize(Number(value)))}
            >
              <SelectTrigger className="h-8 w-[96px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {t("usageLogs.pageSizeOption", { count: size })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || logsQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft />
              {t("usageLogs.pagePrev")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount || logsQuery.isFetching}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              {t("usageLogs.pageNext")}
              <ChevronRight />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
