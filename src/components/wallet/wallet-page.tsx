import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, RefreshCw, Ticket } from "lucide-react";

import { api } from "@/lib/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useToast } from "@/hooks/use-toast";
import { BentoCard } from "@/components/ui/bento-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 发卡网站（购买兑换码） */
const CARD_SHOP_URL = "https://catfk.com/shop/F641K27H";

function money(quota: number, quotaPerUnit: number): string {
  const unit = quotaPerUnit > 0 ? quotaPerUnit : 500_000;
  return `$${(quota / unit).toFixed(2)}`;
}

export function WalletPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const refreshAction = useBusyAction({ minVisibleMs: 500 });
  const [code, setCode] = useState("");

  const walletQuery = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.newapiWallet(),
    staleTime: 60_000,
  });
  const stats = walletQuery.data?.data.stats ?? null;
  const connected = walletQuery.data?.data.connected ?? false;

  const refresh = async () => {
    await refreshAction.run(async () => {
      await walletQuery.refetch();
    });
  };

  const redeemMutation = useMutation({
    mutationFn: () => api.newapiRedeem(code.trim()),
    onSuccess: (response) => {
      const result = response.data;
      toast({
        title: t("wallet.redeemSuccess", {
          amount: money(result.grantedQuota, result.quotaPerUnit),
          balance: money(result.balanceQuota, result.quotaPerUnit),
        }),
        variant: "success",
      });
      setCode("");
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["site-usage"] });
    },
    onError: (error) => {
      toast({
        title: t("wallet.redeemFailed"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const openShop = async () => {
    await api.openPath(CARD_SHOP_URL);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("wallet.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("wallet.description")}</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshAction.busy}>
          {refreshAction.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {walletQuery.isLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : !connected || !stats ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="font-medium">{t("wallet.notConnected")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("wallet.notConnectedDesc")}</p>
        </div>
      ) : (
        <>
          {/* 余额 / 总用量 / 请求数 */}
          <div className="grid grid-cols-3 gap-4">
            <WalletCard
              accent="bg-sky-500"
              label={t("wallet.balance")}
              value={money(stats.balanceQuota, stats.quotaPerUnit)}
              sub={t("wallet.accountSub", {
                username: stats.username || "-",
                name: stats.systemName,
              })}
            />
            <WalletCard
              accent="bg-amber-500"
              label={t("wallet.usedTotal")}
              value={money(stats.usedQuota, stats.quotaPerUnit)}
              sub={t("wallet.usedTotalSub")}
            />
            <WalletCard
              accent="bg-emerald-500"
              label={t("wallet.requestCount")}
              value={stats.requestCount.toLocaleString()}
              sub={t("wallet.requestCountSub")}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 兑换码 */}
            <BentoCard className="p-5">
              <div className="flex items-center gap-2">
                <Ticket className="size-4 text-violet-500" />
                <h3 className="font-semibold">{t("wallet.redeemTitle")}</h3>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t("wallet.redeemDesc")}</p>
              <div className="mt-4 flex gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && code.trim() && !redeemMutation.isPending) {
                      redeemMutation.mutate();
                    }
                  }}
                  placeholder={t("wallet.redeemPlaceholder")}
                  className="font-mono"
                />
                <Button
                  disabled={!code.trim() || redeemMutation.isPending}
                  onClick={() => redeemMutation.mutate()}
                >
                  {redeemMutation.isPending && <Loader2 className="animate-spin" />}
                  {redeemMutation.isPending ? t("wallet.redeeming") : t("wallet.redeemAction")}
                </Button>
              </div>
            </BentoCard>

            {/* 购买兑换码 */}
            <BentoCard className="p-5">
              <div className="flex items-center gap-2">
                <ExternalLink className="size-4 text-sky-500" />
                <h3 className="font-semibold">{t("wallet.shopTitle")}</h3>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t("wallet.shopDesc")}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => void openShop()}>
                <ExternalLink />
                {t("wallet.shopAction")}
              </Button>
              <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                {CARD_SHOP_URL}
              </p>
            </BentoCard>
          </div>
        </>
      )}
    </div>
  );
}

function WalletCard({
  accent,
  label,
  value,
  sub,
}: {
  accent: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5">
      <span className={cn("absolute inset-x-0 top-0 h-[3px]", accent)} />
      <p className="text-[13px] font-medium tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums leading-none">{value}</p>
      <p className="mt-2 truncate text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
