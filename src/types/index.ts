export type McpTransport = "stdio" | "http" | "sse" | "unknown";
export type CustomInstructionProtectionState = "ready" | "unmanaged" | "protected";
export type CustomInstructionHistoryAction = "apply" | "clear" | "rollback";

/** 与 ZCode provider_config.json 的 api.type 枚举严格一致 */
export type ProviderApiType =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages";

export interface CoreWarning {
  code: string;
  message: string;
}

export interface CoreEnvelope<T> {
  schemaVersion: number;
  success: boolean;
  code: string;
  message: string;
  warnings: CoreWarning[];
  data: T;
}

// ---------------------------------------------------------------------------
// Providers（供应商注入）
// ---------------------------------------------------------------------------

export interface ReasoningLevelSpec {
  values: string[];
  map: string;
}

export interface ProviderModelSummary {
  modelId: string;
  enabled: boolean;
  contextWindow: number | null;
  supportsImage: boolean | null;
  maxOutputTokens: number | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsJsonSchemaOutput: boolean | null;
  supportsNativeWebSearch: boolean | null;
  supportsMidConversationSystem: boolean | null;
  reasoning: ReasoningLevelSpec | null;
}

export interface ProviderSummary {
  providerId: string;
  providerName: string;
  apiType: ProviderApiType;
  baseUrl: string;
  modelCount: number;
  /** 所有模型是否均启用 */
  enabled: boolean;
  /** 仅返回是否已设置，绝不回传 key 本身 */
  apiKeySet: boolean;
  models: ProviderModelSummary[];
}

export interface ProviderStatePayload {
  items: ProviderSummary[];
  providerOrder: string[];
  sourcePath: string;
  configExists: boolean;
  lastScanAt: number;
}

export interface ProviderModelsPayload {
  items: string[];
}

export interface ProviderConnectivityPayload {
  reachable: boolean;
  statusCode: number | null;
  message: string;
  latencyMs: number | null;
}

/** 模型实测结果：按协议向模型发一条最小推理请求 */
export interface ProviderModelTestPayload {
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  message: string;
  replyPreview: string | null;
}

/** 流式连通性测试的分阶段进度事件 */
export type StreamTestStage = "sent" | "headers" | "first-packet" | "done";

export interface StreamTestProgressEvent {
  providerId: string;
  modelId: string;
  stage: StreamTestStage;
  statusCode: number | null;
  elapsedMs: number;
}

/** 流式连通性测试最终结果 */
export interface ProviderStreamTestPayload {
  success: boolean;
  providerId: string;
  modelId: string;
  statusCode: number | null;
  host: string;
  path: string;
  headerMs: number | null;
  firstPacketMs: number | null;
  totalMs: number | null;
  reply: string;
  message: string;
}

export interface NewApiAffiliateInfo {
  affCode: string;
  referralUrl: string;
  /** 待划转奖励（quota 原始单位） */
  pendingQuota: number;
  /** 已历史划转奖励 */
  historyQuota: number;
  inviteCount: number;
}

export interface NewApiAffiliatePage {
  page: number;
  pageSize: number;
  total: number;
  items: Array<Record<string, unknown>>;
}

export interface ProviderModelInput {
  modelId: string;
  contextWindow?: number | null;
  supportsImage?: boolean | null;
  /** 最大输出 token 上限，写入 optionSpecs.maxOutputTokens.max */
  maxOutputTokens?: number | null;
  supportsVideo?: boolean | null;
  supportsPdf?: boolean | null;
  /** 结构化输出 */
  supportsJsonSchemaOutput?: boolean | null;
  /** 原生联网搜索 */
  supportsNativeWebSearch?: boolean | null;
  /** 对话中系统消息 */
  supportsMidConversationSystem?: boolean | null;
  /** 档位列表，如 ["low","medium","high"]；anthropic 默认含 "off" */
  reasoningLevels?: string[] | null;
  /** 自定义 CEL 映射；缺省时后端按协议生成默认模板 */
  reasoningMap?: string | null;
}

export interface ProviderUpsertInput {
  /** 缺省时按 providerName 自动生成并去重 */
  providerId?: string | null;
  providerName: string;
  apiType: ProviderApiType;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelInput[];
}

export interface ProviderMutationPayload {
  provider: ProviderSummary;
  backupPath: string | null;
}

export interface ProviderRemovePayload {
  removedProviderId: string;
  backupPath: string | null;
}

// ---------------------------------------------------------------------------
// NewAPI 站点接入
// ---------------------------------------------------------------------------

export interface NewApiSiteInfo {
  systemName: string;
  version: string;
  /** 已确认的站点用户 ID（New-Api-User 头用；未知为 0） */
  userId: number;
  username: string;
  displayName: string;
  group: string;
  /** 剩余额度（原始 quota） */
  quota: number;
  usedQuota: number;
  quotaPerUnit: number;
}

export interface NewApiTokenInfo {
  id: number;
  name: string;
  /** 1=启用 2=禁用 3=已过期 4=已耗尽 */
  status: number;
  /** 裸 key（不含 sk- 前缀），仅用于向导内部流转，不落日志 */
  key: string;
  remainQuota: number;
  usedQuota: number;
  unlimitedQuota: boolean;
  /** -1 = 永不过期 */
  expiredTime: number;
  createdTime: number;
  accessedTime: number;
  group: string;
}

export interface KeysPayload {
  connected: boolean;
  items: NewApiTokenInfo[];
}

export interface NewApiLogEntry {
  id: number;
  createdAt: number;
  /** 0=其他 1=充值 2=消费 3=管理 4=系统 5=错误 6=退款 7=登录 */
  logType: number;
  content: string;
  modelName: string;
  tokenName: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
  useTime: number;
  /** 首响毫秒数（other.frt），负数=无首字数据（非流式/缺失） */
  frtMs: number;
  /** 缓存命中 token 数（other.cache_tokens，已含在 promptTokens 内），0=无 */
  cacheTokens: number;
  isStream: boolean;
  group: string;
}

export interface NewApiLogsPayload {
  items: NewApiLogEntry[];
  total: number;
}

export interface NewApiGroupInfo {
  name: string;
  ratio: number;
}

export interface NewApiTokenDetail {
  id: number;
  name: string;
  key: string;
}

export interface NewApiCreateTokenInput {
  name: string;
  group: string | null;
  unlimitedQuota: boolean;
  remainQuota: number | null;
  expiredTime: number | null;
}

/** 一个时间窗内的消耗（quota 除以 quotaPerUnit 得金额） */
export interface NewApiUsageWindow {
  quota: number;
  tokens: number;
}

export interface NewApiUsageSummary {
  systemName: string;
  balanceQuota: number;
  usedQuota: number;
  quotaPerUnit: number;
  today: NewApiUsageWindow;
  week: NewApiUsageWindow;
  month: NewApiUsageWindow;
}

export interface SiteUsagePayload {
  connected: boolean;
  baseUrl: string;
  summary: NewApiUsageSummary | null;
}

/** 钱包页统计：余额 / 总用量 / API 请求数 */
export interface NewApiWalletStats {
  systemName: string;
  username: string;
  balanceQuota: number;
  usedQuota: number;
  quotaPerUnit: number;
  requestCount: number;
}

export interface WalletPayload {
  connected: boolean;
  stats: NewApiWalletStats | null;
}

/** 兑换码结果：本次到账额度 + 兑换后的最新余额 */
export interface NewApiRedeemResult {
  grantedQuota: number;
  balanceQuota: number;
  usedQuota: number;
  quotaPerUnit: number;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpServerSummary {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  sourcePath: string;
  command: string | null;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
  environment: Record<string, string>;
}

export interface McpServerListPayload {
  items: McpServerSummary[];
  total: number;
  sourcePath: string;
  lastScanAt: number;
}

export interface McpServerMutationPayload {
  server: McpServerSummary;
  total: number;
  sourcePath: string;
}

export interface McpServerRemovePayload {
  removedName: string;
  total: number;
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface InstalledSkillSummary {
  id: string;
  name: string;
  title: string | null;
  summary: string | null;
  relativePath: string;
  directoryPath: string;
  skillFilePath: string;
  updatedAt: number | null;
}

export interface SkillListPayload {
  items: InstalledSkillSummary[];
  total: number;
  rootPath: string;
  lastScanAt: number;
}

export interface SkillBackupSummary {
  id: string;
  skillID: string;
  name: string;
  title: string | null;
  relativePath: string;
  backupPath: string;
  createdAt: number;
}

export interface SkillBackupListPayload {
  items: SkillBackupSummary[];
  total: number;
  rootPath: string;
  lastScanAt: number;
}

export interface SkillImportPayload {
  skill: InstalledSkillSummary;
  replacedExisting: boolean;
  backup: SkillBackupSummary | null;
}

export interface SkillRemovePayload {
  removedSkillID: string;
  backup: SkillBackupSummary;
  remainingInstalledCount: number;
}

export interface SkillRestorePayload {
  restoredSkill: InstalledSkillSummary;
  backup: SkillBackupSummary;
  rollbackBackup: SkillBackupSummary | null;
}

export interface SkillDeleteBackupPayload {
  deletedBackupID: string;
  remainingBackupCount: number;
}

// ---------------------------------------------------------------------------
// Custom instructions（AGENTS.md 受控区块）
// ---------------------------------------------------------------------------

export interface CustomInstructionCurrentState {
  globalPath: string;
  fileExists: boolean;
  managedBlockPresent: boolean;
  protectionState: CustomInstructionProtectionState;
  issueMessage: string | null;
  managedContent: string;
  lastAppliedAt: number | null;
  lastTemplateCode: string | null;
  lastTemplateTitle: string | null;
}

export interface CustomInstructionHistoryEntry {
  id: string;
  createdAt: number;
  action: CustomInstructionHistoryAction;
  source: string;
  templateCode: string | null;
  templateTitle: string | null;
}

export interface CustomInstructionStatePayload {
  current: CustomInstructionCurrentState;
  history: CustomInstructionHistoryEntry[];
}

export interface CustomInstructionPreviewPayload {
  globalPath: string;
  protectionState: CustomInstructionProtectionState;
  issueMessage: string | null;
  currentManagedContent: string;
  nextManagedContent: string;
  resultingContent: string;
}

// ---------------------------------------------------------------------------
// Sessions（只读）
// ---------------------------------------------------------------------------

export interface SessionSummary {
  taskId: string;
  workspacePath: string;
  title: string;
  status: string;
  provider: string | null;
  model: string | null;
  mode: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SessionListPayload {
  items: SessionSummary[];
  total: number;
  sourcePath: string;
  dbExists: boolean;
  lastScanAt: number;
}

/** 会话页顶部统计卡 */
export interface SessionOverviewPayload {
  totalSessions: number;
  storageBytes: number;
  activeDays: number;
  avgPerActiveDay: number;
}

export interface SessionMessagePart {
  kind: string;
  text: string;
}

export interface SessionMessage {
  id: string;
  role: string;
  timeCreated: number;
  parts: SessionMessagePart[];
}

export interface SessionDetailPayload {
  taskId: string;
  title: string;
  directory: string | null;
  version: string | null;
  messages: SessionMessage[];
  truncated: boolean;
}

export interface SessionStatsPayload {
  taskId: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  totalDurationMs: number;
  toolCallCount: number;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
}

// ---------------------------------------------------------------------------
// 会话迁移（导出 zip / 导入 zip）
// ---------------------------------------------------------------------------

/** 迁移进度事件载荷（session-transfer-progress） */
export interface SessionTransferProgress {
  stage: "backup" | "export" | "import";
  done: number;
  total: number;
}

/** 导入预览里的单个会话条目 */
export interface TransferPreviewItem {
  taskId: string;
  title: string;
  workspacePath: string | null;
  updatedAt: number;
  messageCount: number;
  bodyExists: boolean;
  existsLocally: boolean;
}

/** 导入预览载荷（inspect_session_zip） */
export interface TransferPreviewPayload {
  format: string;
  version: number;
  exportedAt: number;
  total: number;
  items: TransferPreviewItem[];
}

/** 导出结果（export_sessions） */
export interface TransferExportPayload {
  exported: number;
  missingTaskIds: string[];
  filePath: string;
  fileBytes: number;
}

/** 导入结果（import_sessions） */
export interface TransferImportPayload {
  imported: number;
  skipped: number;
  backupDir: string;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface AppSettings {
  checkZcodeRunning: boolean;
}

export interface AppStatePayload {
  zcodeHome: string;
  providerConfigPath: string;
  cliConfigPath: string;
  skillsDir: string;
  agentsMdPath: string;
  tasksDbPath: string;
  sessionDbPath: string;
  appDataDir: string;
  settings: AppSettings;
  zcodeRunning: boolean;
}

export interface DiagnosePathCheck {
  key: string;
  path: string;
  exists: boolean;
}

export interface DiagnosePayload {
  zcodeHome: string;
  coreVersion: string;
  os: string;
  arch: string;
  zcodeRunning: boolean;
  pathChecks: DiagnosePathCheck[];
  providerConfigValid: boolean;
  providerConfigError: string | null;
  cliConfigValid: boolean;
  cliConfigError: string | null;
  sessionDbExists: boolean;
  tasksDbExists: boolean;
}

export interface CleanPayload {
  providerBackupsRemoved: number;
  skillBackupsRemoved: number;
  instructionHistoryRemoved: number;
}

export interface NewApiUserProfile {
  systemName: string;
  username: string;
  displayName: string;
  email: string;
  group: string;
  /** new-api 角色：1 普通用户 / 10 管理 / 100 超管 */
  role: number;
  quota: number;
  usedQuota: number;
  requestCount: number;
  quotaPerUnit: number;
}

export interface SiteConnectionStatusPayload {
  connected: boolean;
  baseUrl: string;
  /** token = 访问令牌，password = 账号密码；空 = 旧数据 */
  authMethod: string;
}

export interface SiteVerifyPayload {
  ok: boolean;
  systemName: string;
  username: string;
  message: string;
}

export interface ZcodeProxyPayload {
  /** setting.json 里 httpProxy 非空即视为启用 */
  enabled: boolean;
  /** 本机代理端口（host 为 127.0.0.1/localhost 且端口可解析时才有值） */
  port: string | null;
  /** setting.json 里的原始 httpProxy 值 */
  proxyUrl: string | null;
  /** 代理地址是否指向本机 */
  isLocal: boolean;
  sourcePath: string;
}

export interface UpdateInstallabilityPayload {
  canInstall: boolean;
  code: string;
  executablePath: string | null;
  bundlePath: string | null;
  translocated: boolean;
  quarantined: boolean;
}

export interface SystemInfo {
  os: string;
  osVersion: string;
  arch: string;
  hostname: string;
}

// ---------------------------------------------------------------------------
// Dashboard（仪表盘）
// ---------------------------------------------------------------------------

export interface ActivityDay {
  date: string;
  count: number;
}

export interface HourlyActivityDay {
  date: string;
  /** 24 个小时桶（本地时间 0-23 时）的活跃消息数 */
  counts: number[];
}

export interface TokenDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ModelTokenDay {
  date: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface DashboardPayload {
  providerCount: number;
  modelCount: number;
  sessionCount: number;
  sessionStorageBytes: number;
  mcpTotal: number;
  mcpEnabled: number;
  skillCount: number;
  skillBackupCount: number;
  zcodeRunning: boolean;
  zcodeHome: string;
  coreVersion: string;
  pathChecks: DiagnosePathCheck[];
  providerConfigValid: boolean;
  providerConfigError: string | null;
  cliConfigValid: boolean;
  cliConfigError: string | null;
  activity: ActivityDay[];
  hourlyActivity: HourlyActivityDay[];
  hourlyTokens: HourlyActivityDay[];
  tokenDays: TokenDay[];
  modelTokenDays: ModelTokenDay[];
  generatedAt: number;
}
