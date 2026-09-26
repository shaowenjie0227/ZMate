import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Copy, Import, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { api } from "@/lib/api";
import { useBusyAction } from "@/hooks/use-busy-action";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { NewApiTokenInfo } from "@/types";

function money(quota: number, quotaPerUnit: number): string {
  const unit = quotaPerUnit > 0 ? quotaPerUnit : 500_000;
  return `$${(quota / unit).toFixed(2)}`;
}

export function ApiKeysPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const refreshAction = useBusyAction({ minVisibleMs: 500 });
  const [removeTarget, setRemoveTarget] = useState<NewApiTokenInfo | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [keyName, setKeyName] = useState("");

  const keysQuery = useQuery({
    queryKey: ["site-keys"],
    queryFn: () => api.newapiKeys(),
    staleTime: 30_000,
  });
  const connected = keysQuery.data?.data.connected ?? false;
  const tokens = keysQuery.data?.data.items ?? [];

  // 复用钱包查询里的站点单价，换算额度金额
  const unit = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.newapiWallet(),
    staleTime: 60_000,
  }).data?.data.stats?.quotaPerUnit ?? 500_000;

  // 导入 ZCode 需要站点地址（拼接供应商 baseUrl）
  const siteConnQuery = useQuery({
    queryKey: ["site-connection"],
    queryFn: () => api.newapiSiteConnectionStatus(),
    staleTime: 30_000,
  });

  // 创建密钥：分组列表（弹窗打开时拉取）+ 主机名生成默认密钥名（与接入向导一致）
  const { data: systemInfo } = useQuery({
    queryKey: ["system-info"],
    queryFn: () => api.getSystemInfo(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const groupsQuery = useQuery({
    queryKey: ["site-groups"],
    queryFn: () => api.newapiListGroups(null, null),
    enabled: createOpen,
  });

  useEffect(() => {
    if (createOpen && systemInfo?.hostname && !keyName) {
      const host = systemInfo.hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24);
      setKeyName(`zmate-${host || "device"}`);
    }
  }, [createOpen, systemInfo, keyName]);

  useEffect(() => {
    if (createOpen && !groupName) {
      const groups = groupsQuery.data?.data;
      if (groups?.length) setGroupName(groups[0]?.name ?? "");
    }
  }, [createOpen, groupsQuery.data, groupName]);

  const refresh = async () => {
    await refreshAction.run(async () => {
      await keysQuery.refetch();
    });
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["site-keys"] });
  };

  const copyKey = async (token: NewApiTokenInfo) => {
    const full = token.key.startsWith("sk-") ? token.key : `sk-${token.key}`;
    await navigator.clipboard.writeText(full);
    toast({ title: t("apiKeys.copied"), variant: "success" });
  };

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: number }) =>
      api.newapiSetTokenStatus(id, status),
    onSuccess: () => {
      invalidate();
      toast({ title: t("apiKeys.statusUpdated"), variant: "success" });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => api.newapiDeleteToken(id),
    onSuccess: () => {
      setRemoveTarget(null);
      invalidate();
      toast({ title: t("apiKeys.removeSuccess"), variant: "success" });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  /** 一键导入 ZCode：与接入向导完成页默认一致——openai-responses + 站点地址 /v1，站点模型全选 */
  const importMutation = useMutation({
    mutationFn: async (token: NewApiTokenInfo) => {
      const base = (siteConnQuery.data?.data.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!base) throw new Error(t("apiKeys.importNoSiteBase"));
      const modelsRes = await api.newapiListModels(null, null);
      if (modelsRes.data.length === 0) throw new Error(t("apiKeys.importNoModels"));
      const full = token.key.startsWith("sk-") ? token.key : `sk-${token.key}`;
      const res = await api.upsertProvider({
        providerId: null,
        providerName: token.name.trim() || "NewAPI",
        apiType: "openai-responses",
        baseUrl: `${base}/v1`,
        apiKey: full,
        models: modelsRes.data.map((id) => ({
          modelId: id,
          contextWindow: null,
          supportsImage: null,
          reasoningLevels: ["low", "medium", "high"],
          reasoningMap: null,
        })),
      });
      return res.data;
    },
    onSuccess: (payload) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast({
        title: t("apiKeys.importSuccess"),
        description: t("apiKeys.importSuccessDesc", {
          name: payload.provider.providerId,
          count: payload.provider.modelCount,
        }),
        variant: "success",
      });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  /** 在站点侧创建密钥：不限额度 · 永不过期（与接入向导「我还没有创建 key」一致），成功后刷新列表 */
  const createMutation = useMutation({
    mutationFn: () =>
      api.newapiCreateToken(null, null, {
        name: keyName.trim(),
        group: groupName || null,
        unlimitedQuota: true,
        remainQuota: null,
        expiredTime: null,
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setKeyName("");
      setGroupName("");
      invalidate();
      toast({ title: t("apiKeys.createSuccess", { name: keyName.trim() }), variant: "success" });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("apiKeys.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("apiKeys.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("apiKeys.createButton")}
          </Button>
          <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshAction.busy}>
            {refreshAction.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      {keysQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : !connected ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="font-medium">{t("apiKeys.notConnected")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("apiKeys.notConnectedDesc")}</p>
        </div>
      ) : tokens.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="font-medium">{t("apiKeys.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("apiKeys.emptyDesc")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              quotaPerUnit={unit}
              busy={statusMutation.isPending || removeMutation.isPending}
              importing={importMutation.isPending && importMutation.variables?.id === token.id}
              onCopy={() => void copyKey(token)}
              onToggle={(enabled) =>
                statusMutation.mutate({ id: token.id, status: enabled ? 1 : 2 })
              }
              onRemove={() => setRemoveTarget(token)}
              onImport={() => importMutation.mutate(token)}
            />
          ))}
        </div>
      )}

      {/* 创建 API 密钥：选分组（含倍率）+ 名称，站点侧直接创建（不限额度 · 永不过期） */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("apiKeys.createTitle")}</DialogTitle>
            <DialogDescription>{t("apiKeys.createDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("apiKeys.createGroupLabel")}</Label>
              {groupsQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-11 rounded-xl" />
                  <Skeleton className="h-11 rounded-xl" />
                </div>
              ) : groupsQuery.isError ? (
                <div className="rounded-xl border border-dashed border-destructive/40 p-4 text-center">
                  <p className="break-all text-xs text-destructive">
                    {groupsQuery.error instanceof Error
                      ? groupsQuery.error.message
                      : t("apiKeys.createNoGroups")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => groupsQuery.refetch()}
                  >
                    {t("apiKeys.createRetry")}
                  </Button>
                </div>
              ) : (groupsQuery.data?.data.length ?? 0) === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  {t("apiKeys.createNoGroups")}
                </p>
              ) : (
                <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                  {(groupsQuery.data?.data ?? []).map((group) => {
                    const selected = groupName === group.name;
                    return (
                      <button
                        key={group.name}
                        type="button"
                        onClick={() => setGroupName(group.name)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors",
                          selected ? "border-primary bg-primary/8" : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className="text-sm font-medium">{group.name}</span>
                        <Badge variant="outline" className="font-mono">
                          ×{group.ratio.toFixed(2)}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("apiKeys.createGroupHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("apiKeys.createKeyNameLabel")}</Label>
              <Input
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.createKeyNameHint")}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={createMutation.isPending || !groupName || !keyName.trim()}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending && <Loader2 className="animate-spin" />}
              {createMutation.isPending ? t("apiKeys.creating") : t("apiKeys.createSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("apiKeys.confirmRemoveTitle", { name: removeTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("apiKeys.confirmRemoveDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeMutation.isPending}
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.id)}
            >
              {removeMutation.isPending ? <Loader2 className="animate-spin" /> : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TokenRow({
  token,
  quotaPerUnit,
  busy,
  importing,
  onCopy,
  onToggle,
  onRemove,
  onImport,
}: {
  token: NewApiTokenInfo;
  quotaPerUnit: number;
  busy: boolean;
  importing: boolean;
  onCopy: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  const enabled = token.status === 1;
  const expired = token.expiredTime > 0 && token.expiredTime * 1000 < Date.now();

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{token.name}</span>
            <TokenStatusBadge token={token} />
            {token.group && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {token.group}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {token.key ? `sk-${token.key.slice(0, 4)}…${token.key.slice(-4)}` : "—"}
          </p>
        </div>

        <div className="text-right text-xs text-muted-foreground">
          <p>
            {token.unlimitedQuota
              ? t("apiKeys.quotaUnlimited")
              : t("apiKeys.quotaRemain", {
                  amount: money(token.remainQuota, quotaPerUnit),
                })}
            {" · "}
            {t("apiKeys.quotaUsed", { amount: money(token.usedQuota, quotaPerUnit) })}
          </p>
          <p className="mt-0.5">
            {token.expiredTime <= 0
              ? t("apiKeys.neverExpires")
              : t("apiKeys.expiresAt", {
                  date: new Date(token.expiredTime * 1000).toLocaleDateString(),
                })}
            {" · "}
            {t("apiKeys.created", {
              date: new Date(token.createdTime * 1000).toLocaleDateString(),
            })}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!token.key}
            title={t("apiKeys.copyKey")}
            onClick={onCopy}
          >
            <Copy />
          </Button>
          <Switch
            checked={enabled && !expired}
            disabled={busy || expired}
            onCheckedChange={onToggle}
          />
          <Button variant="ghost" size="icon-sm" disabled={busy} onClick={onRemove}>
            <Trash2 className="text-destructive" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy || importing || !token.key || !enabled || expired}
            title={t("apiKeys.importZcode")}
            onClick={onImport}
          >
            {importing ? <Loader2 className="animate-spin" /> : <Import />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TokenStatusBadge({ token }: { token: NewApiTokenInfo }) {
  const { t } = useTranslation();
  if (token.status === 1) {
    return (
      <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
        {t("apiKeys.statusEnabled")}
      </Badge>
    );
  }
  const keyByStatus: Record<number, string> = {
    2: "apiKeys.statusDisabled",
    3: "apiKeys.statusExpired",
    4: "apiKeys.statusExhausted",
  };
  return (
    <Badge variant="outline" className={cn("text-muted-foreground")}>
      {t(keyByStatus[token.status] ?? "apiKeys.statusUnknown")}
    </Badge>
  );
}
