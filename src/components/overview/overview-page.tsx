import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleX, FolderOpen } from "lucide-react";

import { api } from "@/lib/api";
import type { ActivityDay, TokenDay } from "@/types";
import { Heatmap, HeatmapLegend, type HeatmapDay } from "@/components/ui/heatmap";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";
import { BentoCard } from "@/components/ui/bento-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type RangeKey = "week" | "month" | "year";
type TabKey = "activity" | "token";

const RANGE_DAYS: Record<RangeKey, number> = { week: 7, month: 30, year: 365 };

/** quota 按站点单价换算成美元金额 */
function money(quota: number, quotaPerUnit: number): string {
  const unit = quotaPerUnit > 0 ? quotaPerUnit : 500_000;
  return `$${(quota / unit).toFixed(2)}`;
}

/** token 数量紧凑展示：1234 -> 1.2k，1234567 -> 1.23M */
function formatTokens(tokens: number): string {
  if (tokens <= 0) return "—";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}


/** 把稀疏的按天数据展开成连续日期序列，并按相对量分级 0-4 */
function buildHeatmapDays(
  days: { date: string; primary: number }[],
  rangeDays: number,
): HeatmapDay[] {
  const byDate = new Map(days.map((d) => [d.date, d.primary]));
  const result: HeatmapDay[] = [];
  const today = new Date();
  const max = Math.max(1, ...days.map((d) => d.primary));
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const value = byDate.get(key) ?? 0;
    const level =
      value === 0 ? 0 : value / max > 0.66 ? 4 : value / max > 0.33 ? 3 : value / max > 0.12 ? 2 : 1;
    result.push({ date: key, level, count: value });
  }
  return result;
}

export function OverviewPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("activity");
  const [range, setRange] = useState<RangeKey>("year");

  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.loadDashboard(),
  });
  const data = query.data?.data;

  const usageQuery = useQuery({
    queryKey: ["site-usage"],
    queryFn: () => api.newapiSiteUsage(),
    staleTime: 60_000,
  });
  const usage = usageQuery.data?.data;
  const summary = usage?.summary ?? null;

  const heatmapDays = useMemo(() => {
    const rangeDays = RANGE_DAYS[range];
    const days: { date: string; primary: number }[] =
      tab === "activity"
        ? (data?.activity ?? []).map((d: ActivityDay) => ({ date: d.date, primary: d.count }))
        : (data?.tokenDays ?? []).map((d: TokenDay) => ({ date: d.date, primary: d.totalTokens }));
    return buildHeatmapDays(days, rangeDays);
  }, [data, tab, range]);

  const healthRows = useMemo(() => {
    if (!data) return [];
    const check = (key: string) => data.pathChecks.find((c) => c.key === key);
    // 会话索引（tasks-index.sqlite）与会话数据库（cli/db/db.sqlite）合并为一行展示，
    // 两者都存在才算正常
    const tasksDb = check("tasksDb");
    const sessionDb = check("sessionDb");
    const sessionStores =
      tasksDb && sessionDb
        ? { ...sessionDb, key: "sessionStores", exists: tasksDb.exists && sessionDb.exists }
        : undefined;
    return [
      { label: t("overview.pathZcodeHome"), check: check("zcodeHome") },
      { label: t("overview.pathProviderConfig"), check: check("providerConfig"), valid: data.providerConfigValid, error: data.providerConfigError },
      { label: t("overview.pathSessionStores"), check: sessionStores },
    ].filter((row) => row.check);
  }, [data, t]);

  return (
    <div className="space-y-3.5">
      {/* 站点余额与用量 */}
      <div>
        <div className="grid grid-cols-4 gap-4">
          <UsageCard
            accent="bg-sky-500"
            label={t("overview.statBalance")}
            amount={summary ? money(summary.balanceQuota, summary.quotaPerUnit) : undefined}
            hint={
              summary
                ? t("overview.balanceUsedSub", {
                    amount: money(summary.usedQuota, summary.quotaPerUnit),
                  })
                : ""
            }
            loading={usageQuery.isLoading}
          />
          <UsageCard
            accent="bg-amber-500"
            label={t("overview.statToday")}
            amount={summary ? money(summary.today.quota, summary.quotaPerUnit) : undefined}
            hint={summary ? t("overview.tokensSub", { tokens: formatTokens(summary.today.tokens) }) : ""}
            loading={usageQuery.isLoading}
          />
          <UsageCard
            accent="bg-emerald-500"
            label={t("overview.statWeek")}
            amount={summary ? money(summary.week.quota, summary.quotaPerUnit) : undefined}
            hint={summary ? t("overview.tokensSub", { tokens: formatTokens(summary.week.tokens) }) : ""}
            loading={usageQuery.isLoading}
          />
          <UsageCard
            accent="bg-violet-500"
            label={t("overview.statMonth")}
            amount={summary ? money(summary.month.quota, summary.quotaPerUnit) : undefined}
            hint={summary ? t("overview.tokensSub", { tokens: formatTokens(summary.month.tokens) }) : ""}
            loading={usageQuery.isLoading}
          />
        </div>
        {usageQuery.isError && (
          <p className="mt-2 text-xs text-destructive">
            {t("overview.usageError", {
              message: usageQuery.error instanceof Error
                ? usageQuery.error.message
                : t("common.toastErrorGenericDesc"),
            })}
          </p>
        )}
      </div>

      {/* 状态 + 健康 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BentoCard compact>
          <p className="text-sm text-muted-foreground">{t("overview.zcodeTitle")}</p>
          {query.isLoading || !data ? (
            <Skeleton className="mt-3 h-8 w-32" />
          ) : (
            <div className="mt-2 flex items-center gap-2.5">
              <span
                className={cn(
                  "size-2.5 rounded-full",
                  data.zcodeRunning ? "bg-emerald-500" : "bg-zinc-400",
                )}
              />
              <span className="text-2xl font-semibold">
                {data.zcodeRunning
                  ? t("overview.zcodeRunningLabel")
                  : t("overview.zcodeNotRunningLabel")}
              </span>
            </div>
          )}
          {data && (
            <>
              <p className="mt-3 text-xs text-muted-foreground">{t("overview.dataDir")}</p>
              <p className="mt-1 break-all font-mono text-xs text-foreground">{data.zcodeHome}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void api.openPath(data.zcodeHome)}
              >
                <FolderOpen />
                {t("overview.openFolder")}
              </Button>
            </>
          )}
        </BentoCard>

        <BentoCard compact>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{t("overview.healthTitle")}</h3>
            {data && data.providerConfigValid && (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CircleCheck className="size-3.5" />
                {t("overview.healthOk")}
              </span>
            )}
          </div>
          {query.isLoading || !data ? (
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <div className="mt-3 divide-y divide-border/60">
              {healthRows.map((row) => {
                const exists = row.check!.exists;
                const valid = row.valid !== false;
                const ok = exists && valid;
                return (
                  <div key={row.check!.key} className="flex items-center justify-between py-2">
                    <span className="text-sm">{row.label}</span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-xs font-medium",
                        ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : !exists
                            ? "text-zinc-400"
                            : "text-destructive",
                      )}
                    >
                      {ok ? (
                        <CircleCheck className="size-3.5" />
                      ) : (
                        <CircleX className="size-3.5" />
                      )}
                      {!exists
                        ? t("overview.healthMissing")
                        : valid
                          ? t("overview.healthOk")
                          : t("overview.healthInvalid")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </BentoCard>
      </div>

      {/* 活跃趋势热力图 */}
      <BentoCard className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
            <AnimatedSegmentedControl
              items={[
                { value: "activity", label: t("overview.tabActivity") },
                { value: "token", label: t("overview.tabToken") },
              ]}
              value={tab}
              onValueChange={(v) => setTab(v as TabKey)}
              className="gap-0.5"
              indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
              itemClassName="rounded-full whitespace-nowrap px-3.5 py-1.5 text-xs font-medium"
              activeItemClassName="text-foreground"
              inactiveItemClassName="text-muted-foreground hover:text-foreground"
            />
          </div>
          <div className="rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
            <AnimatedSegmentedControl
              items={[
                { value: "week", label: t("overview.rangeWeek") },
                { value: "month", label: t("overview.rangeMonth") },
                { value: "year", label: t("overview.rangeYear") },
              ]}
              value={range}
              onValueChange={(v) => setRange(v as RangeKey)}
              className="gap-0.5"
              indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
              itemClassName="rounded-full whitespace-nowrap px-3 py-1.5 text-xs font-medium"
              activeItemClassName="text-foreground"
              inactiveItemClassName="text-muted-foreground hover:text-foreground"
            />
          </div>
        </div>

        <h3 className="mt-4 font-semibold">{t("overview.trendTitle")}</h3>
        {query.isLoading || !data ? (
          <Skeleton className="mt-4 h-40 w-full rounded-xl" />
        ) : heatmapDays.every((d) => d.count === 0) ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("overview.noData")}
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto pb-2">
            <Heatmap data={heatmapDays} />
            <div className="mt-3 flex justify-end">
              <HeatmapLegend />
            </div>
          </div>
        )}
      </BentoCard>
    </div>
  );
}

function UsageCard({
  accent,
  label,
  amount,
  hint,
  loading,
}: {
  accent: string;
  label: string;
  /** 金额字符串（$x.xx）；未接入时为 undefined 显示骨架 */
  amount: string | undefined;
  hint: string;
  loading?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-4 py-3">
      <span className={cn("absolute inset-x-0 top-0 h-[3px]", accent)} />
      <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
      {loading || amount == null ? (
        <Skeleton className="mt-1.5 h-6 w-20" />
      ) : (
        <p className="mt-1 text-2xl font-bold tabular-nums leading-none">{amount}</p>
      )}
      <p className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
