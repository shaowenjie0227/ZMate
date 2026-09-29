import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/** 单个趋势数据点：value 为会话数或 token 总量，token 明细仅 Token 页签携带 */
export interface TrendPoint {
  key: string;
  label: string;
  value: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** 模型 token 占比条目（已按占比降序，超出的模型已合并为「其他」） */
export interface ModelShareItem {
  modelId: string;
  tokens: number;
  pct: number;
}

const ACCENT = "var(--heatmap-color, #A78BFA)";
/** 环形图分类色板：首位跟随 accent，其余为固定和谐色；溢出模型归入灰色「其他」 */
const DONUT_COLORS = [
  ACCENT,
  "#60A5FA",
  "#34D399",
  "#FBBF24",
  "#F472B6",
  "#22D3EE",
  "#A3E635",
];
const OTHER_COLOR = "#94A3B8";

/** token 数量紧凑展示：1234 -> 1.2k，1234567 -> 1.23M（与 overview-page 的汇总口径一致） */
function formatTokens(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** 与 ui/chart-tooltip.tsx 同风格的浮动提示内容（配色跟随全局 tooltip 方案） */
function TooltipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-[1.6] text-popover-foreground shadow-lg">
      {children}
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  isToken,
}: {
  active?: boolean;
  payload?: { payload: TrendPoint }[];
  isToken: boolean;
}) {
  const { t } = useTranslation();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <TooltipShell>
      <div className="font-semibold">{point.label}</div>
      <div>
        {isToken
          ? `${formatTokens(point.value)} tokens`
          : `${point.value.toLocaleString()} ${t("overview.sessionsUnit")}`}
      </div>
      {isToken && (point.inputTokens || point.outputTokens || point.reasoningTokens) ? (
        <div className="mt-0.5 border-t border-border/50 pt-0.5 opacity-80">
          {t("overview.tokenInput", { defaultValue: "Input" })} {formatTokens(point.inputTokens ?? 0)}
          {" · "}
          {t("overview.tokenOutput", { defaultValue: "Output" })} {formatTokens(point.outputTokens ?? 0)}
          {point.reasoningTokens ? (
            <>
              {" · "}
              {t("overview.tokenReasoning", { defaultValue: "Reasoning" })} {formatTokens(point.reasoningTokens)}
            </>
          ) : null}
        </div>
      ) : null}
    </TooltipShell>
  );
}

const AXIS_TICK = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;

/** 周视图：7 根日柱（本周一至周日），高度随容器自适应 */
export function TrendBarChart({ points, isToken }: { points: TrendPoint[]; isToken: boolean }) {
  return (
    <div className="h-full min-h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <Tooltip cursor={{ fill: "hsl(var(--muted) / 0.5)" }} content={<TrendTooltip isToken={isToken} />} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} dy={4} />
          <YAxis hide domain={[0, "auto"]} />
          <Bar
            dataKey="value"
            fill={ACCENT}
            radius={[4, 4, 0, 0]}
            maxBarSize={36}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 月/年视图：渐变面积趋势图（约 30 天或 12 个月），高度随容器自适应 */
export function TrendAreaChart({ points, isToken }: { points: TrendPoint[]; isToken: boolean }) {
  const gradientId = useId().replace(/:/g, "");
  return (
    <div className="h-full min-h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.28} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <Tooltip cursor={{ stroke: "hsl(var(--muted-foreground) / 0.4)", strokeDasharray: "3 3" }} content={<TrendTooltip isToken={isToken} />} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} dy={4} minTickGap={24} />
          <YAxis hide domain={[0, "auto"]} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={ACCENT}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 模型占比页签：环形图（左）+ 图例明细（右）横向布局 */
export function ModelShareDonut({ items }: { items: ModelShareItem[] }) {
  const { t } = useTranslation();
  const total = items.reduce((sum, item) => sum + item.tokens, 0);

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">
        {t("overview.modelShare", { defaultValue: "模型占比" })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="relative h-[172px] w-[172px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip
              content={({ active, payload }) => {
                const item = payload?.[0]?.payload as ModelShareItem | undefined;
                if (!active || !item) return null;
                return (
                  <TooltipShell>
                    <div className="font-semibold">{item.modelId}</div>
                    <div>
                      {formatTokens(item.tokens)} tokens · {item.pct.toFixed(1)}%
                    </div>
                  </TooltipShell>
                );
              }}
            />
            <Pie
              data={items}
              dataKey="tokens"
              nameKey="modelId"
              innerRadius="68%"
              outerRadius="96%"
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {items.map((entry, index) => (
                <Cell
                  key={entry.modelId}
                  fill={index < DONUT_COLORS.length ? DONUT_COLORS[index] : OTHER_COLOR}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold tabular-nums">{formatTokens(total)}</span>
          <span className="text-[10px] text-muted-foreground">tokens</span>
        </div>
        </div>
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          {items.map((item, index) => (
            <div key={item.modelId} className="flex items-center gap-2 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: index < DONUT_COLORS.length ? DONUT_COLORS[index] : OTHER_COLOR,
                }}
              />
              <span className="min-w-0 flex-1 truncate text-foreground/90" title={item.modelId}>
                {item.modelId}
              </span>
              <span className="tabular-nums text-muted-foreground">{formatTokens(item.tokens)}</span>
              <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">
                {item.pct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
