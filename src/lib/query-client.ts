import { QueryCache, QueryClient } from "@tanstack/react-query";
import { api, isSiteTokenInvalidError } from "@/lib/api";
import i18n from "@/lib/i18n";
import { toast } from "@/hooks/use-toast";
import type { CoreEnvelope, SiteConnectionStatusPayload } from "@/types";

/** 只会走存储连接的站点查询：这些查询报「令牌无效」时可以断定存储连接已失效。
 *  site-groups / site-keys 不在内——向导对话框可能携带用户临时填写的显式凭据，
 *  显式凭据失效不代表已存储的连接失效。 */
const STORED_CONNECTION_QUERY_ROOTS = new Set([
  "site-usage",
  "wallet",
  "api-keys",
  "user-profile",
  "site-logs",
  "affiliate",
  "invited-users",
]);

/** 同一拨并发失败只处理一次：进入即记时间戳，5 秒内的后续失败全部忽略
 *  （清除完成后 site-connection 刷新落地前，缓存里可能仍是旧的已连接状态） */
let lastHandledAt = 0;

/** 存储的站点令牌被站点拒绝：自动退出（清连接），让侧边栏回落「登录站点」并提示重连 */
async function handleInvalidSiteConnection(client: QueryClient) {
  const now = Date.now();
  if (now - lastHandledAt < 5_000) return;
  lastHandledAt = now;
  const connection = client.getQueryData<CoreEnvelope<SiteConnectionStatusPayload>>([
    "site-connection",
  ]);
  if (connection && !connection.data.connected) return;
  try {
    await api.newapiClearSiteConnection();
  } catch {
    // 清理失败也照样把界面切回未登录态，避免用户对着红色报错找不到出路
  }
  for (const key of [
    "site-connection",
    "site-usage",
    "wallet",
    "api-keys",
    "user-profile",
    "site-logs",
    "affiliate",
    "invited-users",
  ]) {
    void client.invalidateQueries({ queryKey: [key] });
  }
  toast({
    title: i18n.t("nav.siteTokenInvalidTitle"),
    description: i18n.t("nav.siteTokenInvalidDesc"),
    variant: "destructive",
  });
}

export function createAppQueryClient() {
  // onError 触发时 client 早已创建完毕，用闭包把实例递给回调
  let client: QueryClient;
  const queryCache = new QueryCache({
    onError: (error, query) => {
      if (!isSiteTokenInvalidError(error)) return;
      const root = query.queryKey[0];
      if (typeof root !== "string" || !STORED_CONNECTION_QUERY_ROOTS.has(root)) return;
      void handleInvalidSiteConnection(client);
    },
  });
  client = new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
    },
  });
  return client;
}
