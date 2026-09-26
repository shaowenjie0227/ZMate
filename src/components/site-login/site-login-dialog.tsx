import { useTranslation } from "react-i18next";

import type { NewApiSiteInfo } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SiteLoginForm } from "@/components/site-login/site-login-form";

/** 站点登录浮窗：站点接入向导未登录时弹出，登录绑定成功后由 onSuccess 继续接入流程 */
export function SiteLoginDialog({
  open,
  onOpenChange,
  onSuccess,
  defaultSiteBase,
  externalError = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (info: NewApiSiteInfo, base: string) => void;
  defaultSiteBase?: string;
  externalError?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("siteLogin.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("siteLogin.dialogDesc")}</DialogDescription>
        </DialogHeader>
        <SiteLoginForm
          defaultSiteBase={defaultSiteBase}
          onSuccess={onSuccess}
          externalError={externalError}
        />
      </DialogContent>
    </Dialog>
  );
}
