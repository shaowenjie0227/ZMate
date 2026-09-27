import { Suspense, lazy, useCallback, useEffect, useState, type CSSProperties } from "react";
import { QueryClientProvider, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/use-theme";
import { useAccentColor } from "@/hooks/use-accent-color";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useDeferredReady } from "@/hooks/use-deferred-ready";
import { useRouteTransition } from "@/hooks/use-route-transition";
import { Loader2, RefreshCw } from "lucide-react";
import { PageStage } from "@/components/layout/page-stage";
import { ZTraceIntro } from "@/components/usage-logs/z-trace-intro";
import { Button } from "@/components/ui/button";
import {
  AppSidebar,
  appNavItems,
  SIDEBAR_COLLAPSED_WIDTH_PX,
  SIDEBAR_EXPANDED_WIDTH_PX,
} from "@/components/layout/sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/toaster";
import { UpdateOverlay } from "@/components/update/update-overlay";
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
import { createAppQueryClient } from "@/lib/query-client";
import { api } from "@/lib/api";
import type { Route } from "@/types/navigation";
import "./lib/i18n";

const OverviewPage = lazy(() =>
  import("@/components/overview/overview-page").then((module) => ({ default: module.OverviewPage })),
);
const ProvidersPage = lazy(() =>
  import("@/components/providers/providers-page").then((module) => ({ default: module.ProvidersPage })),
);
const WalletPage = lazy(() =>
  import("@/components/wallet/wallet-page").then((module) => ({ default: module.WalletPage })),
);
const ApiKeysPage = lazy(() =>
  import("@/components/api-keys/api-keys-page").then((module) => ({ default: module.ApiKeysPage })),
);
const UsageLogsPage = lazy(() =>
  import("@/components/usage-logs/usage-logs-page").then((module) => ({
    default: module.UsageLogsPage,
  })),
);
const McpPage = lazy(() =>
  import("@/components/mcp/mcp-page").then((module) => ({ default: module.McpPage })),
);
const SkillsPage = lazy(() =>
  import("@/components/skills/skills-page").then((module) => ({ default: module.SkillsPage })),
);
const CustomInstructionsPage = lazy(() =>
  import("@/components/custom-instructions/custom-instructions-page").then((module) => ({ default: module.CustomInstructionsPage })),
);
const SessionsPage = lazy(() =>
  import("@/components/sessions/sessions-page").then((module) => ({ default: module.SessionsPage })),
);
const MaintenancePage = lazy(() =>
  import("@/components/maintenance/maintenance-page").then((module) => ({ default: module.MaintenancePage })),
);
const SettingsPage = lazy(() =>
  import("@/components/settings/settings-page").then((module) => ({ default: module.SettingsPage })),
);
const SiteLoginPage = lazy(() =>
  import("@/components/site-login/site-login-page").then((module) => ({
    default: module.SiteLoginPage,
  })),
);
const ProfilePage = lazy(() =>
  import("@/components/profile/profile-page").then((module) => ({
    default: module.ProfilePage,
  })),
);

const queryClient = createAppQueryClient();

export function MainAppRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <MainApp />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function MainApp() {
  const [route, setRoute] = useState<Route>("overview");
  const { theme, setTheme } = useTheme();
  const { accent, setAccent, heatmap, setHeatmap } = useAccentColor();
  const { i18n, t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("sidebar_collapsed") === "false",
  );
  const update = useUpdateCheck();
  const showUpdateOverlay =
    update.status === "available" ||
    update.status === "downloading" ||
    update.status === "installing" ||
    update.status === "error";

  const installLocationPrompt = useInstallLocationPrompt();
  const routeTransition = useRouteTransition(route, { durationMs: 240 });
  // 「使用日志」打开动画：每次切到该页面时播放一次
  const [zIntroKey, setZIntroKey] = useState(0);
  useEffect(() => {
    if (route !== "usageLogs") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setZIntroKey((k) => k + 1);
  }, [route]);

  const handleThemeChange = useCallback((nextTheme: "light" | "dark" | "system") => {
    setTheme(nextTheme);
  }, [setTheme]);

  const prewarmRoutes = useDeferredReady(900);
  useEffect(() => {
    if (prewarmRoutes) {
      void Promise.allSettled([
        import("@/components/overview/overview-page"),
        import("@/components/providers/providers-page"),
        import("@/components/wallet/wallet-page"),
        import("@/components/api-keys/api-keys-page"),
        import("@/components/usage-logs/usage-logs-page"),
        import("@/components/mcp/mcp-page"),
        import("@/components/skills/skills-page"),
        import("@/components/custom-instructions/custom-instructions-page"),
        import("@/components/sessions/sessions-page"),
        import("@/components/maintenance/maintenance-page"),
        import("@/components/settings/settings-page"),
        import("@/components/site-login/site-login-page"),
        import("@/components/profile/profile-page"),
      ]);
    }
  }, [prewarmRoutes]);

  const renderPage = (targetRoute: Route) => {
    switch (targetRoute) {
      case "overview":
        return <OverviewPage />;
      case "providers":
        return <ProvidersPage />;
      case "apiKeys":
        return <ApiKeysPage />;
      case "usageLogs":
        return <UsageLogsPage />;
      case "wallet":
        return <WalletPage />;
      case "mcp":
        return <McpPage />;
      case "skills":
        return <SkillsPage />;
      case "customInstructions":
        return <CustomInstructionsPage />;
      case "sessions":
        return <SessionsPage />;
      case "maintenance":
        return <MaintenancePage />;
      case "siteLogin":
        return <SiteLoginPage />;
      case "profile":
        return <ProfilePage onNavigate={setRoute} />;
      case "settings":
        return (
          <SettingsPage
            theme={theme}
            onThemeChange={handleThemeChange}
            accent={accent}
            setAccent={setAccent}
            heatmap={heatmap}
            setHeatmap={setHeatmap}
            language={i18n.language}
            setLanguage={(lang) => {
              i18n.changeLanguage(lang);
              localStorage.setItem("app_language", lang);
            }}
            onCheckUpdate={update.checkForUpdate}
          />
        );
      default:
        return null;
    }
  };

  // 不在侧边栏导航里的路由标题兜底（如登录令牌页，经「登录站点」/个人中心快捷入口进入）
  const routeLabelKey =
    appNavItems.find((item) => item.route === route)?.labelKey ??
    (route === "siteLogin" ? "nav.siteLogin" : "nav.overview");

  const routeOrder: Route[] = [
    "overview",
    "providers",
    "apiKeys",
    "usageLogs",
    "wallet",
    "mcp",
    "skills",
    "customInstructions",
    "sessions",
    "maintenance",
    "settings",
    "siteLogin",
    "profile",
  ];

  // 满高页面：自身管理内部滚动（如使用日志的固定底部分页栏），Stage 不再整体滚动
  const fillHeightRoutes = new Set<Route>(["usageLogs"]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#FFFFFF] dark:bg-background">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={(open) => {
          setSidebarOpen(open);
          localStorage.setItem("sidebar_collapsed", String(!open));
        }}
        style={
          {
            "--sidebar-width": `${SIDEBAR_EXPANDED_WIDTH_PX}px`,
            "--sidebar-width-icon": `${SIDEBAR_COLLAPSED_WIDTH_PX}px`,
          } as CSSProperties
        }
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        <AppSidebar
          activeRoute={route}
          onNavigate={setRoute}
          onThemeChange={handleThemeChange}
        />
        <SidebarInset className="max-h-screen overflow-hidden">
          <SiteHeader
            title={t(routeLabelKey)}
            action={
              route === "overview" ? (
                <HeaderRefreshButton />
              ) : undefined
            }
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {route === "usageLogs" && zIntroKey > 0 && (
              <ZTraceIntro key={zIntroKey} onFinish={() => setZIntroKey(0)} />
            )}
            {routeOrder
              .filter((candidate) => routeTransition.mountedRoutes.includes(candidate))
              .map((candidate) => (
                <PageStage
                  key={candidate}
                  state={routeTransition.getStage(candidate)}
                  fillHeight={fillHeightRoutes.has(candidate)}
                  scrollable={!fillHeightRoutes.has(candidate)}
                >
                  <Suspense fallback={<PageShellSkeleton />}>
                    {renderPage(candidate)}
                  </Suspense>
                </PageStage>
              ))}
          </div>
        </SidebarInset>
      </SidebarProvider>

      <Toaster />
      <InstallLocationPromptDialog prompt={installLocationPrompt} />
      {showUpdateOverlay && !installLocationPrompt.open && (
        <UpdateOverlay
          status={update.status as "checking" | "available" | "downloading" | "installing" | "error"}
          currentVersion={update.updateInfo?.currentVersion ?? "0.0.0"}
          newVersion={update.updateInfo?.version}
          body={update.updateInfo?.body}
          progress={update.progress}
          error={update.error}
          onInstall={update.installUpdate}
          onRetry={update.checkForUpdate}
          onSkip={update.dismiss}
        />
      )}
    </div>
  );
}

function useInstallLocationPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .checkUpdateInstallability()
      .then((payload) => {
        if (cancelled) return;
        if (payload.code === "app_translocation" || payload.code === "read_only_location") {
          setOpen(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => setOpen(false);

  const openApplications = async () => {
    await api.openPath("/Applications");
    setOpen(false);
  };

  return {
    open,
    dismiss,
    openApplications,
  };
}

function InstallLocationPromptDialog({
  prompt,
}: {
  prompt: ReturnType<typeof useInstallLocationPrompt>;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={prompt.open}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("update.installPromptTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("update.installPromptDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={prompt.dismiss}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={prompt.openApplications}>
            {t("update.openApplications")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PageShellSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between border-b border-border/60 pb-4 last:border-b-0">
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-20 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 仪表盘顶栏刷新按钮：重拉仪表盘与站点用量两个查询 */
function HeaderRefreshButton() {
  const queryClient = useQueryClient();
  const fetching =
    useIsFetching({ queryKey: ["dashboard"] }) +
    useIsFetching({ queryKey: ["site-usage"] });
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-8"
      onClick={() => {
        void queryClient.refetchQueries({ queryKey: ["dashboard"] });
        void queryClient.refetchQueries({ queryKey: ["site-usage"] });
      }}
      disabled={fetching > 0}
    >
      {fetching > 0 ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
    </Button>
  );
}
