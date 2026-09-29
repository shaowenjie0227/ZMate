import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  CircleUserRound,
  FileCode2,
  Key,
  LayoutDashboard,
  LogIn,
  LogOut,
  MessagesSquare,
  ScrollText,
  Server,
  Sparkles,
  Wallet,
  Wrench,
  Settings,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";

import { api } from "@/lib/api";
import { SITE_DIRECT_ORIGINS } from "@/lib/site-direct";
import { useThemeValue, type Theme } from "@/hooks/use-theme";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { Route } from "@/types/navigation";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { AnimatedSegmentedControl } from "@/components/ui/animated-segmented-control";

export const appNavItems: {
  route: Route;
  icon: LucideIcon;
  labelKey: string;
  /** 底部独立槽位（站点账号相关页 + 账号操作，与主导航隔开） */
  bottom?: boolean;
}[] = [
  { route: "overview", icon: LayoutDashboard, labelKey: "nav.overview" },
  { route: "providers", icon: Boxes, labelKey: "nav.providers" },
  { route: "mcp", icon: Server, labelKey: "nav.mcp" },
  { route: "skills", icon: Sparkles, labelKey: "nav.skills" },
  { route: "customInstructions", icon: FileCode2, labelKey: "nav.customInstructions" },
  { route: "sessions", icon: MessagesSquare, labelKey: "nav.sessions" },
  { route: "maintenance", icon: Wrench, labelKey: "nav.maintenance" },
  { route: "settings", icon: Settings, labelKey: "nav.settings" },
  { route: "apiKeys", icon: Key, labelKey: "nav.apiKeys", bottom: true },
  { route: "usageLogs", icon: ScrollText, labelKey: "nav.usageLogs", bottom: true },
  { route: "wallet", icon: Wallet, labelKey: "nav.wallet", bottom: true },
  { route: "profile", icon: CircleUserRound, labelKey: "nav.profile", bottom: true },
];

const hiddenNavRoutes = new Set<Route>([]);

export const SIDEBAR_EXPANDED_WIDTH_PX = 176 * 1.05;
export const SIDEBAR_COLLAPSED_WIDTH_PX = 64;

const SIDEBAR_LOGO_SRC = "/app-icon.png";
const SIDEBAR_LOGO_TOP_OFFSET_PX = -21;

const navButtonClassName =
  "group-data-[state=expanded]:!rounded-[8px] group-data-[state=expanded]:!px-3 group-data-[state=expanded]:!py-2 group-data-[state=expanded]:gap-2.5";

const footerNavButtonClassName = cn(
  navButtonClassName,
  "!h-7 min-h-0 shrink-0 group-data-[state=expanded]:!py-1.5",
);

const iconInactiveClass =
  "size-4 shrink-0 text-sidebar-foreground/80 group-hover/menu-item:text-sidebar-accent-foreground";

interface AppSidebarProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onThemeChange: (theme: Theme) => void;
}

function ThemeGlyph({ resolved }: { resolved: "light" | "dark" }) {
  if (resolved === "dark") {
    return <Moon className={iconInactiveClass} strokeWidth={1.75} />;
  }
  return <Sun className={iconInactiveClass} strokeWidth={1.75} />;
}

function SidebarThemeToggle({
  resolvedTheme,
  onThemeChange,
  lightLabel,
  darkLabel,
  tooltipLabel,
}: {
  resolvedTheme: "light" | "dark";
  onThemeChange: (theme: Theme) => void;
  lightLabel: string;
  darkLabel: string;
  tooltipLabel: string;
}) {
  const tabs: { value: "light" | "dark"; label: string; icon: typeof Sun }[] = [
    { value: "light", label: lightLabel, icon: Sun },
    { value: "dark", label: darkLabel, icon: Moon },
  ];

  return (
    <SidebarMenuItem className="px-2 group-data-[collapsible=icon]/sidebar:px-0">
      <div className="group-data-[collapsible=icon]/sidebar:hidden">
        <div className="rounded-[8px] border border-sidebar-border/80 bg-sidebar-accent/45 p-1 shadow-[0_10px_22px_rgba(15,23,42,0.06)] dark:bg-white/[0.04] dark:shadow-none">
          <AnimatedSegmentedControl
            items={tabs}
            value={resolvedTheme}
            onValueChange={(nextTheme) => onThemeChange(nextTheme as "light" | "dark")}
            equalWidth
            className="gap-1"
            indicatorClassName="rounded-[8px] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.08)] dark:bg-white/[0.10]"
            itemClassName="h-8 gap-1.5 whitespace-nowrap rounded-[8px] px-2.5 text-[13px] font-medium [&_svg]:size-4"
            activeItemClassName="text-foreground dark:text-white"
            inactiveItemClassName="text-sidebar-foreground/72 hover:text-sidebar-foreground dark:text-sidebar-foreground/72 dark:hover:text-sidebar-foreground"
          />
        </div>
      </div>

      <SidebarMenuButton
        tooltip={tooltipLabel}
        className={cn(footerNavButtonClassName, "hidden group-data-[collapsible=icon]/sidebar:flex")}
        onClick={() => onThemeChange(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <ThemeGlyph resolved={resolvedTheme} />
        <span>{tooltipLabel}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** 底部账号状态按钮：未登录显示「登录站点」（跳登录令牌页），已登录显示「退出登录」 */
function SidebarAuthButton({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const connectionQuery = useQuery({
    queryKey: ["site-connection"],
    queryFn: () => api.newapiSiteConnectionStatus(),
    staleTime: 30_000,
  });
  const connected = connectionQuery.data?.data.connected ?? false;
  const storedBaseUrl = connectionQuery.data?.data.baseUrl ?? "";

  const logoutMutation = useMutation({
    mutationFn: () => api.newapiClearSiteConnection(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["site-connection"] });
      void queryClient.invalidateQueries({ queryKey: ["site-usage"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      void queryClient.invalidateQueries({ queryKey: ["user-profile"] });
      toast({ title: t("nav.logoutSuccess"), variant: "success" });
    },
    onError: (error) =>
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
  });

  return (
    <SidebarMenuItem>
      {connected ? (
        <SidebarMenuButton
          tooltip={t("nav.logout")}
          className={cn(
            navButtonClassName,
            "text-destructive hover:text-destructive active:text-destructive",
          )}
          onClick={() => setConfirmOpen(true)}
        >
          <LogOut strokeWidth={1.75} className="size-4 shrink-0 text-destructive" />
          <span className="truncate">{t("nav.logout")}</span>
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton
          tooltip={t("nav.loginSite")}
          className={navButtonClassName}
          onClick={() => onNavigate("siteLogin")}
        >
          <LogIn
            strokeWidth={1.75}
            className="size-4 shrink-0 text-sidebar-foreground/80 group-hover/menu-item:text-sidebar-accent-foreground"
          />
          <span className="truncate">{t("nav.loginSite")}</span>
        </SidebarMenuButton>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("nav.logoutConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("nav.logoutConfirmDesc", { url: storedBaseUrl })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                logoutMutation.mutate();
              }}
            >
              {t("nav.logout")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenuItem>
  );
}

export function AppSidebar({
  activeRoute,
  onNavigate,
  onThemeChange,
}: AppSidebarProps) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeValue();

  const themeLabel =
    resolvedTheme === "dark" ? t("nav.sidebarDarkTheme") : t("nav.sidebarLightTheme");

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="!p-0">
        <div className="h-12 shrink-0" data-tauri-drag-region />
        <button
          type="button"
          onClick={() => void api.openPath(SITE_DIRECT_ORIGINS.domain)}
          title={SITE_DIRECT_ORIGINS.domain}
          className="hidden w-full cursor-pointer justify-center group-data-[collapsible=icon]/sidebar:flex"
          style={{ marginTop: SIDEBAR_LOGO_TOP_OFFSET_PX }}
        >
          <img
            src={SIDEBAR_LOGO_SRC}
            alt="ZMate"
            className="h-[35px] w-[35px] select-none rounded-full object-cover md:translate-x-1"
            draggable={false}
          />
        </button>
        <button
          type="button"
          onClick={() => void api.openPath(SITE_DIRECT_ORIGINS.domain)}
          title={SITE_DIRECT_ORIGINS.domain}
          className="group/header flex w-full cursor-pointer items-center gap-3 rounded-[10px] pl-2.5 pr-3 py-1 text-left transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]/sidebar:hidden"
          style={{ marginTop: SIDEBAR_LOGO_TOP_OFFSET_PX }}
        >
          <div className="relative h-[35px] w-[35px] shrink-0">
            <img
              src={SIDEBAR_LOGO_SRC}
              alt="ZMate"
              className="h-full w-full select-none rounded-full object-cover"
              draggable={false}
            />
            <span
              aria-hidden
              className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-sidebar"
            />
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[15px] font-semibold text-sidebar-foreground">
              ZMate
            </span>
            <span className="truncate text-[11px] text-sidebar-foreground/60">
              ZCode Companion
            </span>
          </div>
        </button>
      </SidebarHeader>
      <SidebarContent className="pt-[18px]">
        <SidebarMenu>
          {appNavItems
            .filter((item) => !item.bottom && !hiddenNavRoutes.has(item.route))
            .map(({ route, icon: Icon, labelKey }) => {
              const isActive = activeRoute === route;
              return (
                <SidebarMenuItem key={route}>
                  <SidebarMenuButton
                    isActive={isActive}
                    tooltip={t(labelKey)}
                    className={navButtonClassName}
                    onClick={() => onNavigate(route)}
                  >
                    <Icon
                      strokeWidth={1.75}
                      className={cn(
                        "size-4 shrink-0",
                        isActive
                          ? "text-primary"
                          : "text-sidebar-foreground/80 group-hover/menu-item:text-sidebar-accent-foreground",
                      )}
                    />
                    <span className="truncate">{t(labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
        </SidebarMenu>

        {/* 底部独立槽位：API 密钥 / 钱包 / 个人中心 / 登录·退出登录 */}
        <SidebarMenu className="mt-auto pb-2">
          {appNavItems
            .filter((item) => item.bottom && !hiddenNavRoutes.has(item.route))
            .map(({ route, icon: Icon, labelKey }) => {
              const isActive = activeRoute === route;
              return (
                <SidebarMenuItem key={route}>
                  <SidebarMenuButton
                    isActive={isActive}
                    tooltip={t(labelKey)}
                    className={navButtonClassName}
                    onClick={() => onNavigate(route)}
                  >
                    <Icon
                      strokeWidth={1.75}
                      className={cn(
                        "size-4 shrink-0",
                        isActive
                          ? "text-primary"
                          : "text-sidebar-foreground/80 group-hover/menu-item:text-sidebar-accent-foreground",
                      )}
                    />
                    <span className="truncate">{t(labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          <SidebarAuthButton onNavigate={onNavigate} />
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-0 pt-2 pb-2">
        <SidebarMenu className="!gap-0">
          <SidebarThemeToggle
            resolvedTheme={resolvedTheme}
            onThemeChange={onThemeChange}
            lightLabel={t("settings.light")}
            darkLabel={t("settings.dark")}
            tooltipLabel={themeLabel}
          />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
