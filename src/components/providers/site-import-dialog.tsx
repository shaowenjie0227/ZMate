import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

import { api } from "@/lib/api";
import type {
  NewApiGroupInfo,
  NewApiSiteInfo,
  NewApiTokenInfo,
  ProviderApiType,
  ProviderModelInput,
} from "@/types";
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
import { SiteLoginDialog } from "@/components/site-login/site-login-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { CONTEXT_TIERS, type ContextTierId } from "@/lib/model-tiers";
import { cn } from "@/lib/utils";

/** 面板绑定的中转站预设（与 providers-page 的 AISPOT_BASE 保持一致） */
const AISPOT_BASE = "https://aispot.swj0227.icu";
const PROTOCOLS: ProviderApiType[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];

type ImportPath = "existing" | "create" | "custom";
type Step = "choose" | "pick" | "group" | "config" | "finish";

/** 各协议可选的推理等级（从低到高） */
function protocolReasoningLevels(protocol: ProviderApiType): string[] {
  return protocol === "anthropic-messages"
    ? ["off", "low", "medium", "high"]
    : ["none", "low", "medium", "high", "xhigh", "max"];
}



/** path 里是否已经有 /v1 这类版本段（有则不再追加，避免拼成 /v1/v1） */
function hasVersionSegment(base: string): boolean {
  const withoutScheme = base.split("://").pop() ?? base;
  const slash = withoutScheme.indexOf("/");
  const path = slash === -1 ? "" : withoutScheme.slice(slash);
  return path.split("/").some((seg) => /^v[0-9]+$/i.test(seg));
}

/** anthropic 协议挂站点根路径，OpenAI 系挂 /v1；站点地址已带版本段时原样使用 */
function presetBaseUrlFor(siteBase: string, protocol: ProviderApiType): string {
  const trimmed = siteBase.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages" || hasVersionSegment(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/** 完成页中每个模型独立持有的注入配置 */
interface ImportModelConfig {
  contextTier: ContextTierId | null;
  contextWindow: string;
  maxOutput: string;
  inputImage: boolean;
  inputVideo: boolean;
  inputPdf: boolean;
  capStructured: boolean;
  capWebSearch: boolean;
  capMidSystem: boolean;
  levels: string[];
}

function emptyImportConfig(protocol: ProviderApiType): ImportModelConfig {
  return {
    contextTier: "500k",
    contextWindow: "500000",
    maxOutput: "192000",
    inputImage: true,
    inputVideo: false,
    inputPdf: false,
    capStructured: false,
    capWebSearch: false,
    capMidSystem: false,
    levels: protocolReasoningLevels(protocol),
  };
}

function normalizeKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("sk-") ? trimmed : `sk-${trimmed}`;
}

export function SiteImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("choose");
  const [path, setPath] = useState<ImportPath>("create");

  // 登录令牌页保存的站点连接：已连接时向导跳过登录直接接入；未登录选择接入方式时弹登录浮窗
  const siteConnQuery = useQuery({
    queryKey: ["site-connection"],
    queryFn: () => api.newapiSiteConnectionStatus(),
    enabled: open,
  });
  const [usingStored, setUsingStored] = useState(false);
  const storedProbeRef = useRef(false);

  // 连接站点
  const [siteBase, setSiteBase] = useState(AISPOT_BASE);
  const [loginOpen, setLoginOpen] = useState(false);
  const [siteInfo, setSiteInfo] = useState<NewApiSiteInfo | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // 「我已有 key」
  const [pathLoading, setPathLoading] = useState<ImportPath | null>(null);
  const [tokens, setTokens] = useState<NewApiTokenInfo[] | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<number | null>(null);

  // 「我还没有创建 key」
  const [groups, setGroups] = useState<NewApiGroupInfo[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [keyName, setKeyName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 「自定义配置」
  const [customProtocol, setCustomProtocol] = useState<ProviderApiType>("openai-responses");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");

  // 完成页
  const [providerName, setProviderName] = useState("");
  const [protocol, setProtocol] = useState<ProviderApiType>("openai-responses");
  const [finishBaseUrl, setFinishBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [manualInput, setManualInput] = useState("");
  const [modelsInfo, setModelsInfo] = useState<string | null>(null);

  // 模型导入配置：上下文档位 / 更多设置 / 推理等级
  const [modelConfigs, setModelConfigs] = useState<Record<string, ImportModelConfig>>({});
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());

  const ensureModelConfig = (id: string): ImportModelConfig =>
    modelConfigs[id] ?? emptyImportConfig(protocol);
  const updateModelConfig = (id: string, patch: Partial<ImportModelConfig>) => {
    setModelConfigs((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyImportConfig(protocol)), ...patch },
    }));
  };
  const toggleModelExpanded = (id: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { data: systemInfo } = useQuery({
    queryKey: ["system-info"],
    queryFn: () => api.getSystemInfo(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setPath("create");
    setSiteBase(AISPOT_BASE);
    setLoginOpen(false);
    setSiteInfo(null);
    setConnectError(null);
    setUsingStored(false);
    storedProbeRef.current = false;
    setTokens(null);
    setSelectedTokenId(null);
    setGroups(null);
    setSelectedGroup("");
    setKeyName("");
    setConfirmOpen(false);
    setCustomProtocol("openai-responses");
    setCustomBaseUrl("");
    setCustomApiKey("");
    setProviderName("");
    setProtocol("openai-responses");
    setFinishBaseUrl("");
    setApiKey("");
    setShowKey(false);
    setModels([]);
    setSelectedModels(new Set());
    setManualInput("");
    setModelsInfo(null);
    setModelConfigs({});
    setExpandedModels(new Set());
  }, [open]);

  useEffect(() => {
    if (systemInfo?.hostname && !keyName) {
      const host = systemInfo.hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24);
      setKeyName(`zmate-${host || "device"}`);
    }
  }, [systemInfo, keyName]);

  // 已保存过站点连接：记住站点地址并自动探测一次站点信息（令牌用存储值，不经前端）
  useEffect(() => {
    const data = siteConnQuery.data?.data;
    if (!open || !data) return;
    if (data.connected) {
      setUsingStored(true);
      setSiteBase(data.baseUrl);
      if (!storedProbeRef.current) {
        storedProbeRef.current = true;
        api
          .newapiProbeSite(data.baseUrl, null)
          .then((res) => setSiteInfo(res.data))
          .catch(() => {
            // 存储连接探测失败（令牌可能失效）：回落到未登录态，由登录浮窗重新绑定
            setUsingStored(false);
            setConnectError(t("providers.site.storedConnectFailed"));
          });
      }
    } else {
      setUsingStored(false);
    }
  }, [open, siteConnQuery.data, t]);

  // ------------------------------------------------------------------
  // 站点接入：登录绑定 + 按路径拉取令牌 / 分组
  // ------------------------------------------------------------------
  /** 令牌一律传 null，由后端取存储连接（登录浮窗成功即落盘，令牌不经前端） */
  const loadPathData = async (
    pathArg: ImportPath,
    conn?: { base: string; token: string | null },
  ) => {
    const base = (conn?.base ?? siteBase).trim();
    const token = conn?.token ?? null;
    setPathLoading(pathArg);
    try {
      if (pathArg === "existing") {
        const res = await api.newapiListTokens(base, token);
        setTokens(res.data);
        setStep("pick");
      } else {
        const res = await api.newapiListGroups(base, token);
        setGroups(res.data);
        setSelectedGroup(
          siteInfo?.group && res.data.some((g) => g.name === siteInfo.group)
            ? siteInfo.group
            : (res.data[0]?.name ?? ""),
        );
        setStep("group");
      }
    } catch (error) {
      // 存储连接可能已失效：弹回登录浮窗重新绑定
      setUsingStored(false);
      setConnectError(error instanceof Error ? error.message : t("common.toastErrorGenericDesc"));
      setLoginOpen(true);
    } finally {
      setPathLoading(null);
    }
  };

  /** 登录浮窗成功：站点已绑定，直接继续当前接入路径 */
  const handleLoginSuccess = (info: NewApiSiteInfo, base: string) => {
    setLoginOpen(false);
    setUsingStored(true);
    setSiteBase(base);
    setSiteInfo(info);
    setConnectError(null);
    void loadPathData(path, { base, token: null });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.newapiCreateToken(siteBase.trim(), null, {
        name: keyName.trim(),
        group: selectedGroup || null,
        unlimitedQuota: true,
        remainQuota: null,
        expiredTime: null,
      }),
    onSuccess: (response) => {
      setConfirmOpen(false);
      const detail = response.data;
      setApiKey(normalizeKey(detail.key));
      enterFinish({
        name: siteInfo?.systemName ?? "NewAPI",
        protocol: "openai-responses",
        baseUrl: presetBaseUrlFor(siteBase.trim(), "openai-responses"),
        source: "site",
        group: selectedGroup || null,
      });
      if (!detail.key) {
        toast({
          title: t("providers.site.createKeyNoSecret"),
          variant: "destructive",
        });
      }
    },
    onError: (error) => {
      setConfirmOpen(false);
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  /** 进入完成页：初始化名称 / 地址 / 协议，并拉取模型列表（显式传参避免读到旧 state） */
  const enterFinish = (opts: {
    name: string;
    protocol: ProviderApiType;
    baseUrl: string;
    source: "site" | "key";
    group?: string | null;
  }) => {
    setProviderName(opts.name);
    setProtocol(opts.protocol);
    setFinishBaseUrl(opts.baseUrl);
    setModels([]);
    setSelectedModels(new Set());
    setManualInput("");
    setModelsInfo(null);
    setModelConfigs({});
    setExpandedModels(new Set());
    setStep("finish");

    if (opts.source === "site") {
      void fetchSiteModels(opts.group ?? null);
    } else {
      void fetchKeyModels(opts.protocol, opts.baseUrl);
    }
  };

  const fetchSiteModels = async (group: string | null) => {
    setModelsInfo(t("providers.site.fetchingModels"));
    try {
      const res = await api.newapiListModels(siteBase.trim(), null, group);
      applyModels(res.data);
    } catch {
      setModelsInfo(t("providers.site.siteFetchModelsFailed"));
    }
  };

  const fetchKeyModels = async (protocolArg: ProviderApiType, baseUrlArg: string) => {
    setModelsInfo(t("providers.wizard.fetching"));
    try {
      const res = await api.fetchProviderModels(protocolArg, baseUrlArg, apiKey.trim());
      applyModels(res.data.items);
    } catch {
      setModelsInfo(t("providers.site.siteFetchModelsFailed"));
    }
  };

  const applyModels = (items: string[]) => {
    if (items.length === 0) {
      setModelsInfo(t("providers.wizard.noModels"));
      return;
    }
    setModels(items);
    setSelectedModels(new Set(items));
    setModelConfigs((prev) => {
      const next: Record<string, ImportModelConfig> = {};
      for (const id of items) next[id] = prev[id] ?? emptyImportConfig(protocol);
      return next;
    });
    // 模型卡「更多设置」默认全部展开
    setExpandedModels(new Set(items));
    setModelsInfo(t("providers.wizard.fetchSuccess", { count: items.length }));
  };

  const upsertMutation = useMutation({
    mutationFn: () => {
      const levelOrder = protocolReasoningLevels(protocol);
      const selectedInputs: ProviderModelInput[] = models
        .filter((id) => selectedModels.has(id))
        .map((id) => {
          const cfg = modelConfigs[id] ?? emptyImportConfig(protocol);
          const contextWindow = Number.parseInt(cfg.contextWindow, 10);
          const maxOutput = Number.parseInt(cfg.maxOutput, 10);
          const levels = levelOrder.filter((level) => cfg.levels.includes(level));
          return {
            modelId: id,
            contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
            supportsImage: cfg.inputImage ? true : null,
            maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : null,
            supportsVideo: cfg.inputVideo ? true : null,
            supportsPdf: cfg.inputPdf ? true : null,
            supportsJsonSchemaOutput: cfg.capStructured ? true : null,
            supportsNativeWebSearch: cfg.capWebSearch ? true : null,
            supportsMidConversationSystem: cfg.capMidSystem ? true : null,
            reasoningLevels: levels,
            reasoningMap: null,
          };
        });
      return api.upsertProvider({
        providerId: null,
        providerName: providerName.trim(),
        apiType: protocol,
        baseUrl: presetBaseUrlFor(finishBaseUrl, protocol),
        apiKey: apiKey.trim(),
        models: selectedInputs,
      });
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast({
        title: t("providers.site.doneTitle"),
        description: t("providers.site.doneDesc", {
          providerId: response.data.provider.providerId,
          count: response.data.provider.modelCount,
        }),
        variant: "success",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  // ------------------------------------------------------------------
  // 派生状态
  // ------------------------------------------------------------------
  const selectedToken = useMemo(
    () => tokens?.find((token) => token.id === selectedTokenId) ?? null,
    [tokens, selectedTokenId],
  );

  const isTokenUsable = (token: NewApiTokenInfo) =>
    token.status === 1 && (token.expiredTime <= 0 || token.expiredTime * 1000 > Date.now());

  const selectedGroupRatio = groups?.find((g) => g.name === selectedGroup)?.ratio ?? 1;

  const switchFinishProtocol = (next: ProviderApiType) => {
    setProtocol(next);
    setModelConfigs((prev) => {
      const nextConfigs: Record<string, ImportModelConfig> = {};
      for (const [id, cfg] of Object.entries(prev)) {
        nextConfigs[id] = { ...cfg, levels: protocolReasoningLevels(next) };
      }
      return nextConfigs;
    });
    setFinishBaseUrl((prev) =>
      siteInfo && (prev === "" || prev.startsWith(siteBase.trim().replace(/\/+$/, "")))
        ? presetBaseUrlFor(siteBase.trim(), next)
        : prev,
    );
  };

  const addManualModels = () => {
    const ids = manualInput
      .split(/[\s,，]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    setModels((prev) => {
      const merged = [...prev];
      for (const id of ids) {
        if (!merged.includes(id)) merged.push(id);
      }
      return merged;
    });
    setModelConfigs((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (!next[id]) next[id] = emptyImportConfig(protocol);
      }
      return next;
    });
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setExpandedModels((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setManualInput("");
  };

  const canSubmitFinish =
    providerName.trim().length > 0 &&
    finishBaseUrl.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    selectedModels.size > 0;

  const backTarget: Step | null =
    step === "finish"
      ? path === "custom"
        ? "config"
        : path === "existing"
          ? "pick"
          : "group"
      : step === "config" || step === "pick" || step === "group"
        ? "choose"
        : null;

  const quotaText = (token: NewApiTokenInfo) => {
    if (token.unlimitedQuota) return t("providers.site.quotaUnlimited");
    const unit = siteInfo?.quotaPerUnit || 500000;
    return t("providers.site.quotaRemaining", {
      amount: `$${(token.remainQuota / unit).toFixed(2)}`,
    });
  };

  const expiryText = (token: NewApiTokenInfo) => {
    if (token.expiredTime <= 0) return t("providers.site.neverExpires");
    return t("providers.site.expiresAt", {
      date: new Date(token.expiredTime * 1000).toLocaleDateString(),
    });
  };

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------
  const stepTitleKey: Record<Step, string> = {
    choose: "providers.site.chooseTitle",
    pick: "providers.site.pickTitle",
    group: "providers.site.groupTitle",
    config: "providers.site.configTitle",
    finish: "providers.site.finishTitle",
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(stepTitleKey[step])}</DialogTitle>
          <DialogDescription>
            {step === "choose"
              ? t("providers.site.description")
              : siteInfo
                ? t("providers.site.connectedAs", {
                    name: siteInfo.systemName,
                    user: siteInfo.username || siteInfo.displayName,
                    balance: `$${((siteInfo.quota || 0) / (siteInfo.quotaPerUnit || 500000)).toFixed(2)}`,
                  })
                : t("providers.wizard.protocolDesc")}
          </DialogDescription>
        </DialogHeader>

        {/* ---------- 第 0 步：三选一 ---------- */}
        {step === "choose" && (
          <div className="space-y-3">
            {usingStored && (
              <p className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t("providers.site.usingStoredConnection", { url: siteBase.trim() })}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <ChoiceCard
                icon={<KeyRound className="size-5 text-sky-500" />}
                title={t("providers.site.existingTitle")}
                desc={t("providers.site.existingDesc")}
                loading={pathLoading === "existing"}
                disabled={pathLoading !== null}
                onClick={() => {
                  setPath("existing");
                  if (usingStored) void loadPathData("existing");
                  else {
                    setConnectError(null);
                    setLoginOpen(true);
                  }
                }}
              />
              <ChoiceCard
                icon={<Sparkles className="size-5 text-violet-500" />}
                title={t("providers.site.createTitle")}
                desc={t("providers.site.createDesc")}
                loading={pathLoading === "create"}
                disabled={pathLoading !== null}
                onClick={() => {
                  setPath("create");
                  if (usingStored) void loadPathData("create");
                  else {
                    setConnectError(null);
                    setLoginOpen(true);
                  }
                }}
              />
              <ChoiceCard
                icon={<SlidersHorizontal className="size-5 text-amber-500" />}
                title={t("providers.site.customTitle")}
                desc={t("providers.site.customDesc")}
                disabled={pathLoading !== null}
                onClick={() => {
                  setPath("custom");
                  setStep("config");
                }}
              />
            </div>
          </div>
        )}

        {/* ---------- 我已有 key：令牌列表 ---------- */}
        {step === "pick" && (
          <div className="space-y-3">
            {tokens && tokens.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {t("providers.site.pickEmpty")}
              </p>
            ) : (
              <div className="max-h-[30rem] space-y-2 overflow-y-auto pr-1">
                {(tokens ?? []).map((token) => {
                  const usable = isTokenUsable(token);
                  const selected = selectedTokenId === token.id;
                  return (
                    <button
                      key={token.id}
                      type="button"
                      disabled={!usable || !token.key}
                      onClick={() => setSelectedTokenId(token.id)}
                      className={cn(
                        "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                        selected ? "border-primary bg-primary/8" : "border-border hover:bg-muted/50",
                        !usable && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{token.name}</span>
                        <TokenStatusBadge status={token.status} usable={usable} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {quotaText(token)} · {expiryText(token)}
                        {token.group ? ` · ${token.group}` : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedToken && !selectedToken.key && (
              <p className="text-xs text-destructive">{t("providers.site.keyNoSecret")}</p>
            )}
          </div>
        )}

        {/* ---------- 我还没有创建 key：分组选择 ---------- */}
        {step === "group" && (
          <div className="space-y-4">
            <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
              {(groups ?? []).map((group) => {
                const selected = selectedGroup === group.name;
                return (
                  <button
                    key={group.name}
                    type="button"
                    onClick={() => setSelectedGroup(group.name)}
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
            <p className="text-xs text-muted-foreground">{t("providers.site.groupHint")}</p>
            <div className="space-y-1.5">
              <Label>{t("providers.site.keyName")}</Label>
              <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} className="font-mono" />
              <p className="text-xs text-muted-foreground">{t("providers.site.keyNameHint")}</p>
            </div>
          </div>
        )}

        {/* ---------- 自定义配置 ---------- */}
        {step === "config" && (
          <div className="space-y-4">
            <div className="flex gap-2">
              {PROTOCOLS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCustomProtocol(item)}
                  className={cn(
                    "flex-1 rounded-xl border px-3 py-2 text-center transition-colors",
                    customProtocol === item
                      ? "border-primary bg-primary/8"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  <span className="block text-sm font-medium">{t(`providers.protocol.${item}`)}</span>
                  <span className="block font-mono text-[10px] text-muted-foreground">{item}</span>
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>{t("providers.wizard.baseUrlTitle")}</Label>
              <Input
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                className="font-mono"
                placeholder={t("providers.wizard.baseUrlPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("providers.wizard.apiKeyTitle")}</Label>
              <Input
                type="password"
                value={customApiKey}
                onChange={(e) => setCustomApiKey(e.target.value)}
                className="font-mono"
                placeholder={t("providers.wizard.apiKeyPlaceholder")}
              />
            </div>
          </div>
        )}

        {/* ---------- 完成页：确认注入 ---------- */}
        {step === "finish" && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("providers.wizard.providerName")}</Label>
                <Input
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder={t("providers.wizard.providerNamePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("providers.wizard.apiKeyTitle")}</Label>
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            </div>

            {path !== "custom" && (
              <div className="flex gap-2">
                {PROTOCOLS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => switchFinishProtocol(item)}
                    className={cn(
                      "flex-1 rounded-xl border px-3 py-2 text-center transition-colors",
                      protocol === item
                        ? "border-primary bg-primary/8"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <span className="block text-sm font-medium">
                      {t(`providers.protocol.${item}`)}
                    </span>
                    <span className="block font-mono text-[10px] text-muted-foreground">{item}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t("providers.wizard.baseUrlTitle")}</Label>
              <Input
                value={finishBaseUrl}
                onChange={(e) => setFinishBaseUrl(e.target.value)}
                className="font-mono"
              />
            </div>

            {models.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                    {t("providers.site.modelsSection", { count: selectedModels.size })}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setSelectedModels(
                        selectedModels.size === models.length ? new Set() : new Set(models),
                      )
                    }
                  >
                    {selectedModels.size === models.length
                      ? t("providers.site.clearAll")
                      : t("providers.site.selectAll")}
                  </Button>
                </div>
                <div className="max-h-[26rem] space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
                  {models.map((id) => {
                    const cfg = ensureModelConfig(id);
                    const expanded = expandedModels.has(id);
                    const activeTier = CONTEXT_TIERS.find(
                      (tier) =>
                        cfg.contextWindow === String(tier.context) &&
                        cfg.maxOutput === String(tier.maxOutput),
                    );
                    return (
                      <div
                        key={id}
                        className={cn(
                          "rounded-xl border px-2 py-1.5 transition-colors",
                          expanded
                            ? "border-primary/40 bg-primary/4"
                            : "border-transparent hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={selectedModels.has(id)}
                            onCheckedChange={(checked) =>
                              setSelectedModels((prev) => {
                                const next = new Set(prev);
                                if (checked === true) next.add(id);
                                else next.delete(id);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-sm">{id}</span>
                          <button
                            type="button"
                            onClick={() => toggleModelExpanded(id)}
                            className={cn(
                              "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                              expanded
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {expanded ? (
                              <ChevronUp className="size-3.5" />
                            ) : (
                              <ChevronDown className="size-3.5" />
                            )}
                            {t("providers.site.moreSettings")}
                          </button>
                        </div>
                        {expanded && (
                          <div className="mt-2 space-y-2.5 border-t border-border/60 pt-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.site.contextTier")}
                              </Label>
                              {CONTEXT_TIERS.map((tier) => {
                                const active = activeTier?.id === tier.id;
                                return (
                                  <button
                                    key={tier.id}
                                    type="button"
                                    onClick={() =>
                                      updateModelConfig(
                                        id,
                                        active
                                          ? { contextTier: null, contextWindow: "", maxOutput: "" }
                                          : {
                                              contextTier: tier.id,
                                              contextWindow: String(tier.context),
                                              maxOutput: String(tier.maxOutput),
                                            },
                                      )
                                    }
                                    className={cn(
                                      "rounded-lg border px-2 py-0.5 text-[11px] transition-colors",
                                      active
                                        ? "border-primary bg-primary/8 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted/50",
                                    )}
                                  >
                                    {tier.label}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="flex gap-2">
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {t("providers.site.contextWindow")}
                                </span>
                                <Input
                                  value={cfg.contextWindow}
                                  onChange={(e) =>
                                    updateModelConfig(id, {
                                      contextWindow: e.target.value.replace(/[^0-9]/g, ""),
                                    })
                                  }
                                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                                  inputMode="numeric"
                                  placeholder={t("providers.site.contextWindowPlaceholder")}
                                />
                              </div>
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {t("providers.site.maxOutputTokens")}
                                </span>
                                <Input
                                  value={cfg.maxOutput}
                                  onChange={(e) =>
                                    updateModelConfig(id, {
                                      maxOutput: e.target.value.replace(/[^0-9]/g, ""),
                                    })
                                  }
                                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                                  inputMode="numeric"
                                  placeholder={t("providers.site.maxOutputPlaceholder")}
                                />
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.site.inputTypes")}
                              </Label>
                              <span
                                aria-label={t("providers.site.inputText")}
                                className="rounded-lg border border-primary bg-primary/8 px-2 py-0.5 text-[11px] text-foreground"
                              >
                                已选 {t("providers.site.inputText")}
                              </span>
                              {(["inputImage", "inputVideo", "inputPdf"] as const).map((key) => {
                                const active = cfg[key];
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    onClick={() =>
                                      updateModelConfig(id, {
                                        [key]: !active,
                                      } as Partial<ImportModelConfig>)
                                    }
                                    className={cn(
                                      "rounded-lg border px-2 py-0.5 text-[11px] transition-colors",
                                      active
                                        ? "border-primary bg-primary/8 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted/50",
                                    )}
                                  >
                                    {active ? "已选 " : ""}
                                    {t(`providers.site.${key}`)}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.site.capabilities")}
                              </Label>
                              {(
                                ["capStructured", "capWebSearch", "capMidSystem"] as const
                              ).map((key) => {
                                const active = cfg[key];
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    onClick={() =>
                                      updateModelConfig(id, {
                                        [key]: !active,
                                      } as Partial<ImportModelConfig>)
                                    }
                                    className={cn(
                                      "rounded-lg border px-2 py-0.5 text-[11px] transition-colors",
                                      active
                                        ? "border-primary bg-primary/8 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted/50",
                                    )}
                                  >
                                    {active ? "已选 " : ""}
                                    {t(`providers.site.${key}`)}
                                  </button>
                                );
                              })}
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.site.reasoningLevels")}
                              </Label>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {protocolReasoningLevels(protocol).map((level) => {
                                  const active = cfg.levels.includes(level);
                                  return (
                                    <button
                                      key={level}
                                      type="button"
                                      onClick={() =>
                                        updateModelConfig(id, {
                                          levels: active
                                            ? cfg.levels.filter((l) => l !== level)
                                            : [...cfg.levels, level],
                                        })
                                      }
                                      className={cn(
                                        "rounded-lg border px-2 py-0.5 font-mono text-[11px] transition-colors",
                                        active
                                          ? "border-primary bg-primary/8 text-foreground"
                                          : "border-border text-muted-foreground hover:bg-muted/50",
                                      )}
                                    >
                                      {active ? "已选 " : ""}
                                      {level}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("providers.site.manualModels")}</Label>
              <div className="flex gap-2">
                <Input
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  className="h-8 font-mono text-xs"
                />
                <Button type="button" variant="outline" size="sm" onClick={addManualModels}>
                  <Plus />
                  {t("providers.site.manualAdd")}
                </Button>
              </div>
            </div>

            {modelsInfo && <p className="text-xs text-muted-foreground">{modelsInfo}</p>}
          </div>
        )}

        {/* ---------- 底部导航 ---------- */}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          {backTarget ? (
            <Button variant="ghost" size="sm" onClick={() => setStep(backTarget)}>
              <ArrowLeft />
              {t("providers.wizard.back")}
            </Button>
          ) : (
            <span />
          )}

          {step === "pick" && (
            <Button
              disabled={!selectedToken?.key}
              onClick={() => {
                if (!selectedToken) return;
                setApiKey(normalizeKey(selectedToken.key));
                enterFinish({
                  name: siteInfo?.systemName ?? "NewAPI",
                  protocol: "openai-responses",
                  baseUrl: presetBaseUrlFor(siteBase.trim(), "openai-responses"),
                  source: "site",
                  group: selectedToken.group || null,
                });
              }}
            >
              {t("providers.wizard.confirmInject")}
            </Button>
          )}

          {step === "group" && (
            <Button disabled={!selectedGroup || !keyName.trim()} onClick={() => setConfirmOpen(true)}>
              {t("providers.site.createKey")}
            </Button>
          )}

          {step === "config" && (
            <Button
              disabled={!customBaseUrl.trim() || !customApiKey.trim()}
              onClick={() => {
                setApiKey(customApiKey.trim());
                enterFinish({
                  name: "",
                  protocol: customProtocol,
                  baseUrl: customBaseUrl.trim(),
                  source: "key",
                });
              }}
            >
              {t("providers.site.next")}
            </Button>
          )}

          {step === "finish" && (
            <Button
              disabled={!canSubmitFinish || upsertMutation.isPending}
              onClick={() => upsertMutation.mutate()}
            >
              {upsertMutation.isPending && <Loader2 className="animate-spin" />}
              {upsertMutation.isPending ? t("providers.site.submitting") : t("providers.site.submit")}
            </Button>
          )}
        </DialogFooter>

        {/* ---------- 创建确认弹窗 ---------- */}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("providers.site.confirmCreateTitle")}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-1.5 text-sm">
                  <p>
                    {t("providers.site.confirmCreateSite")}: {siteInfo?.systemName}（{siteBase.trim()}）
                  </p>
                  <p>
                    {t("providers.site.confirmCreateGroup")}: {selectedGroup}
                    <span className="ml-1 font-mono text-muted-foreground">
                      ×{selectedGroupRatio.toFixed(2)}
                    </span>
                  </p>
                  <p>
                    {t("providers.site.confirmCreateKeyName")}: <span className="font-mono">{keyName.trim()}</span>
                  </p>
                  <p>
                    {t("providers.site.confirmCreatePolicy")}: {t("providers.site.policyValue")}
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
                {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                {t("providers.site.createKeyConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ---------- 登录浮窗：未登录时选择接入方式弹出，登录绑定成功后自动继续 ---------- */}
        <SiteLoginDialog
          open={loginOpen}
          onOpenChange={setLoginOpen}
          onSuccess={handleLoginSuccess}
          externalError={connectError}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function ChoiceCard({
  icon,
  title,
  desc,
  onClick,
  loading,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex items-center gap-2">
        {loading ? <Loader2 className="size-5 animate-spin text-primary" /> : icon}
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{desc}</p>
    </button>
  );
}

function TokenStatusBadge({ status, usable }: { status: number; usable: boolean }) {
  const { t } = useTranslation();
  if (usable) {
    return (
      <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
        {t("providers.site.tokenStatusEnabled")}
      </Badge>
    );
  }
  const keyByStatus: Record<number, string> = {
    2: "providers.site.tokenStatusDisabled",
    3: "providers.site.tokenStatusExpired",
    4: "providers.site.tokenStatusExhausted",
  };
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {t(keyByStatus[status] ?? "providers.site.tokenStatusUnknown")}
    </Badge>
  );
}
