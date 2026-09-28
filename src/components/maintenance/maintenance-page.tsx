import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { flushSync } from "react-dom";
import { ArrowLeftRight, CircleCheck, CircleX, Download, ExternalLink, Loader2, Play, Waypoints } from "lucide-react";

import { api } from "@/lib/api";
import { SITE_DIRECT_ORIGINS, siteDirectApi, type SiteDirectPingResult } from "@/lib/site-direct";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { BentoCard } from "@/components/ui/bento-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const MIN_FEEDBACK_MS = 800;

const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai";

const PATH_LABELS: Record<string, string> = {
  zcodeHome: "ZCode 主目录",
  providerConfig: "供应商配置",
  cliConfig: "CLI 配置",
  skillsDir: "Skills 目录",
  agentsMd: "AGENTS.md",
  tasksDb: "会话索引库",
  sessionDb: "会话数据库",
  rolloutDir: "模型日志目录",
  appDataDir: "面板数据目录",
};


interface ActionResult {
  type: "success" | "error";
  message: string;
}

/** 「IP 直连站点」的三个入口：主域名 + 两台直连 IP（与 Rust 侧优先级一致） */
const DIRECT_TARGETS = [
  { key: "domain", origin: SITE_DIRECT_ORIGINS.domain, labelKey: "maintenance.directTargetDomain" },
  { key: "ipPrimary", origin: SITE_DIRECT_ORIGINS.ipPrimary, labelKey: "maintenance.directTargetIpPrimary" },
  { key: "ipFallback", origin: SITE_DIRECT_ORIGINS.ipFallback, labelKey: "maintenance.directTargetIpFallback" },
] as const;

type DirectOutcome =
  | { type: "switched"; targetOrigin: string; providersUpdated: number }
  | { type: "restored"; targetOrigin: string; providersUpdated: number }
  | { type: "allFailed" }
  | { type: "applyFailed"; message: string };

type DirectRowState = { status: "testing" } | { status: "done"; ping: SiteDirectPingResult };

interface DiagnoseResult {
  zcodeRunning: boolean;
  coreVersion: string;
  os: string;
  arch: string;
  pathChecks: { key: string; path: string; exists: boolean }[];
  providerConfigValid: boolean;
  providerConfigError: string | null;
  cliConfigValid: boolean;
  cliConfigError: string | null;
}

export function MaintenancePage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [runningKeys, setRunningKeys] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const [diagnoseOpen, setDiagnoseOpen] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [downloadConfirmOpen, setDownloadConfirmOpen] = useState(false);

  // 流量代理：本地编辑态 + 服务端持久态
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState("");
  const proxyHydratedRef = useRef(false);
  const proxyQuery = useQuery({
    queryKey: ["zcode-proxy"],
    queryFn: async () => (await api.loadZcodeProxy()).data,
  });
  useEffect(() => {
    if (proxyQuery.data && !proxyHydratedRef.current) {
      proxyHydratedRef.current = true;
      setProxyEnabled(proxyQuery.data.enabled);
      setProxyPort(proxyQuery.data.port ?? "");
    }
  }, [proxyQuery.data]);
  const proxyPortTrimmed = proxyPort.trim();
  const proxyPortValid =
    /^\d{1,5}$/.test(proxyPortTrimmed) &&
    Number(proxyPortTrimmed) >= 1 &&
    Number(proxyPortTrimmed) <= 65535;

  const proxyMutation = useMutation({
    mutationFn: (vars: { enabled: boolean; port: string }) =>
      api.setZcodeProxy(vars.enabled, vars.enabled ? vars.port : null),
    onSuccess: (response, vars) => {
      const data = response.data;
      proxyHydratedRef.current = true;
      setProxyEnabled(data.enabled);
      if (data.port) setProxyPort(data.port);
      if (!vars.enabled) setProxyPort("");
      setActionResult("proxy", {
        type: "success",
        message: t("maintenance.proxySaved", { path: data.sourcePath }),
      });
      toast({ title: t("maintenance.proxySaved", { path: data.sourcePath }), variant: "success" });
      void proxyQuery.refetch();
    },
    onError: (error) =>
      setActionResult("proxy", { type: "error", message: String(error) }),
  });

  const setActionResult = (key: string, result: ActionResult) => {
    setResults((prev) => ({ ...prev, [key]: result }));
  };

  // -----------------------------------------------------------------
  // IP 直连站点：徽章显示当前入口；「切换」打开弹窗测试三个入口的
  // 可达性，由用户点选改换入口（选回主域名即恢复=关闭直连），不自动切换
  // -----------------------------------------------------------------
  const queryClient = useQueryClient();
  const [directTesting, setDirectTesting] = useState(false);
  const [directDialogOpen, setDirectDialogOpen] = useState(false);
  const [directRows, setDirectRows] = useState<Record<string, DirectRowState>>({});
  const [directOutcome, setDirectOutcome] = useState<DirectOutcome | null>(null);
  const [directSelectedOrigin, setDirectSelectedOrigin] = useState<string | null>(null);
  const [directBusyOrigin, setDirectBusyOrigin] = useState<string | null>(null);
  const directBusy = directTesting;

  const directQuery = useQuery({
    queryKey: ["site-direct"],
    queryFn: async () => (await siteDirectApi.status()).data,
  });

  // 站点入口变更后，所有走存储连接的查询与供应商列表都需要用新地址重取
  const invalidateSiteQueries = useCallback(() => {
    for (const key of ["site-connection", "site-usage", "wallet", "api-keys", "user-profile", "providers"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    void queryClient.invalidateQueries({ queryKey: ["site-logs"] });
  }, [queryClient]);

  // 把站点入口切换到指定目标：弹窗内点选入口与自动切换共用
  const applyDirectOrigin = async (targetOrigin: string) => {
    setDirectBusyOrigin(targetOrigin);
    setDirectOutcome(null);
    try {
      const response = await siteDirectApi.apply(targetOrigin);
      const restored = targetOrigin === SITE_DIRECT_ORIGINS.domain;
      setDirectSelectedOrigin(targetOrigin);
      setDirectOutcome({
        type: restored ? "restored" : "switched",
        targetOrigin,
        providersUpdated: response.data.providersUpdated,
      });
      toast({
        title: restored
          ? t("maintenance.directRestored", {
              origin: targetOrigin,
              count: response.data.providersUpdated,
            })
          : t("maintenance.directSwitched", {
              origin: targetOrigin,
              count: response.data.providersUpdated,
            }),
        variant: "success",
      });
      invalidateSiteQueries();
    } catch (error) {
      setDirectOutcome({
        type: "applyFailed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDirectBusyOrigin(null);
      void directQuery.refetch();
    }
  };

  // 打开弹窗测试三个入口的可达性，由用户点选改换入口（选回主域名即恢复）
  const runDirectTest = async () => {
    setDirectTesting(true);
    setDirectOutcome(null);
    setDirectSelectedOrigin(directQuery.data?.currentOrigin ?? null);
    setDirectRows(
      Object.fromEntries(DIRECT_TARGETS.map((target) => [target.key, { status: "testing" as const }])),
    );

    try {
      const settled = await Promise.all(
        DIRECT_TARGETS.map(async (target) => {
          try {
            const response = await siteDirectApi.ping(target.key, target.origin);
            return { key: target.key, ping: response.data };
          } catch (error) {
            const ping: SiteDirectPingResult = {
              label: target.key,
              origin: target.origin,
              reachable: false,
              statusCode: null,
              latencyMs: null,
              error: error instanceof Error ? error.message : String(error),
            };
            return { key: target.key, ping };
          }
        }),
      );
      setDirectRows(Object.fromEntries(settled.map(({ key, ping }) => [key, { status: "done" as const, ping }])));

      if (!settled.some(({ ping }) => ping.reachable)) {
        setDirectOutcome({ type: "allFailed" });
        toast({ title: t("maintenance.directAllFailed"), variant: "destructive" });
      }
    } finally {
      setDirectTesting(false);
    }
  };

  const openDirectDialog = () => {
    setDirectDialogOpen(true);
    void runDirectTest();
  };

  const diagnoseMutation = useMutation({
    mutationFn: () => api.diagnose(),
    onSuccess: (response) => {
      const data = response.data;
      setDiagnose({
        zcodeRunning: data.zcodeRunning,
        coreVersion: data.coreVersion,
        os: data.os,
        arch: data.arch,
        pathChecks: data.pathChecks,
        providerConfigValid: data.providerConfigValid,
        providerConfigError: data.providerConfigError,
        cliConfigValid: data.cliConfigValid,
        cliConfigError: data.cliConfigError,
      });
    },
    onError: (error) => {
      setDiagnose(null);
      setDiagnoseError(String(error));
    },
  });

  const cleanMutation = useMutation({
    mutationFn: () => api.clean(),
    onSuccess: (response) =>
      setActionResult("clean", {
        type: "success",
        message: t("maintenance.cleanResult", {
          provider: response.data.providerBackupsRemoved,
          skill: response.data.skillBackupsRemoved,
          instruction: response.data.instructionHistoryRemoved,
        }),
      }),
    onError: (error) => setActionResult("clean", { type: "error", message: String(error) }),
  });

  const restartMutation = useMutation({
    mutationFn: () => api.restartZcode(),
    onSuccess: () => {
      setActionResult("restart", { type: "success", message: t("maintenance.zcodeRestarted") });
      toast({ title: t("maintenance.zcodeRestarted"), variant: "success" });
    },
    onError: (error) => {
      setActionResult("restart", { type: "error", message: String(error) });
      toast({
        title: t("maintenance.restartFailed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const runAction = useCallback(
    async (key: string, mutateAsync: () => Promise<unknown>) => {
      if (runningKeys[key]) return;
      flushSync(() => setRunningKeys((prev) => ({ ...prev, [key]: true })));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const startedAt = Date.now();
      try {
        await mutateAsync();
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_FEEDBACK_MS) {
          await new Promise((r) => setTimeout(r, MIN_FEEDBACK_MS - elapsed));
        }
        setRunningKeys((prev) => ({ ...prev, [key]: false }));
      }
    },
    [runningKeys],
  );

  const openOfficialSite = async () => {
    try {
      await api.openPath(ZCODE_DOWNLOAD_URL);
    } catch (error) {
      toast({
        title: t("maintenance.installOpenFailed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("maintenance.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("maintenance.description")}</p>
      </div>

      <ActionCard
        title={t("maintenance.install")}
        description={t("maintenance.installDesc")}
        actionLabel={t("maintenance.installAction")}
        onRun={() => setDownloadConfirmOpen(true)}
        icon={<Download />}
        secondary={{
          label: t("maintenance.openOfficialSite"),
          icon: <ExternalLink />,
          onClick: () => void openOfficialSite(),
        }}
      />

      <ActionCard
        title={t("maintenance.diagnose")}
        description={t("maintenance.diagnoseDesc")}
        actionLabel={t("maintenance.diagnoseAction")}
        runningLabel={t("maintenance.diagnosing")}
        busy={runningKeys.diagnose === true}
        onRun={() => {
          setDiagnoseError(null);
          setDiagnoseOpen(true);
          void runAction("diagnose", () => diagnoseMutation.mutateAsync());
        }}
      />
      <Dialog open={diagnoseOpen} onOpenChange={setDiagnoseOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("maintenance.diagnose")}</DialogTitle>
            <DialogDescription>{t("maintenance.diagnoseDesc")}</DialogDescription>
          </DialogHeader>
          {runningKeys.diagnose === true ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("maintenance.diagnosing")}
            </div>
          ) : diagnoseError ? (
            <p className="py-6 text-center text-sm text-destructive">{diagnoseError}</p>
          ) : diagnose ? (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {t("maintenance.diagnoseResult", {
                  os: diagnose.os,
                  arch: diagnose.arch,
                  version: diagnose.coreVersion,
                })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className={cn(
                    "gap-1",
                    diagnose.zcodeRunning && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                  )}
                >
                  {diagnose.zcodeRunning ? t("maintenance.zcodeRunning") : t("maintenance.zcodeNotRunning")}
                </Badge>
                <Badge
                  variant="secondary"
                  className={cn(
                    "gap-1",
                    diagnose.providerConfigValid
                      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                      : "bg-destructive/12 text-destructive",
                  )}
                >
                  {diagnose.providerConfigValid ? t("maintenance.configValid") : t("maintenance.configInvalid")}
                </Badge>
                <Badge
                  variant="secondary"
                  className={cn(
                    "gap-1",
                    diagnose.cliConfigValid
                      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                      : "bg-destructive/12 text-destructive",
                  )}
                >
                  {diagnose.cliConfigValid ? t("maintenance.configValid") : t("maintenance.configInvalid")}
                </Badge>
              </div>
              {diagnose.providerConfigError && (
                <p className="text-xs text-destructive">{diagnose.providerConfigError}</p>
              )}
              {diagnose.cliConfigError && <p className="text-xs text-destructive">{diagnose.cliConfigError}</p>}
              <div className="grid gap-1.5 sm:grid-cols-2">
                {diagnose.pathChecks.map((check) => (
                  <div key={check.key} className="flex items-center gap-2 text-xs">
                    {check.exists ? (
                      <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <CircleX className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-muted-foreground">{PATH_LABELS[check.key] ?? check.key}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
                      {check.path}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiagnoseOpen(false)}>
              {t("maintenance.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BentoCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-medium">{t("maintenance.directTitle")}</h3>
              {directQuery.data?.currentOrigin && (
                <span
                  className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground"
                  title={directQuery.data.currentOrigin}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      directQuery.data?.directActive ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">
                    {directQuery.data.currentOrigin.replace(/^https?:\/\//, "")}
                  </span>
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("maintenance.directDesc")}</p>
          </div>
          <Button size="sm" variant="outline" disabled={directBusy} onClick={openDirectDialog}>
            {directBusy ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
            {t("maintenance.directSwitchButton")}
          </Button>
        </div>

        {directQuery.data?.directActive && directQuery.data.providerMatches != null && (
          <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
            {t("maintenance.directCurrent", {
              providers: directQuery.data.providerMatches,
            })}
          </p>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
          {t("maintenance.directHint")}
        </p>
      </BentoCard>

      <Dialog open={directDialogOpen} onOpenChange={setDirectDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("maintenance.directTitle")}</DialogTitle>
            <DialogDescription>{t("maintenance.directDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2" role="radiogroup" aria-label={t("maintenance.directTitle")}>
            {DIRECT_TARGETS.map((target) => {
              const row = directRows[target.key];
              const ping = row?.status === "done" ? row.ping : null;
              const reachable = ping?.reachable ?? false;
              const selected = directSelectedOrigin === target.origin;
              const busy = directBusyOrigin === target.origin;
              // 可点选 = 测试完成且该入口可达、当前不忙、且不是正在使用的入口
              const selectable = ping != null && reachable && !directBusy && !busy && !selected;
              return (
                <div
                  key={target.key}
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={!selectable}
                  tabIndex={selectable ? 0 : -1}
                  onClick={() => {
                    if (selectable) void applyDirectOrigin(target.origin);
                  }}
                  onKeyDown={(event) => {
                    if (selectable && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      void applyDirectOrigin(target.origin);
                    }
                  }}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors",
                    selectable && "cursor-pointer hover:border-primary/50 hover:bg-muted/40",
                    selected && "border-primary/60 bg-primary/5",
                    ping != null && !reachable && "opacity-60",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border-2",
                        selected ? "border-primary" : "border-muted-foreground/30",
                      )}
                    >
                      {selected && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{t(target.labelKey)}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{target.origin}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-xs">
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : !ping ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                        <span className="text-muted-foreground">{t("maintenance.directRowTesting")}</span>
                      </>
                    ) : ping.reachable ? (
                      <>
                        <CircleCheck className="size-3.5 text-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {ping.latencyMs != null ? `${ping.latencyMs}ms` : `HTTP ${ping.statusCode ?? 0}`}
                        </span>
                      </>
                    ) : (
                      <>
                        <CircleX className="size-3.5 text-destructive" />
                        <span
                          className="max-w-[170px] truncate text-destructive"
                          title={ping.error ?? undefined}
                        >
                          {ping.error ?? t("maintenance.directRowUnreachable")}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {directOutcome?.type === "allFailed" && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm leading-relaxed text-destructive">
              {t("maintenance.directAllFailed")}
            </div>
          )}
          {directOutcome?.type === "applyFailed" && (
            <p className="break-all text-sm text-destructive">
              {t("maintenance.directApplyFailed", { message: directOutcome.message })}
            </p>
          )}
          {directOutcome &&
            (directOutcome.type === "switched" || directOutcome.type === "restored") && (
              <p className="break-all text-sm text-emerald-600 dark:text-emerald-400">
                {directOutcome.type === "switched"
                  ? t("maintenance.directSwitched", {
                      origin: directOutcome.targetOrigin,
                      count: directOutcome.providersUpdated,
                    })
                  : t("maintenance.directRestored", {
                      origin: directOutcome.targetOrigin,
                      count: directOutcome.providersUpdated,
                    })}
              </p>
            )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDirectDialogOpen(false)}>
              {t("maintenance.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BentoCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-medium">{t("maintenance.proxyTitle")}</h3>
              <Badge
                variant="secondary"
                className={cn(
                  proxyQuery.data?.enabled &&
                    "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                )}
              >
                {proxyQuery.data?.enabled ? t("maintenance.proxyOn") : t("maintenance.proxyOff")}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("maintenance.proxyDesc")}</p>
          </div>
          <Switch
            checked={proxyEnabled}
            onCheckedChange={setProxyEnabled}
            disabled={runningKeys.proxyApply === true}
          />
        </div>

        {proxyEnabled && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("maintenance.proxyPortLabel")}
            </span>
            <div className="flex h-9 items-center rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm text-muted-foreground">
              http://127.0.0.1:
            </div>
            <Input
              value={proxyPort}
              onChange={(e) => setProxyPort(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="7890"
              inputMode="numeric"
              className="h-9 w-24 font-mono"
            />
            <Button
              size="sm"
              disabled={!proxyPortValid || runningKeys.proxyApply === true}
              onClick={() =>
                void runAction("proxyApply", () =>
                  proxyMutation.mutateAsync({
                    enabled: true,
                    port: proxyPortTrimmed,
                  }),
                )
              }
            >
              {runningKeys.proxyApply === true ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Waypoints />
              )}
              {runningKeys.proxyApply === true
                ? t("maintenance.proxyApplying")
                : t("maintenance.proxyApply")}
            </Button>
            {!proxyPortValid && proxyPortTrimmed !== "" && (
              <span className="text-xs text-destructive">{t("maintenance.proxyInvalidPort")}</span>
            )}
            {proxyQuery.data?.enabled && !proxyQuery.data.isLocal && proxyQuery.data.proxyUrl && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t("maintenance.proxyExternalHint", { url: proxyQuery.data.proxyUrl })}
              </span>
            )}
          </div>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
          {t("maintenance.proxyHint")}
        </p>
        {results.proxy && (
          <p
            className={cn(
              "mt-1 break-all text-xs",
              results.proxy.type === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {results.proxy.message}
          </p>
        )}
      </BentoCard>

      <ActionCard
        title={t("maintenance.clean")}
        description={t("maintenance.cleanDesc")}
        actionLabel={t("maintenance.cleanAction")}
        runningLabel={t("maintenance.cleaning")}
        busy={runningKeys.clean === true}
        onRun={() => runAction("clean", () => cleanMutation.mutateAsync())}
        result={results.clean}
      />

      <ActionCard
        title={t("maintenance.restartZcode")}
        description={t("maintenance.restartZcodeDesc")}
        actionLabel={t("maintenance.restartZcodeAction")}
        runningLabel={t("maintenance.cleaning")}
        busy={runningKeys.restart === true}
        onRun={() => setRestartConfirmOpen(true)}
        result={results.restart}
      />

      <AlertDialog open={restartConfirmOpen} onOpenChange={setRestartConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("maintenance.restartConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("maintenance.restartConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRestartConfirmOpen(false);
                void runAction("restart", () => restartMutation.mutateAsync());
              }}
            >
              {t("maintenance.restartZcodeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={downloadConfirmOpen} onOpenChange={setDownloadConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("maintenance.downloadConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("maintenance.downloadConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDownloadConfirmOpen(false);
                void openOfficialSite();
              }}
            >
              {t("maintenance.installAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ActionCard({
  title,
  description,
  actionLabel,
  runningLabel,
  busy = false,
  onRun,
  result,
  children,
  icon,
  secondary,
}: {
  title: string;
  description: string;
  actionLabel: string;
  runningLabel?: string;
  busy?: boolean;
  onRun: () => void;
  result?: ActionResult;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  secondary?: { label: string; icon?: React.ReactNode; onClick: () => void };
}) {
  return (
    <BentoCard className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {secondary && (
            <Button size="sm" variant="outline" onClick={secondary.onClick}>
              {secondary.icon}
              {secondary.label}
            </Button>
          )}
          <Button size="sm" onClick={onRun} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : (icon ?? <Play />)}
            {busy ? runningLabel : actionLabel}
          </Button>
        </div>
      </div>
      {result && (
        <p
          className={cn(
            "mt-3 break-all text-xs",
            result.type === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
          )}
        >
          {result.message}
        </p>
      )}
      {children && <div className="mt-3">{children}</div>}
    </BentoCard>
  );
}
