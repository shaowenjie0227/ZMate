import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";

import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { NewApiSiteInfo } from "@/types";
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
import { Button } from "@/components/ui/button";
import { SiteLoginForm } from "@/components/site-login/site-login-form";
import { cn } from "@/lib/utils";

export function SiteLoginPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [connectedInfo, setConnectedInfo] = useState<NewApiSiteInfo | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const connectionQuery = useQuery({
    queryKey: ["site-connection"],
    queryFn: () => api.newapiSiteConnectionStatus(),
  });
  const connected = connectionQuery.data?.data.connected ?? false;
  const storedBaseUrl = connectionQuery.data?.data.baseUrl ?? "";
  const authMethod = connectionQuery.data?.data.authMethod ?? "";

  const refreshConnectedData = () => {
    void queryClient.invalidateQueries({ queryKey: ["site-connection"] });
    void queryClient.invalidateQueries({ queryKey: ["site-usage"] });
    void queryClient.invalidateQueries({ queryKey: ["wallet"] });
    void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    void queryClient.invalidateQueries({ queryKey: ["user-profile"] });
  };

  const verifyMutation = useMutation({
    mutationFn: () => api.newapiVerifySiteConnection(),
    onSuccess: (response) => {
      const result = response.data;
      if (result.ok) {
        setConnectedInfo(null);
        toast({
          title: t("siteLogin.verifyOk", { name: result.systemName, user: result.username }),
          variant: "success",
        });
      }
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.newapiClearSiteConnection(),
    onSuccess: () => {
      setConnectedInfo(null);
      setEditing(false);
      refreshConnectedData();
      toast({ title: t("siteLogin.disconnected"), variant: "success" });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const showForm = !connected || editing;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("siteLogin.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("siteLogin.description")}</p>
      </div>

      {/* 连接状态 */}
      <BentoCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-medium">{t("siteLogin.statusTitle")}</h3>
              <Badge
                variant="secondary"
                className={cn(
                  connected && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
                )}
              >
                {connected ? t("siteLogin.connected") : t("siteLogin.notConnected")}
              </Badge>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {storedBaseUrl || t("siteLogin.noSiteUrl")}
            </p>
            {connected && connectedInfo && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {connectedInfo.systemName || "NewAPI"} ·{" "}
                {connectedInfo.username || connectedInfo.displayName}
              </p>
            )}
          </div>
          {connected && (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={verifyMutation.isPending}
                onClick={() => verifyMutation.mutate()}
              >
                {verifyMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {verifyMutation.isPending ? t("siteLogin.verifying") : t("siteLogin.verify")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
                <PlugZap />
                {editing ? t("common.cancel") : t("siteLogin.replace")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDisconnectOpen(true)}
              >
                <Unplug />
                {t("siteLogin.disconnect")}
              </Button>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {connected && authMethod === "password"
                ? t("siteLogin.authMethodPassword")
                : t("siteLogin.tokenLabel")}
            </span>
            <span className={connected ? "text-foreground" : "text-muted-foreground/60"}>
              {connected
                ? authMethod === "password"
                  ? t("siteLogin.passwordSet")
                  : t("siteLogin.tokenSet")
                : t("siteLogin.tokenUnset")}
            </span>
          </div>
          {verifyMutation.data && !verifyMutation.data.data.ok && (
            <p className="break-all text-xs text-destructive">
              {t("siteLogin.verifyFailed", { message: verifyMutation.data.data.message })}
            </p>
          )}
          {!connected && (
            <p className="text-xs text-muted-foreground">{t("siteLogin.emptyHint")}</p>
          )}
        </div>
      </BentoCard>

      {/* 连接表单：未连接或点击「更换连接」时显示 */}
      {showForm && (
        <BentoCard className="p-5">
          <SiteLoginForm
            defaultSiteBase={storedBaseUrl || undefined}
            onSuccess={(info) => {
              setConnectedInfo(info);
              setEditing(false);
            }}
          />
        </BentoCard>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">{t("siteLogin.usageHint")}</p>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("siteLogin.disconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("siteLogin.disconnectDesc", { url: storedBaseUrl })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDisconnectOpen(false);
                disconnectMutation.mutate();
              }}
            >
              {t("siteLogin.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
