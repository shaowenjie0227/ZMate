import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleX, FolderOpen } from "lucide-react";

import { api } from "@/lib/api";
import type { TokenDay } from "@/types";
import {
  ModelShareDonut,
  TrendAreaChart,
  TrendBarChart,
  type ModelShareItem,
  type TrendPoint,
} from "@/components/overview/trend-charts";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";
import { BentoCard } from "@/components/ui/bento-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type RangeKey = "week" | "month" | "year";
type TabKey = "token" | "model";

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

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 当天是年内第几天（用于日均分母） */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** "2026-09-28" -> "9/28" */
function shortDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 把稀疏的按天数据展开成「最近 rangeDays 天」的连续序列（缺失天补零） */
function buildDailySeries(
  days: { date: string; primary: number }[],
  rangeDays: number,
): { date: string; value: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.primary]));
  const result: { date: string; value: number }[] = [];
  const today = new Date();
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    result.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return result;
}

/** 本周视图：自然周（周一到周日），未来的天补零 */
function buildCurrentWeekSeries(days: { date: string; primary: number }[]): { date: string; value: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.primary]));
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const result: { date: string; value: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = dateKey(d);
    result.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return result;
}

/** 本月视图：自然月（1 号到月末），未来的天补零 */
function buildCurrentMonthSeries(days: { date: string; primary: number }[]): { date: string; value: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.primary]));
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const result: { date: string; value: number }[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    result.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return result;
}

/** 按范围取对应的连续日序列（周/月为自然周、自然月，年走逐月聚合） */
function seriesForRange(
  days: { date: string; primary: number }[],
  range: RangeKey,
): { date: string; value: number }[] {
  if (range === "week") return buildCurrentWeekSeries(days);
  if (range === "month") return buildCurrentMonthSeries(days);
  return buildDailySeries(days, RANGE_DAYS.year);
}

/** 年视图：当前年 1 月到当月的逐月合计（未来月份不展示） */
function buildMonthlySeries(
  days: { date: string; primary: number }[],
): { key: string; value: number }[] {
  const year = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const totals = new Array<number>(currentMonth).fill(0);
  for (const d of days) {
    if (!d.date.startsWith(String(year))) continue;
    const m = Number(d.date.slice(5, 7));
    if (m >= 1 && m <= currentMonth) totals[m - 1] += d.primary;
  }
  return totals.map((value, i) => ({
    key: `${year}-${String(i + 1).padStart(2, "0")}`,
    value,
  }));
}

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<TabKey>("token");
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

  // 当前 Tab 对应的按天 token 序列（另存原始明细供 tooltip）
  const dailySeries = useMemo(() => {
    const days: { date: string; primary: number }[] = (data?.tokenDays ?? []).map(
      (d: TokenDay) => ({ date: d.date, primary: d.totalTokens }),
    );
    return {
      days,
      tokenByDate: new Map((data?.tokenDays ?? []).map((d: TokenDay) => [d.date, d])),
    };
  }, [data]);

  // 图表数据点：周/月 = 逐日，年 = 逐月；tooltip 附带 input/output/reasoning 明细
  const trendPoints = useMemo<TrendPoint[]>(() => {
    const { days, tokenByDate } = dailySeries;
    const withDetail = (date: string, value: number): TrendPoint => {
      const d = tokenByDate.get(date);
      return {
        key: date,
        label: "",
        value,
        inputTokens: d?.inputTokens,
        outputTokens: d?.outputTokens,
        reasoningTokens: d?.reasoningTokens,
      };
    };
    const dayLabel = (date: string) => {
      if (range === "week") {
        return new Date(date + "T00:00:00").toLocaleDateString(i18n.language, { weekday: "short" });
      }
      return shortDate(date);
    };

    if (range === "year") {
      return buildMonthlySeries(days).map((m) => ({
        key: m.key,
        label: t("overview.monthLabel", { m: Number(m.key.slice(5, 7)) }),
        value: m.value,
      }));
    }
    return seriesForRange(days, range).map((d) => ({
      ...withDetail(d.date, d.value),
      label: dayLabel(d.date),
    }));
  }, [dailySeries, range, i18n, t]);

  // 模型占比：按当前时间范围聚合各模型 token（降序，前 7 名 + 其他）
  const modelShare = useMemo<ModelShareItem[]>(() => {
    const rows = data?.modelTokenDays ?? [];
    let startKey = "";
    if (range === "week") {
      const monday = new Date();
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      startKey = dateKey(monday);
    } else if (range === "month") {
      const now = new Date();
      startKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    }
    const totals = new Map<string, number>();
    for (const row of rows) {
      if (startKey && row.date < startKey) continue;
      totals.set(row.modelId, (totals.get(row.modelId) ?? 0) + row.totalTokens);
    }
    const sum = [...totals.values()].reduce((a, b) => a + b, 0);
    if (sum <= 0) return [];
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7).map(([modelId, tokens]) => ({
      modelId,
      tokens,
      pct: (tokens / sum) * 100,
    }));
    const restTokens = sorted.slice(7).reduce((acc, [, tokens]) => acc + tokens, 0);
    if (restTokens > 0) {
      top.push({ modelId: t("overview.modelOther", { defaultValue: "其他" }), tokens: restTokens, pct: (restTokens / sum) * 100 });
    }
    return top;
  }, [data, range, t]);

  // 汇总行：合计 / 日均 / 峰值（按天粒度统计，口径与图表一致：自然周 / 自然月 / 当年）
  const trendSummary = useMemo(() => {
    const series = seriesForRange(dailySeries.days, range);
    if (range === "year") {
      const yearStart = `${new Date().getFullYear()}-01-01`;
      for (const d of series) if (d.date < yearStart) d.value = 0;
    }
    const elapsed =
      range === "week"
        ? ((new Date().getDay() + 6) % 7) + 1
        : range === "month"
          ? new Date().getDate()
          : dayOfYear(new Date());
    const total = series.reduce((acc, d) => acc + d.value, 0);
    const peak = series.reduce<{ date: string; value: number } | null>(
      (best, d) => (!best || d.value > best.value ? d : best),
      null,
    );
    return { total, avg: total / Math.max(1, elapsed), peak };
  }, [dailySeries, range]);

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
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* 站点余额与用量 */}
      <div className="shrink-0">
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
      <div className="grid shrink-0 gap-4 lg:grid-cols-2">
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

      {/* 活跃趋势热力图：撑满剩余高度，内容超出时卡片内部滚动（页面本身不滚动） */}
      <BentoCard className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Token / 模型占比：三个周期都可用（占比同样按所选范围过滤） */}
          {(
            <div className="rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
              <AnimatedSegmentedControl
                items={[
                  { value: "token", label: t("overview.tabToken") },
                  { value: "model", label: t("overview.tabModel") },
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
          )}
          <div className="ml-auto rounded-full bg-muted p-0.5 dark:bg-white/[0.06]">
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

        {query.isLoading || !data ? (
          <Skeleton className="mt-4 h-56 w-full rounded-xl" />
        ) : tab === "token" ? (
          trendPoints.every((p) => p.value === 0) ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t("overview.noData")}
            </div>
          ) : (
            <>
              {/* 汇总行：合计 / 日均 / 峰值 */}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("overview.summaryTotal", { defaultValue: "合计" })}
                  <span className="ml-1.5 font-semibold tabular-nums text-foreground">
                    {formatTokens(trendSummary.total)}
                  </span>{" "}
                  tokens
                </span>
                <span>
                  {t("overview.summaryDailyAvg", { defaultValue: "日均" })}
                  <span className="ml-1.5 font-semibold tabular-nums text-foreground">
                    {formatTokens(trendSummary.avg)}
                  </span>{" "}
                  tokens
                </span>
                {trendSummary.peak && trendSummary.peak.value > 0 ? (
                  <span>
                    {t("overview.summaryPeak", { defaultValue: "峰值" })}
                    <span className="ml-1.5 font-semibold tabular-nums text-foreground">
                      {range === "week"
                        ? new Date(trendSummary.peak.date + "T00:00:00").toLocaleDateString(i18n.language, { weekday: "short" })
                        : range === "month"
                          ? shortDate(trendSummary.peak.date)
                          : t("overview.monthLabel", { m: Number(trendSummary.peak.date.slice(5, 7)) })}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="mt-3 min-h-[200px] flex-1">
                {range === "week" ? (
                  <TrendBarChart points={trendPoints} isToken />
                ) : (
                  <TrendAreaChart points={trendPoints} isToken />
                )}
              </div>
            </>
          )
        ) : modelShare.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("overview.noData")}
          </div>
        ) : (
          /* 模型占比页签：环形图（左）+ 图例（右） */
          <div className="mt-3 min-w-0 flex-1">
            <ModelShareDonut items={modelShare} />
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
  const { t } = useTranslation();
  const noData = !loading && amount == null;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-4 py-3">
      <span className={cn("absolute inset-x-0 top-0 h-[3px]", accent)} />
      <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex h-6 items-center">
        {loading || amount == null ? (
          <Skeleton className="h-6 w-20" />
        ) : (
          <p className="text-2xl font-bold tabular-nums leading-none">{amount}</p>
        )}
      </div>
      <p className="mt-1.5 h-4 truncate text-xs text-muted-foreground">
        {noData ? t("overview.noData") : hint}
      </p>
    </div>
  );
}
