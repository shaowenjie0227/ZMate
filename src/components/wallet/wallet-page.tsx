import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Share2,
  Ticket,
  Users,
} from "lucide-react";

import { api } from "@/lib/api";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useToast } from "@/hooks/use-toast";
import { BentoCard } from "@/components/ui/bento-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 发卡网站（购买兑换码）：主站与备用站 */
const CARD_SHOP_URL = "https://catfk.com/shop/F641K27H";
const CARD_SHOP_BACKUP_URL = "https://wzyp.cn/shop/IHCG1NO4";

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

  const openShop = async (url: string) => {
    await api.openPath(url);
  };

  // ---- 推荐计划 / 已邀请用户 ----
  const [copiedLink, setCopiedLink] = useState(false);
  const [transferAmount, setTransferAmount] = useState("");
  const [inviteePage, setInviteePage] = useState(1);
  const INVITEE_PAGE_SIZE = 10;

  const affiliateQuery = useQuery({
    queryKey: ["affiliate"],
    queryFn: () => api.newapiAffiliateInfo(),
    staleTime: 30_000,
  });
  const affiliate = affiliateQuery.data?.data ?? null;
  const invitedQuery = useQuery({
    queryKey: ["invited-users", inviteePage],
    queryFn: () => api.newapiInvitedUsers(inviteePage, INVITEE_PAGE_SIZE),
    staleTime: 30_000,
  });
  const invited = invitedQuery.data?.data ?? null;

  const copyReferralLink = async () => {
    if (!affiliate?.referralUrl) return;
    await navigator.clipboard.writeText(affiliate.referralUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1500);
  };

  const transferMutation = useMutation({
    mutationFn: (quota: number) => api.newapiTransferAffQuota(quota),
    onSuccess: () => {
      toast({ title: t("wallet.transferSuccess"), variant: "success" });
      setTransferAmount("");
      void queryClient.invalidateQueries({ queryKey: ["affiliate"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["site-usage"] });
    },
    onError: (error) => {
      toast({
        title: t("wallet.transferFailed"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const handleTransfer = () => {
    if (!affiliate) return;
    const unit = stats && stats.quotaPerUnit > 0 ? stats.quotaPerUnit : 500_000;
    const usd = Number.parseFloat(transferAmount);
    if (!Number.isFinite(usd) || usd <= 0) {
      toast({ title: t("wallet.invalidAmount"), variant: "destructive" });
      return;
    }
    const quota = Math.round(usd * unit);
    if (quota > affiliate.pendingQuota) {
      toast({ title: t("wallet.insufficientAmount"), variant: "destructive" });
      return;
    }
    transferMutation.mutate(quota);
  };

  const refresh = async () => {
    await refreshAction.run(async () => {
      await walletQuery.refetch();
      await affiliateQuery.refetch();
      await invitedQuery.refetch();
    });
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
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void openShop(CARD_SHOP_URL)}>
                  <ExternalLink />
                  {t("wallet.shopAction")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openShop(CARD_SHOP_BACKUP_URL)}
                >
                  <ExternalLink />
                  {t("wallet.shopBackupAction")}
                </Button>
              </div>
              <button
                type="button"
                onClick={() => void openShop(CARD_SHOP_URL)}
                className="mt-2 block break-all text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
              >
                {CARD_SHOP_URL}
              </button>
              <button
                type="button"
                onClick={() => void openShop(CARD_SHOP_BACKUP_URL)}
                className="block break-all text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
              >
                {CARD_SHOP_BACKUP_URL}
              </button>
            </BentoCard>
          </div>

          {/* 推荐计划 */}
          {affiliate && (
            <BentoCard className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Share2 className="size-4 text-violet-500" />
                    <h3 className="font-semibold">{t("wallet.affiliateTitle")}</h3>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t("wallet.affiliateDesc")}
                  </p>
                </div>
                <div className="flex items-center gap-6">
                  <AffiliateStat
                    label={t("wallet.affiliatePending")}
                    value={money(affiliate.pendingQuota, stats.quotaPerUnit)}
                  />
                  <AffiliateStat
                    label={t("wallet.affiliateTotal")}
                    value={money(
                      affiliate.pendingQuota + affiliate.historyQuota,
                      stats.quotaPerUnit,
                    )}
                  />
                  <AffiliateStat
                    label={t("wallet.affiliateInvites")}
                    value={String(affiliate.inviteCount)}
                  />
                </div>
              </div>

              {affiliate.referralUrl && (
                <div className="mt-4 flex items-center gap-2">
                  <Input
                    readOnly
                    value={affiliate.referralUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void copyReferralLink()}
                  >
                    {copiedLink ? <Check /> : <Copy />}
                    {copiedLink
                      ? t("wallet.affiliateCopied")
                      : t("wallet.affiliateCopyAction")}
                  </Button>
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <Input
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={t("wallet.transferAmountPlaceholder")}
                  className="font-mono"
                  inputMode="decimal"
                />
                <Button
                  className="shrink-0"
                  disabled={
                    affiliate.pendingQuota <= 0 || transferMutation.isPending
                  }
                  onClick={handleTransfer}
                >
                  {transferMutation.isPending && <Loader2 className="animate-spin" />}
                  {transferMutation.isPending ? t("wallet.transferring") : t("wallet.transferAction")}
                </Button>
              </div>
            </BentoCard>
          )}

          {/* 已邀请用户 */}
          <BentoCard className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-sky-500" />
                <h3 className="font-semibold">{t("wallet.invitedTitle")}</h3>
              </div>
              {invited && invited.total > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("wallet.invitedTotal", { count: invited.total })}
                </span>
              )}
            </div>
            {invited && invited.items.length > 0 ? (
              <>
                <div className="mt-3 divide-y divide-border">
                  {invited.items.map((item, index) => (
                    <InvitedUserRow key={index} item={item} />
                  ))}
                </div>
                {(invited.page > 1 || invited.page * invited.pageSize < invited.total) && (
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <span className="text-xs text-muted-foreground">
                      {invited.page} / {Math.max(1, Math.ceil(invited.total / invited.pageSize))}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={invited.page <= 1}
                      onClick={() => setInviteePage((p) => Math.max(1, p - 1))}
                    >
                      {t("wallet.pagePrev")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={invited.page * invited.pageSize >= invited.total}
                      onClick={() => setInviteePage((p) => p + 1)}
                    >
                      {t("wallet.pageNext")}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-6 py-8 text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
                  <Users className="size-5 text-muted-foreground" />
                </div>
                <p className="mt-3 text-sm font-medium">{t("wallet.invitedEmpty")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("wallet.invitedEmptyDesc")}</p>
              </div>
            )}
          </BentoCard>
        </>
      )}
    </div>
  );
}

function AffiliateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

function InvitedUserRow({ item }: { item: Record<string, unknown> }) {
  const name = String(
    item.username ?? item.name ?? item.display_name ?? item.email ?? `#${String(item.id ?? "?")}`,
  );
  const ts = Number(item.created_time ?? item.created_at ?? item.register_time ?? 0);
  const joined =
    ts > 0
      ? new Date(ts * 1000).toLocaleString(undefined, { hour12: false })
      : "";
  return (
    <div className="flex items-center justify-between py-2">
      <span className="truncate text-sm">{name}</span>
      {joined && <span className="text-xs text-muted-foreground">{joined}</span>}
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
