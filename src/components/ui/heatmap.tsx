import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatMonthShort, formatHeatmapDate, formatDuration } from "@/lib/format-time";
import { useTranslation } from "react-i18next";
import { ChartTooltip } from "@/components/ui/chart-tooltip";

export interface HeatmapDay {
  date: string;
  level: number;
  count: number;
  activeMinutes?: number;
  tokens?: number;
}

interface HeatmapProps {
  data: HeatmapDay[];
  colorVar?: string;
}

const CELL = 13;
const GAP = 3;
const ROWS = 7;

export function Heatmap({ data, colorVar = "var(--heatmap-color, #3FE6A1)" }: HeatmapProps) {
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<{ x: number; y: number; day: HeatmapDay } | null>(null);

  const grid = useMemo(() => {
    const cols: HeatmapDay[][] = [];
    let col: HeatmapDay[] = [];

    const firstDate = data.length > 0 ? new Date(data[0].date + "T00:00:00") : new Date();
    const startPad = firstDate.getDay();
    for (let i = 0; i < startPad; i++) {
      col.push({ date: "", level: -1, count: 0 });
    }

    for (const day of data) {
      col.push(day);
      if (col.length === ROWS) {
        cols.push(col);
        col = [];
      }
    }
    if (col.length > 0) {
      while (col.length < ROWS) col.push({ date: "", level: -1, count: 0 });
      cols.push(col);
    }
    return cols;
  }, [data]);

  const months = useMemo(() => {
    const result: { label: string; col: number }[] = [];
    let lastMonth = -1;
    grid.forEach((col, ci) => {
      const firstValid = col.find((d) => d.date);
      if (!firstValid) return;
      const m = new Date(firstValid.date + "T00:00:00").getMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        result.push({
          label: formatMonthShort(new Date(firstValid.date + "T00:00:00")),
          col: ci,
        });
      }
    });
    return result;
  }, [grid]);

  const width = grid.length * (CELL + GAP) + GAP;
  const height = ROWS * (CELL + GAP) + GAP + 18;

  return (
    <div className="relative overflow-x-auto">
      <svg width={width} height={height} className="block">
        {months.map((m) => (
          <text
            key={`${m.label}-${m.col}`}
            x={m.col * (CELL + GAP) + GAP}
            y={12}
            className="fill-muted-foreground text-[10px]"
          >
            {m.label}
          </text>
        ))}
        {grid.map((col, ci) =>
          col.map((day, ri) => {
            if (day.level < 0) return null;
            const x = ci * (CELL + GAP) + GAP;
            const y = ri * (CELL + GAP) + GAP + 18;
            return (
              <rect
                key={`${ci}-${ri}`}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={2.5}
                fill={levelColor(day.level, colorVar)}
                className="transition-colors duration-150"
                onMouseEnter={(e) => {
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY - 6,
                    day,
                  });
                }}
                onMouseMove={(e) => {
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY - 6,
                    day,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            );
          }),
        )}
      </svg>
      {tooltip && tooltip.day.date && (
        <ChartTooltip x={tooltip.x} y={tooltip.y}>
          <div className="font-semibold text-foreground">{formatHeatmapDate(tooltip.day.date)}</div>
          <div className="text-muted-foreground">
            {tooltip.day.count} {t("analytics.tabSessions", { defaultValue: "sessions" })}
          </div>
          {tooltip.day.activeMinutes != null && tooltip.day.activeMinutes > 0 && (
            <div className="text-muted-foreground">
              {t("analytics.todayActive", { defaultValue: "Active" })}{" "}
              {formatDuration(tooltip.day.activeMinutes)}
            </div>
          )}
          {tooltip.day.tokens != null && tooltip.day.tokens > 0 && (
            <div className="text-muted-foreground">
              Token {tooltip.day.tokens >= 1_000_000 ? `${(tooltip.day.tokens / 1_000_000).toFixed(1)}M` : tooltip.day.tokens >= 1_000 ? `${(tooltip.day.tokens / 1_000).toFixed(1)}K` : tooltip.day.tokens}
            </div>
          )}
        </ChartTooltip>
      )}
    </div>
  );
}

/** token 量紧凑展示：1234 -> 1.2K，1234567 -> 1.23M */
function formatTokenCount(n: number): string {
  if (n <= 0) return "0 tokens";
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K tokens`;
  return `${(n / 1_000_000).toFixed(2)}M tokens`;
}

function levelColor(level: number, base: string): string {
  if (level === 0) return "var(--heatmap-empty, hsl(var(--muted) / 0.5))";
  const opacity = [0, 0.25, 0.5, 0.75, 1][level] ?? 1;
  return `color-mix(in srgb, ${base} ${Math.round(opacity * 100)}%, transparent)`;
}

export function HeatmapLegend({ colorVar = "var(--heatmap-color, #3FE6A1)" }: { colorVar?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span>Less</span>
      {[0, 1, 2, 3, 4].map((l) => (
        <span
          key={l}
          className={cn("inline-block h-[11px] w-[11px] rounded-[2px]")}
          style={{ backgroundColor: levelColor(l, colorVar) }}
        />
      ))}
      <span>More</span>
    </div>
  );
}


export interface HourHeatmapDay {
  date: string;
  /** 24 个小时桶（本地时间 0-23 时） */
  counts: number[];
}

const HOUR_CELL = 18;
const HOUR_GAP = 3;
const HOUR_LEFT = 36;
const HOUR_TOP = 20;

/** 周视图：7 行（周一到周日，每行一天）× 24 列（当天 0-23 时） */
export function HourHeatmap({
  days,
  colorVar = "var(--heatmap-color, #3FE6A1)",
  rows,
}: {
  days: HourHeatmapDay[];
  colorVar?: string;
  /** 固定行数：不足的行留空（本月按周分框时统一为 7，框宽与格子大小一致） */
  rows?: number;
}) {
  const { t, i18n } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    hour: number;
    count: number;
  } | null>(null);

  const weekdayLabel = (date: string) =>
    new Date(date + "T00:00:00").toLocaleDateString(i18n.language, { weekday: "short" });

  const max = Math.max(1, ...days.flatMap((d) => d.counts));
  const rowCount = rows ?? days.length;
  const width = HOUR_LEFT + 24 * (HOUR_CELL + HOUR_GAP) + HOUR_GAP;
  const height = HOUR_TOP + rowCount * (HOUR_CELL + HOUR_GAP) + HOUR_GAP;

  return (
    <div className="relative">
      <svg width={width} height={height} className="block">
        {[0, 6, 12, 18, 23].map((h) => (
          <text
            key={`h-${h}`}
            x={HOUR_LEFT + h * (HOUR_CELL + HOUR_GAP) + HOUR_CELL / 2}
            y={12}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {h}
          </text>
        ))}
        {days.map((d, ri) => (
          <text
            key={`d-${d.date}`}
            x={HOUR_LEFT - 8}
            y={HOUR_TOP + ri * (HOUR_CELL + HOUR_GAP) + HOUR_CELL - 4}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            {weekdayLabel(d.date)}
          </text>
        ))}
        {days.map((d, ri) =>
          d.counts.map((count, hour) => {
            const level =
              count <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
            const x = HOUR_LEFT + hour * (HOUR_CELL + HOUR_GAP) + HOUR_GAP;
            const y = HOUR_TOP + ri * (HOUR_CELL + HOUR_GAP) + HOUR_GAP;
            return (
              <rect
                key={`${d.date}-${hour}`}
                x={x}
                y={y}
                width={HOUR_CELL}
                height={HOUR_CELL}
                rx={3}
                fill={levelColor(level, colorVar)}
                className="transition-colors duration-150"
                onMouseEnter={(e) =>
                  setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                }
                onMouseMove={(e) =>
                  setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                }
                onMouseLeave={() => setTooltip(null)}
              />
            );
          }),
        )}
      </svg>
      {tooltip && (
        <ChartTooltip x={tooltip.x} y={tooltip.y}>
          <div className="font-semibold text-foreground">
            {formatHeatmapDate(tooltip.date)} {String(tooltip.hour).padStart(2, "0")}:00–
            {String((tooltip.hour + 1) % 24).padStart(2, "0")}:00
          </div>
          <div className="text-muted-foreground">
            {tooltip.count} {t("analytics.tabMessages", { defaultValue: "messages" })}
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}


/** 本周视图：7 张日卡（周一到周日）并排，每张卡内 4 列 × 6 行 = 24 小时格子 */
export function HourHeatmapColumns({
  days,
  colorVar = "var(--heatmap-color, #3FE6A1)",
  unit = "messages",
}: {
  days: HourHeatmapDay[];
  colorVar?: string;
  /** tooltip 单位：messages = 条消息；tokens = token 数 */
  unit?: "messages" | "tokens";
}) {
  const { t, i18n } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    hour: number;
    count: number;
  } | null>(null);

  const weekdayLabel = (date: string) =>
    new Date(date + "T00:00:00").toLocaleDateString(i18n.language, { weekday: "short" });

  const max = Math.max(1, ...days.flatMap((d) => d.counts));

  return (
    <div className="relative w-full">
      <div className="flex w-full gap-2.5">
        {days.map((d) => (
          <div
            key={d.date}
            className="min-w-0 flex-1 rounded-xl border border-border p-2"
          >
            <p className="mb-1.5 text-center text-[11px] text-muted-foreground">
              {weekdayLabel(d.date)}
            </p>
            <div className="grid grid-cols-4 gap-[3px]">
              {d.counts.map((count, hour) => {
                const level = count <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
                return (
                  <div
                    key={hour}
                    className="aspect-square rounded-[3px] transition-colors duration-150"
                    style={{ backgroundColor: levelColor(level, colorVar) }}
                    onMouseEnter={(e) =>
                      setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                    }
                    onMouseMove={(e) =>
                      setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                    }
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {tooltip && (
        <ChartTooltip x={tooltip.x} y={tooltip.y}>
          <div className="font-semibold text-foreground">
            {formatHeatmapDate(tooltip.date)} {String(tooltip.hour).padStart(2, "0")}:00–
            {String((tooltip.hour + 1) % 24).padStart(2, "0")}:00
          </div>
          <div className="text-muted-foreground">
            {unit === "tokens"
              ? formatTokenCount(tooltip.count)
              : `${tooltip.count} ${t("analytics.tabMessages", { defaultValue: "messages" })}`}
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}


/**
 * 本月视图：横轴 = 当月 1 号到月末（每天一列），纵轴 = 24 小时（每列 24 格）。
 * 列宽随容器自适应铺满整宽；列数多时格子自动变小。
 */
export function MonthHeatmap({
  days,
  colorVar = "var(--heatmap-color, #3FE6A1)",
  unit = "messages",
}: {
  days: HourHeatmapDay[];
  colorVar?: string;
  /** tooltip 单位：messages = 条消息；tokens = token 数 */
  unit?: "messages" | "tokens";
}) {
  const { t } = useTranslation();
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    date: string;
    hour: number;
    count: number;
  } | null>(null);

  const max = Math.max(1, ...days.flatMap((d) => d.counts));

  return (
    <div className="w-full">
      <div className="flex w-full gap-[3px]">
        {days.map((d) => (
          <div key={d.date} className="flex min-w-0 flex-1 flex-col gap-[2px]">
            {d.counts.map((count, hour) => {
              const level = count <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
              return (
                <div
                  key={hour}
                  className="h-[7px] rounded-[1.5px] transition-colors duration-150"
                  style={{ backgroundColor: levelColor(level, colorVar) }}
                  onMouseEnter={(e) =>
                    setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                  }
                  onMouseMove={(e) =>
                    setTooltip({ x: e.clientX, y: e.clientY - 6, date: d.date, hour, count })
                  }
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        <span>1</span>
        <span>{Math.ceil(days.length / 2)}</span>
        <span>{days.length}</span>
      </div>
      {tooltip && (
        <ChartTooltip x={tooltip.x} y={tooltip.y}>
          <div className="font-semibold text-foreground">
            {formatHeatmapDate(tooltip.date)} {String(tooltip.hour).padStart(2, "0")}:00–
            {String((tooltip.hour + 1) % 24).padStart(2, "0")}:00
          </div>
          <div className="text-muted-foreground">
            {unit === "tokens"
              ? formatTokenCount(tooltip.count)
              : `${tooltip.count} ${t("analytics.tabMessages", { defaultValue: "messages" })}`}
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}
