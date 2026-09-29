import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  CircleUserRound,
  Key,
  LogIn,
  Loader2,
  RefreshCw,
  ScrollText,
  Wallet,
} from "lucide-react";

import { api } from "@/lib/api";
import type { Route } from "@/types/navigation";
import { Badge } from "@/components/ui/badge";
import { BentoCard } from "@/components/ui/bento-card";
import { Button } from "@/components/ui/button";

function money(quota: number, quotaPerUnit: number): string {
  const unit = quotaPerUnit > 0 ? quotaPerUnit : 500_000;
  return `$${(quota / unit).toFixed(2)}`;
}

export function ProfilePage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const connectionQuery = useQuery({
    queryKey: ["site-connection"],
    queryFn: () => api.newapiSiteConnectionStatus(),
  });
  const connected = connectionQuery.data?.data.connected ?? false;

  const profileQuery = useQuery({
    queryKey: ["user-profile"],
    queryFn: () => api.newapiUserProfile(),
    enabled: connected,
    staleTime: 60_000,
    retry: false,
  });
  const profile = profileQuery.data?.data ?? null;

  const refresh = useMutation({
    mutationFn: () => api.newapiUserProfile(),
    onSuccess: (response) => {
      queryClient.setQueryData(["user-profile"], response);
    },
  });

  if (!connected) {
    return (
      <div className="space-y-5 overflow-y-auto p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("profile.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("profile.description")}</p>
        </div>
        <BentoCard className="flex flex-col items-center gap-3 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <CircleUserRound className="size-6" />
          </span>
          <p className="text-sm text-muted-foreground">{t("profile.notConnectedHint")}</p>
          <Button size="sm" onClick={() => onNavigate("siteLogin")}>
            <LogIn />
            {t("profile.goConnect")}
          </Button>
        </BentoCard>
      </div>
    );
  }

  const busy = refresh.isPending || (profileQuery.isLoading && !profile);

  return (
    <div className="space-y-5 overflow-y-auto p-6">
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("profile.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("profile.description")}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => refresh.mutate()}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {/* 用户信息卡 */}
      <BentoCard className="p-5">
        <div className="flex items-center gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl font-semibold text-primary">
            {(profile?.username || profile?.displayName || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold">
                {profile?.displayName || profile?.username || "—"}
              </h3>
              {profile && profile.displayName && profile.username && (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  @{profile.username}
                </span>
              )}
              {profile?.group ? (
                <Badge variant="secondary">{profile.group}</Badge>
              ) : null}
              {profile && profile.role >= 10 ? (
                <Badge
                  variant="secondary"
                  className="bg-amber-500/12 text-amber-700 dark:text-amber-400"
                >
                  {profile.role >= 100
                    ? t("profile.roleRoot")
                    : t("profile.roleAdmin")}
                </Badge>
              ) : null}
            </div>
            {profile?.email ? (
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {profile.email}
              </p>
            ) : null}
            {profile && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {connectionQuery.data?.data.authMethod === "password"
                  ? t("profile.siteSourcePassword", {
                      name: profile.systemName || "NewAPI",
                    })
                  : t("profile.siteSource", {
                      name: profile.systemName || "NewAPI",
                    })}
              </p>
            )}
          </div>
        </div>
        {profileQuery.isError && (
          <p className="mt-3 break-all text-xs text-destructive">
            {profileQuery.error instanceof Error
              ? profileQuery.error.message
              : String(profileQuery.error)}
          </p>
        )}
      </BentoCard>

      {/* 额度统计 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <BentoCard className="p-5">
          <p className="text-xs text-muted-foreground">{t("profile.balance")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {profile ? money(profile.quota, profile.quotaPerUnit) : "—"}
          </p>
        </BentoCard>
        <BentoCard className="p-5">
          <p className="text-xs text-muted-foreground">{t("profile.used")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {profile ? money(profile.usedQuota, profile.quotaPerUnit) : "—"}
          </p>
        </BentoCard>
        <BentoCard className="p-5">
          <p className="text-xs text-muted-foreground">{t("profile.requests")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {profile ? profile.requestCount.toLocaleString() : "—"}
          </p>
        </BentoCard>
      </div>

      {/* 快捷入口 */}
      <BentoCard className="p-5">
        <h3 className="text-[15px] font-medium">{t("profile.quickLinks")}</h3>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <QuickLink
            icon={<Wallet className="size-4 text-primary" />}
            label={t("profile.quickWallet")}
            desc={t("profile.quickWalletDesc")}
            onClick={() => onNavigate("wallet")}
          />
          <QuickLink
            icon={<Key className="size-4 text-sky-500" />}
            label={t("profile.quickApiKeys")}
            desc={t("profile.quickApiKeysDesc")}
            onClick={() => onNavigate("apiKeys")}
          />
          <QuickLink
            icon={<ScrollText className="size-4 text-emerald-500" />}
            label={t("profile.quickUsageLogs")}
            desc={t("profile.quickUsageLogsDesc")}
            onClick={() => onNavigate("usageLogs")}
          />
          <QuickLink
            icon={<LogIn className="size-4 text-amber-500" />}
            label={t("profile.quickSiteLogin")}
            desc={t("profile.quickSiteLoginDesc")}
            onClick={() => onNavigate("siteLogin")}
          />
        </div>
      </BentoCard>
    </div>
  );
}

function QuickLink({
  icon,
  label,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}
