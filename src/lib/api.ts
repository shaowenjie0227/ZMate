import type {
  AppSettings,
  AppStatePayload,
  CleanPayload,
  CoreEnvelope,
  CustomInstructionPreviewPayload,
  CustomInstructionStatePayload,
  DashboardPayload,
  DiagnosePayload,
  McpServerListPayload,
  McpServerMutationPayload,
  McpServerRemovePayload,
  McpTransport,
  KeysPayload,
  NewApiAffiliateInfo,
  NewApiAffiliatePage,
  NewApiCreateTokenInput,
  NewApiGroupInfo,
  NewApiUserProfile,
  SiteConnectionStatusPayload,
  SiteVerifyPayload,
  ZcodeProxyPayload,
  NewApiLogsPayload,
  NewApiSiteInfo,
  NewApiTokenDetail,
  NewApiTokenInfo,
  NewApiRedeemResult,
  ProviderApiType,
  ProviderConnectivityPayload,
  ProviderModelsPayload,
  ProviderModelTestPayload,
  ProviderMutationPayload,
  ProviderRemovePayload,
  ProviderStatePayload,
  ProviderStreamTestPayload,
  ProviderUpsertInput,
  SessionDetailPayload,
  SessionListPayload,
  SessionOverviewPayload,
  SessionStatsPayload,
  TransferExportPayload,
  TransferImportPayload,
  TransferPreviewPayload,
  SiteUsagePayload,
  WalletPayload,
  SkillBackupListPayload,
  SkillDeleteBackupPayload,
  SkillImportPayload,
  SkillListPayload,
  SkillRemovePayload,
  SkillRestorePayload,
  UpdateInstallabilityPayload,
} from "@/types";
import { isTauriRuntime } from "@/lib/tauri-runtime";
import { formatInvokeError } from "@/lib/invoke-error";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  throw new Error(`Command "${cmd}" is only available in Tauri runtime`);
}

/** Rust CoreError::SiteTokenInvalid 的 Display 前缀，两层靠它对齐（见 newapi.rs） */
export const SITE_TOKEN_INVALID_MARKER = "站点访问令牌无效或已失效";

/** 站点明确拒绝访问令牌（存储连接已失效，需重新登录） */
export function isSiteTokenInvalidError(error: unknown): boolean {
  return formatInvokeError(error, "").includes(SITE_TOKEN_INVALID_MARKER);
}

export const api = {
  // ------------------------------------------------------------------
  // Providers（供应商注入）
  // ------------------------------------------------------------------
  loadProviders: () =>
    invoke<CoreEnvelope<ProviderStatePayload>>("load_providers"),

  fetchProviderModels: (apiType: ProviderApiType, baseUrl: string, apiKey: string) =>
    invoke<CoreEnvelope<ProviderModelsPayload>>("fetch_provider_models", {
      apiType,
      baseUrl,
      apiKey,
    }),

  testProviderConnectivity: (apiType: ProviderApiType, baseUrl: string, apiKey: string) =>
    invoke<CoreEnvelope<ProviderConnectivityPayload>>("test_provider_connectivity", {
      apiType,
      baseUrl,
      apiKey,
    }),

  /** 对已保存供应商的连通性测试；Key 只在后端读取，不经过前端 */
  testProvider: (providerId: string) =>
    invoke<CoreEnvelope<ProviderConnectivityPayload>>("test_provider", { providerId }),

  /** 模型实测：向注入的模型发一条最小推理请求（对应原版 AiMaMi 的模型测试） */
  testProviderModel: (providerId: string, modelId: string) =>
    invoke<CoreEnvelope<ProviderModelTestPayload>>("test_provider_model", {
      providerId,
      modelId,
    }),

  /** 流式连通性测试：真实流式推理请求，分阶段进度经事件推送（对应原版 AiMaMi 的连通性测试） */
  streamTestProviderModel: (providerId: string, modelId: string) =>
    invoke<CoreEnvelope<ProviderStreamTestPayload>>("stream_test_provider_model", {
      providerId,
      modelId,
    }),

  upsertProvider: (input: ProviderUpsertInput) =>
    invoke<CoreEnvelope<ProviderMutationPayload>>("upsert_provider", { input }),

  removeProvider: (providerId: string) =>
    invoke<CoreEnvelope<ProviderRemovePayload>>("remove_provider", { providerId }),

  setProviderEnabled: (providerId: string, enabled: boolean) =>
    invoke<CoreEnvelope<ProviderMutationPayload>>("set_provider_enabled", {
      providerId,
      enabled,
    }),

  // ------------------------------------------------------------------
  // NewAPI 站点接入（访问令牌 = 站点后台「系统访问令牌」）
  // ------------------------------------------------------------------
  /** baseUrl/accessToken 传 null 时由后端回落到「登录令牌」保存的站点连接；userId 供 New-Api-User 头 */
  newapiProbeSite: (baseUrl: string | null, accessToken: string | null, userId?: number | null) =>
    invoke<CoreEnvelope<NewApiSiteInfo>>("newapi_probe_site", {
      baseUrl,
      accessToken,
      userId: userId ?? null,
    }),

  newapiListTokens: (baseUrl: string | null, accessToken: string | null) =>
    invoke<CoreEnvelope<NewApiTokenInfo[]>>("newapi_list_tokens", { baseUrl, accessToken }),

  newapiRevealTokenKey: (tokenId: number, baseUrl: string | null, accessToken: string | null) =>
    invoke<CoreEnvelope<string>>("newapi_reveal_token_key", { tokenId, baseUrl, accessToken }),

  newapiAffiliateInfo: (baseUrl: string | null = null, accessToken: string | null = null) =>
    invoke<CoreEnvelope<NewApiAffiliateInfo>>("newapi_affiliate_info", { baseUrl, accessToken }),

  newapiInvitedUsers: (page: number, pageSize: number) =>
    invoke<CoreEnvelope<NewApiAffiliatePage>>("newapi_invited_users", { page, pageSize }),

  newapiTransferAffQuota: (quota: number) =>
    invoke<CoreEnvelope<boolean>>("newapi_transfer_aff_quota", { quota }),

  newapiListGroups: (baseUrl: string | null, accessToken: string | null) =>
    invoke<CoreEnvelope<NewApiGroupInfo[]>>("newapi_list_groups", { baseUrl, accessToken }),

  newapiListModels: (baseUrl: string | null, accessToken: string | null, group: string | null = null) =>
    invoke<CoreEnvelope<string[]>>("newapi_list_models", { baseUrl, accessToken, group }),

  newapiCreateToken: (
    baseUrl: string | null,
    accessToken: string | null,
    input: NewApiCreateTokenInput,
  ) =>
    invoke<CoreEnvelope<NewApiTokenDetail>>("newapi_create_token", {
      baseUrl,
      accessToken,
      input,
    }),

  newapiUserProfile: () =>
    invoke<CoreEnvelope<NewApiUserProfile>>("newapi_user_profile"),

  /** 账号密码登录：站点会话换取系统访问令牌并直接落盘（令牌不回传），成功返回站点信息 */
  newapiLoginWithPassword: (baseUrl: string, username: string, password: string) =>
    invoke<CoreEnvelope<NewApiSiteInfo>>("newapi_login_with_password", {
      baseUrl,
      username,
      password,
    }),

  newapiSiteConnectionStatus: () =>
    invoke<CoreEnvelope<SiteConnectionStatusPayload>>("newapi_site_connection_status"),

  newapiVerifySiteConnection: () =>
    invoke<CoreEnvelope<SiteVerifyPayload>>("newapi_verify_site_connection"),

  /** 连接成功后落盘站点连接（settings.json，仅本机），供仪表盘拉取余额与用量；userId 供 New-Api-User 头 */
  newapiSaveSiteConnection: (baseUrl: string, accessToken: string, userId?: number) =>
    invoke<CoreEnvelope<boolean>>("newapi_save_site_connection", {
      baseUrl,
      accessToken,
      userId: userId ?? null,
    }),

  newapiClearSiteConnection: () =>
    invoke<CoreEnvelope<boolean>>("newapi_clear_site_connection"),

  /** 仪表盘用量：未接入返回 connected=false，接入后返回余额与今/周/月消耗 */
  newapiSiteUsage: () => invoke<CoreEnvelope<SiteUsagePayload>>("newapi_site_usage"),

  /** 钱包统计：余额 / 总用量 / API 请求数 */
  newapiWallet: () => invoke<CoreEnvelope<WalletPayload>>("newapi_wallet"),

  /** 兑换码兑换，成功返回到账额度与最新余额 */
  newapiRedeem: (code: string) =>
    invoke<CoreEnvelope<NewApiRedeemResult>>("newapi_redeem", { code }),

  /** API 密钥页：未接入返回 connected=false */
  newapiKeys: () => invoke<CoreEnvelope<KeysPayload>>("newapi_keys"),

  newapiDeleteToken: (id: number) =>
    invoke<CoreEnvelope<boolean>>("newapi_delete_token", { id }),

  /** 启用(1)/禁用(2)密钥，服务端 status_only 模式只动状态 */
  newapiSetTokenStatus: (id: number, status: number) =>
    invoke<CoreEnvelope<boolean>>("newapi_set_token_status", { id, status }),

  /** 使用日志分页；logType/start/end 传 0 表示不过滤 */
  newapiLogs: (page: number, pageSize: number, logType: number, start: number, end: number) =>
    invoke<CoreEnvelope<NewApiLogsPayload>>("newapi_logs", {
      page,
      pageSize,
      logType,
      start,
      end,
    }),

  // ------------------------------------------------------------------
  // MCP
  // ------------------------------------------------------------------
  loadMcpServers: () =>
    invoke<CoreEnvelope<McpServerListPayload>>("load_mcp_servers"),

  upsertMcpServer: (
    name: string,
    transport: McpTransport,
    enabled: boolean,
    fields: {
      command?: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
      environment?: Record<string, string>;
    },
  ) =>
    invoke<CoreEnvelope<McpServerMutationPayload>>("upsert_mcp_server", {
      name,
      transport,
      enabled,
      command: fields.command ?? null,
      args: fields.args ?? null,
      url: fields.url ?? null,
      headers: fields.headers ?? null,
      environment: fields.environment ?? null,
    }),

  setMcpServerEnabled: (name: string, enabled: boolean) =>
    invoke<CoreEnvelope<McpServerMutationPayload>>("set_mcp_server_enabled", {
      name,
      enabled,
    }),

  removeMcpServer: (name: string) =>
    invoke<CoreEnvelope<McpServerRemovePayload>>("remove_mcp_server", { name }),

  // ------------------------------------------------------------------
  // Skills
  // ------------------------------------------------------------------
  loadInstalledSkills: () =>
    invoke<CoreEnvelope<SkillListPayload>>("load_installed_skills"),

  loadSkillBackups: () =>
    invoke<CoreEnvelope<SkillBackupListPayload>>("load_skill_backups"),

  importSkill: (sourcePath: string) =>
    invoke<CoreEnvelope<SkillImportPayload>>("import_skill", { sourcePath }),

  removeSkill: (skillId: string) =>
    invoke<CoreEnvelope<SkillRemovePayload>>("remove_skill", { skillId }),

  restoreSkillBackup: (backupId: string) =>
    invoke<CoreEnvelope<SkillRestorePayload>>("restore_skill_backup", { backupId }),

  deleteSkillBackup: (backupId: string) =>
    invoke<CoreEnvelope<SkillDeleteBackupPayload>>("delete_skill_backup", { backupId }),

  // ------------------------------------------------------------------
  // Custom instructions（AGENTS.md 受控区块）
  // ------------------------------------------------------------------
  loadCustomInstructionState: () =>
    invoke<CoreEnvelope<CustomInstructionStatePayload>>("load_custom_instruction_state"),

  previewCustomInstructionApply: (content: string) =>
    invoke<CoreEnvelope<CustomInstructionPreviewPayload>>(
      "preview_custom_instruction_apply",
      { content },
    ),

  applyCustomInstruction: (
    content: string,
    templateCode?: string,
    templateTitle?: string,
    source?: string,
  ) =>
    invoke<CoreEnvelope<CustomInstructionStatePayload>>("apply_custom_instruction", {
      content,
      templateCode: templateCode ?? null,
      templateTitle: templateTitle ?? null,
      source: source ?? null,
    }),

  clearCustomInstructionBlock: () =>
    invoke<CoreEnvelope<CustomInstructionStatePayload>>("clear_custom_instruction_block"),

  rollbackCustomInstruction: (historyId: string) =>
    invoke<CoreEnvelope<CustomInstructionStatePayload>>("rollback_custom_instruction", {
      historyId,
    }),

  // ------------------------------------------------------------------
  // Sessions（只读）
  // ------------------------------------------------------------------
  listSessions: (
    query?: string,
    includeArchived?: boolean,
    limit?: number,
    offset?: number,
  ) =>
    invoke<CoreEnvelope<SessionListPayload>>("list_sessions", {
      query: query ?? null,
      includeArchived: includeArchived ?? false,
      limit: limit ?? 50,
      offset: offset ?? 0,
    }),

  /** 会话页顶部统计卡：总数 / 存储体积 / 活跃天数 / 日均会话 */
  getSessionOverview: () =>
    invoke<CoreEnvelope<SessionOverviewPayload>>("get_session_overview"),

  getSessionDetail: (taskId: string) =>
    invoke<CoreEnvelope<SessionDetailPayload>>("get_session_detail", { taskId }),

  getSessionStats: (taskId: string) =>
    invoke<CoreEnvelope<SessionStatsPayload>>("get_session_stats", { taskId }),

  // ------------------------------------------------------------------
  // 会话迁移（导出 zip / 导入 zip）
  // ------------------------------------------------------------------
  /** 把指定会话导出为 zip（outPath 由前端 save 对话框取得）；进度走 session-transfer-progress 事件 */
  exportSessions: (taskIds: string[], outPath: string) =>
    invoke<CoreEnvelope<TransferExportPayload>>("export_sessions", { taskIds, outPath }),

  /** 解析迁移包生成导入预览（不做任何写入） */
  inspectSessionZip: (zipPath: string) =>
    invoke<CoreEnvelope<TransferPreviewPayload>>("inspect_session_zip", { zipPath }),

  /** 导入迁移包（mode: skip=跳过已存在 | overwrite=覆盖已存在）；进度走 session-transfer-progress 事件 */
  importSessions: (
    zipPath: string,
    mode: "skip" | "overwrite",
    targetWorkspace?: string | null,
  ) =>
    invoke<CoreEnvelope<TransferImportPayload>>("import_sessions", {
      zipPath,
      mode,
      targetWorkspace: targetWorkspace ?? null,
    }),

  // ------------------------------------------------------------------
  // System
  // ------------------------------------------------------------------
  loadAppState: () =>
    invoke<CoreEnvelope<AppStatePayload>>("load_app_state"),

  setCheckZcodeRunning: (enabled: boolean) =>
    invoke<CoreEnvelope<AppSettings>>("set_check_zcode_running", { enabled }),

  isZcodeRunning: () => invoke<CoreEnvelope<boolean>>("is_zcode_running"),

  loadZcodeProxy: () =>
    invoke<CoreEnvelope<ZcodeProxyPayload>>("load_zcode_proxy"),

  setZcodeProxy: (enabled: boolean, port: string | null) =>
    invoke<CoreEnvelope<ZcodeProxyPayload>>("set_zcode_proxy", {
      input: { enabled, port },
    }),

  restartZcode: () => invoke<CoreEnvelope<void>>("restart_zcode"),

  diagnose: () => invoke<CoreEnvelope<DiagnosePayload>>("diagnose"),

  clean: () => invoke<CoreEnvelope<CleanPayload>>("clean"),

  checkUpdateInstallability: () =>
    invoke<UpdateInstallabilityPayload>("check_update_installability"),

  gracefulRestartForUpdate: () => invoke<void>("graceful_restart_for_update"),

  openPath: (path: string) => invoke<void>("open_path", { path }),

  getSystemInfo: () =>
    invoke<SystemInfo>("get_system_info"),

  // ------------------------------------------------------------------
  // Dashboard（仪表盘）
  // ------------------------------------------------------------------
  loadDashboard: () =>
    invoke<CoreEnvelope<DashboardPayload>>("load_dashboard"),
};

type SystemInfo = {
  os: string;
  osVersion: string;
  arch: string;
  hostname: string;
};
