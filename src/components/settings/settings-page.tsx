import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Monitor, Moon, Sun, Globe } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ButtonBusyContent } from "@/components/ui/button-busy-content";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";
import { BentoCard } from "@/components/ui/bento-card";
import { toast } from "@/hooks/use-toast";
import { useBusyAction } from "@/hooks/use-busy-action";
import {
  ACCENT_PRESETS,
  HEATMAP_PRESETS,
  type AccentPreset,
  type HeatmapPreset,
} from "@/hooks/use-accent-color";
import type { Theme } from "@/hooks/use-theme";

const APP_STATE_QUERY_KEY = ["app-state"] as const;

interface SettingsPageProps {
  theme: Theme;
  onThemeChange: (theme: "light" | "dark" | "system") => void;
  accent: AccentPreset;
  setAccent: (accent: AccentPreset) => void;
  heatmap: HeatmapPreset;
  setHeatmap: (heatmap: HeatmapPreset) => void;
  language: string;
  setLanguage: (lang: string) => void;
  onCheckUpdate: () => Promise<"available" | "up-to-date" | "error">;
}

const PATH_LABEL_KEYS: Record<string, string> = {
  providerConfigPath: "providers.configFile",
  cliConfigPath: "mcp.configFile",
  skillsDir: "skills.rootPath",
  agentsMdPath: "customInstructions.globalScopeHint",
};

export function SettingsPage({
  theme,
  onThemeChange,
  accent,
  setAccent,
  heatmap,
  setHeatmap,
  language,
  setLanguage,
  onCheckUpdate,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: APP_STATE_QUERY_KEY,
    queryFn: () => api.loadAppState(),
    staleTime: Infinity,
    refetchOnMount: false,
  });
  const appState = stateQuery.data?.data;

  const checkRunningMutation = useMutation({
    mutationFn: (enabled: boolean) => api.setCheckZcodeRunning(enabled),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: APP_STATE_QUERY_KEY });
      type AppStateEnvelope = Awaited<ReturnType<typeof api.loadAppState>>;
      const previous = queryClient.getQueryData<AppStateEnvelope>(APP_STATE_QUERY_KEY);
      queryClient.setQueryData<AppStateEnvelope>(APP_STATE_QUERY_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          data: { ...old.data, settings: { ...old.data.settings, checkZcodeRunning: enabled } },
        };
      });
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(APP_STATE_QUERY_KEY, context.previous);
      }
      toast({
        title: t("common.error"),
        description: t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const updateCheckAction = useBusyAction({ minVisibleMs: 600 });
  const checkingUpdate = updateCheckAction.busy;
  const handleCheckUpdate = async () => {
    await updateCheckAction.run(async () => {
      try {
        const result = await onCheckUpdate();
        if (result === "up-to-date") {
          toast({ title: t("settings.upToDate"), description: t("settings.upToDateDesc") });
        } else if (result === "error") {
          toast({
            title: t("settings.updateCheckFailed"),
            description: t("settings.updateCheckFailedDesc"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("settings.updateCheckFailed"),
          description: t("settings.updateCheckFailedDesc"),
          variant: "destructive",
        });
      }
    });
  };

  const [appVersion, setAppVersion] = useState("...");
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    toast({ title: t("common.toastCopiedDesc"), variant: "success" });
  };

  return (
    <div className="space-y-8">
      <Section title={t("settings.appearance")}>
        <SettingRow label={t("settings.theme")}>
          <SettingSegmentedControl
            items={[
              { value: "light", icon: Sun, label: t("settings.light") },
              { value: "dark", icon: Moon, label: t("settings.dark") },
              { value: "system", icon: Monitor, label: t("settings.system") },
            ]}
            value={theme}
            onChange={(v) => onThemeChange(v as "light" | "dark" | "system")}
          />
        </SettingRow>

        <SettingRow label={t("settings.language")}>
          <SettingSegmentedControl
            items={[
              { value: "zh", icon: Globe, label: "中文" },
              { value: "en", icon: Globe, label: "English" },
            ]}
            value={language}
            onChange={setLanguage}
          />
        </SettingRow>

        <SettingRow label={t("settings.accentColor")} description={t("settings.accentColorDesc")}>
          <div className="flex gap-2">
            {(Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((key) => (
              <button
                key={key}
                onClick={() => setAccent(key)}
                title={ACCENT_PRESETS[key].label}
                className={cn(
                  "h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-card transition-transform hover:scale-110",
                  accent === key ? "ring-foreground" : "ring-transparent",
                )}
                style={{ backgroundColor: ACCENT_PRESETS[key].hex }}
              />
            ))}
          </div>
        </SettingRow>

        <SettingRow label={t("settings.heatmapColor")} description={t("settings.heatmapColorDesc")}>
          <div className="flex gap-2">
            {(Object.keys(HEATMAP_PRESETS) as HeatmapPreset[]).map((key) => (
              <button
                key={key}
                onClick={() => setHeatmap(key)}
                title={HEATMAP_PRESETS[key].label}
                className={cn(
                  "h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-card transition-transform hover:scale-110",
                  heatmap === key ? "ring-foreground" : "ring-transparent",
                )}
                style={{ backgroundColor: HEATMAP_PRESETS[key].hex }}
              />
            ))}
          </div>
        </SettingRow>
      </Section>

      <Section title={t("settings.behavior")}>
        <SettingRow
          label={t("settings.checkZcodeRunning")}
          description={t("settings.checkZcodeRunningDesc")}
        >
          <Switch
            checked={appState?.settings.checkZcodeRunning ?? true}
            onCheckedChange={(v) => checkRunningMutation.mutate(v)}
            disabled={checkRunningMutation.isPending}
          />
        </SettingRow>
        {appState && (
          <SettingRow
            label={
              <div className="flex items-center gap-2">
                <span>{t("maintenance.diagnose")}</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[11px] font-normal",
                    appState.zcodeRunning && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                  )}
                >
                  {appState.zcodeRunning ? t("maintenance.zcodeRunning") : t("maintenance.zcodeNotRunning")}
                </Badge>
              </div>
            }
          >
            <span />
          </SettingRow>
        )}
        {appState &&
          (
            [
              ["providerConfigPath", PATH_LABEL_KEYS.providerConfigPath],
              ["cliConfigPath", PATH_LABEL_KEYS.cliConfigPath],
              ["skillsDir", PATH_LABEL_KEYS.skillsDir],
              ["agentsMdPath", PATH_LABEL_KEYS.agentsMdPath],
            ] as const
          ).map(([key, labelKey]) => (
            <SettingRow
              key={key}
              label={t(labelKey)}
              description={appState[key]}
            >
              <Button variant="ghost" size="icon-sm" onClick={() => void copyPath(appState[key])}>
                <Copy />
              </Button>
            </SettingRow>
          ))}
      </Section>

      <Section title={t("settings.about")}>
        <SettingRow label={t("settings.version")}>
          <span className="text-sm text-muted-foreground">{appVersion}</span>
        </SettingRow>
        <SettingRow label={t("settings.checkUpdate")}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckUpdate}
            disabled={checkingUpdate}
            aria-busy={checkingUpdate}
          >
            <ButtonBusyContent
              busy={checkingUpdate}
              idleIcon={<Download className="h-3.5 w-3.5 shrink-0" />}
              idleLabel={t("settings.checkUpdate")}
              busyLabel={t("settings.checkUpdateBusy")}
            />
          </Button>
        </SettingRow>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h2 className="px-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        {title}
      </h2>
      <BentoCard className="p-0 [&>div]:divide-y [&>div]:divide-border">{children}</BentoCard>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div className="min-w-0">
        <span className="text-[13px] font-medium">{label}</span>
        {description && (
          <div className="mt-0.5 break-all text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function SettingSegmentedControl({
  items,
  value,
  onChange,
  compact = false,
}: {
  items: {
    value: string;
    icon?: typeof Sun;
    label: string;
  }[];
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-full bg-muted p-0.5 dark:bg-white/[0.06]")}>
      <AnimatedSegmentedControl
        items={items}
        value={value}
        onValueChange={(nextValue) => onChange(nextValue)}
        className="gap-0.5"
        indicatorClassName="rounded-full bg-white shadow-sm dark:bg-white/[0.10]"
        itemClassName={cn(
          "rounded-full whitespace-nowrap text-xs font-medium [&_svg]:h-3.5 [&_svg]:w-3.5",
          compact ? "px-2.5 py-1.5" : "gap-1.5 px-3 py-1.5",
        )}
        activeItemClassName="text-foreground"
        inactiveItemClassName="text-muted-foreground hover:text-foreground"
      />
    </div>
  );
}
