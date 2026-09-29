import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";

import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { NewApiSiteInfo } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedOptions } from "@/components/ui/segmented-options";

/** 面板绑定的中转站预设（登录令牌页与站点接入向导保持一致） */
export const AISPOT_BASE = "https://aispot.swj0227.icu";

type SiteLoginMethod = "token" | "password";

/**
 * 站点登录表单（访问令牌 / 账号密码双方式）：成功即落盘站点连接并刷新站点相关查询。
 * 登录令牌页与站点接入向导的登录浮窗共用。
 */
export function SiteLoginForm({
  defaultSiteBase = AISPOT_BASE,
  onSuccess,
  externalError = null,
}: {
  defaultSiteBase?: string;
  onSuccess: (info: NewApiSiteInfo, base: string) => void;
  /** 外部传入的错误（如向导里存储连接失效），与本表单自身错误同位显示 */
  externalError?: string | null;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [siteBase, setSiteBase] = useState(defaultSiteBase || AISPOT_BASE);
  const [loginMethod, setLoginMethod] = useState<SiteLoginMethod>("password");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connectMutation = useMutation({
    mutationFn: async () => {
      const base = siteBase.trim().replace(/\/+$/, "");
      if (loginMethod === "password") {
        // 账号密码登录：后端用站点会话换取系统访问令牌并直接落盘，令牌不回传
        const res = await api.newapiLoginWithPassword(base, username.trim(), password);
        return { base, info: res.data };
      }
      const trimmedUserId = userId.trim();
      if (trimmedUserId && (!/^\d+$/.test(trimmedUserId) || Number(trimmedUserId) <= 0)) {
        throw new Error(t("siteLogin.userIdInvalid"));
      }
      const probeRes = await api.newapiProbeSite(
        base,
        accessToken.trim(),
        trimmedUserId ? Number(trimmedUserId) : null,
      );
      // probe 返回站点已确认的用户 ID（新版 new-api 的 New-Api-User 头必需）
      await api.newapiSaveSiteConnection(base, accessToken.trim(), probeRes.data.userId);
      return { base, info: probeRes.data };
    },
    onSuccess: ({ base, info }) => {
      setAccessToken("");
      setShowToken(false);
      setUserId("");
      setUsername("");
      setPassword("");
      setShowPassword(false);
      setConnectError(null);
      for (const key of ["site-connection", "site-usage", "wallet", "api-keys", "user-profile"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast({
        title: t("siteLogin.connectSuccess", { name: info.systemName || "NewAPI" }),
        variant: "success",
      });
      onSuccess(info, base);
    },
    onError: (error) => {
      setConnectError(error instanceof Error ? error.message : String(error));
    },
  });

  const busy = connectMutation.isPending;
  const shownError = connectError ?? externalError;

  return (
    <div className="space-y-4">
      <SegmentedOptions
        items={[
          { value: "password", label: t("siteLogin.methodPassword") },
          { value: "token", label: t("siteLogin.methodToken") },
        ]}
        value={loginMethod}
        onChange={(value) => {
          setLoginMethod(value as SiteLoginMethod);
          setConnectError(null);
        }}
      />
      <div className="space-y-1.5">
        <Label>{t("siteLogin.siteUrlLabel")}</Label>
        <Input
          value={siteBase}
          onChange={(e) => setSiteBase(e.target.value)}
          className="font-mono"
          placeholder="https://your-site.example.com"
        />
        {siteBase.trim().startsWith("http://") && !siteBase.includes("localhost") && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("siteLogin.httpWarning")}</p>
        )}
      </div>
      {loginMethod === "token" ? (
        <>
          <div className="space-y-1.5">
            <Label>{t("siteLogin.tokenLabel")}</Label>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="pr-10 font-mono"
                placeholder={t("siteLogin.tokenPlaceholder")}
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{t("siteLogin.tokenHelp")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-user-id">{t("siteLogin.userIdLabel")}</Label>
            <Input
              id="site-user-id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              inputMode="numeric"
              className="font-mono"
              placeholder={t("siteLogin.userIdPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("siteLogin.userIdHelp")}</p>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="site-login-username">{t("siteLogin.usernameLabel")}</Label>
            <Input
              id="site-login-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              placeholder={t("siteLogin.usernamePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-login-password">{t("siteLogin.passwordLabel")}</Label>
            <div className="relative">
              <Input
                id="site-login-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
                autoComplete="off"
                placeholder={t("siteLogin.passwordPlaceholder")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{t("siteLogin.passwordHelp")}</p>
          </div>
        </>
      )}
      {shownError && <p className="break-all text-xs text-destructive">{shownError}</p>}
      <div className="flex justify-end">
        <Button
          disabled={
            busy ||
            !siteBase.trim() ||
            (loginMethod === "token" ? !accessToken.trim() : !username.trim() || !password)
          }
          onClick={() => connectMutation.mutate()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
          {busy
            ? loginMethod === "password"
              ? t("siteLogin.loggingIn")
              : t("siteLogin.connecting")
            : loginMethod === "password"
              ? t("siteLogin.passwordConnect")
              : t("siteLogin.connect")}
        </Button>
      </div>
    </div>
  );
}
