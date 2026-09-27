import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";

import { api } from "@/lib/api";
import type { ProviderApiType, ProviderModelInput, ProviderSummary } from "@/types";
import { useBusyAction } from "@/hooks/use-busy-action";
import { useToast } from "@/hooks/use-toast";
import { StreamTestDialog, formatMs, type StreamTestOutcome } from "@/components/providers/stream-test-dialog";
import { SiteImportDialog } from "@/components/providers/site-import-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CONTEXT_TIERS } from "@/lib/model-tiers";
import { cn } from "@/lib/utils";

/** 面板绑定的中转站预设；选协议后按规则自动补 /v1 */
const AISPOT_BASE = "https://aispot.swj0227.icu";
const PROTOCOLS: ProviderApiType[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];

/** 该协议全部候选推理档位；新注入的模型默认全选 */
function defaultLevels(protocol: ProviderApiType): string[] {
  return protocol === "anthropic-messages"
    ? ["off", "low", "medium", "high"]
    : ["none", "low", "medium", "high", "xhigh", "max"];
}

function presetBaseUrl(protocol: ProviderApiType): string {
  return protocol === "anthropic-messages" ? AISPOT_BASE : `${AISPOT_BASE}/v1`;
}

/** path 里是否已经有 /v1 这类版本段（有则不再追加，避免拼成 /v1/v1） */
function hasVersionSegment(url: string): boolean {
  const withoutScheme = url.split("://").pop() ?? url;
  const slash = withoutScheme.indexOf("/");
  const path = slash === -1 ? "" : withoutScheme.slice(slash);
  return path.split("/").some((seg) => /^v[0-9]+$/i.test(seg));
}

/**
 * 用户手动填的 baseUrl 也要按协议归一化：
 * 已带版本段 → 原样保留；否则 openai 系补 /v1、anthropic 挂根路径。
 */
function normalizeBaseUrlFor(url: string, protocol: ProviderApiType): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return trimmed;
  }
  if (hasVersionSegment(trimmed)) {
    return trimmed;
  }
  return protocol === "anthropic-messages" ? trimmed : `${trimmed}/v1`;
}

interface ModelDraft {
  selected: boolean;
  /** 高级选项区展开状态（纯 UI 状态，不参与提交） */
  advancedOpen: boolean;
  contextWindow: string;
  supportsImage: boolean;
  maxOutput: string;
  supportsVideo: boolean;
  supportsPdf: boolean;
  capStructured: boolean;
  capWebSearch: boolean;
  capMidSystem: boolean;
  levels: string[];
  reasoningMap: string;
}

interface TestResult {
  reachable: boolean;
  message: string;
}

export function ProvidersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const refreshAction = useBusyAction({ minVisibleMs: 500 });
  // 页面操作按钮挂到顶栏（SiteHeader 的 #site-header-actions 容器）
  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderActionsEl(document.getElementById("site-header-actions"));
  }, []);

  const [formOpen, setFormOpen] = useState(false);
  const [siteImportOpen, setSiteImportOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderSummary | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [streamTestTarget, setStreamTestTarget] = useState<{
    provider: ProviderSummary;
    modelId: string;
  } | null>(null);
  const [lastResults, setLastResults] = useState<
    Record<string, { success: boolean; message: string }>
  >({});

  const stateQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.loadProviders(),
  });
  const providers = stateQuery.data?.data.items ?? [];
  const payload = stateQuery.data?.data;

  const refresh = async () => {
    await refreshAction.run(async () => {
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
    });
  };

  const removeMutation = useMutation({
    mutationFn: (providerId: string) => api.removeProvider(providerId),
    onSuccess: () => {
      setRemoveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast({ title: t("providers.removeSuccess"), variant: "success" });
    },
    onError: (error) => {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const enabledMutation = useMutation({
    mutationFn: ({ providerId, enabled }: { providerId: string; enabled: boolean }) =>
      api.setProviderEnabled(providerId, enabled),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast({
        title: t(response.data.provider.enabled ? "providers.enabled" : "providers.disabled"),
        variant: "success",
      });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  /** 打开流式连通性测试对话框（对应原版 AiMaMi 的连通性测试） */
  const openStreamTest = (provider: ProviderSummary, modelId?: string) => {
    const target =
      modelId ??
      provider.models.find((m) => m.enabled)?.modelId ??
      provider.models[0]?.modelId;
    if (!target) {
      toast({ title: t("providers.noModelToTest"), variant: "destructive" });
      return;
    }
    setStreamTestTarget({ provider, modelId: target });
  };

  const handleStreamFinished = (providerId: string, outcome: StreamTestOutcome) => {
    setLastResults((prev) => ({
      ...prev,
      [providerId]: {
        success: outcome.success,
        message:
          outcome.firstPacketMs != null
            ? `${outcome.message} · ${t("providers.chipFirstPacket", { ms: formatMs(outcome.firstPacketMs) })}`
            : outcome.message,
      },
    }));
  };

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    toast({ title: t("providers.pathCopied"), variant: "success" });
  };

  return (
    <div className="space-y-6">
      {headerActionsEl &&
        createPortal(
          <>
            <Button variant="outline" onClick={() => setSiteImportOpen(true)}>
              <KeyRound />
              {t("providers.site.title")}
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              {t("providers.add")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="ml-auto"
              onClick={() => void refresh()}
              disabled={refreshAction.busy}
            >
              {refreshAction.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </>,
          headerActionsEl,
        )}

      <div className="flex gap-3">
        <StatCard label={t("providers.providerCount")} value={providers.length} loading={stateQuery.isLoading} />
        <StatCard
          label={t("providers.modelCount")}
          value={providers.reduce((sum, p) => sum + p.modelCount, 0)}
          loading={stateQuery.isLoading}
        />
        <StatCard
          className="min-w-0 flex-1"
          label={t("providers.configFile")}
          value={payload?.configExists ? "" : t("providers.empty")}
          path={payload?.sourcePath}
          onCopyPath={payload?.sourcePath ? () => void copyPath(payload.sourcePath) : undefined}
          loading={stateQuery.isLoading}
        />
      </div>

      {stateQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="font-medium">{t("providers.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("providers.emptyDesc")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => {
            return (
              <ProviderCard
                key={provider.providerId}
                provider={provider}
                expanded={expanded === provider.providerId}
                onToggleExpand={() =>
                  setExpanded(expanded === provider.providerId ? null : provider.providerId)
                }
                onEnabledChange={(enabled) =>
                  enabledMutation.mutate({ providerId: provider.providerId, enabled })
                }
                onRemove={() => setRemoveTarget(provider)}
                onEdit={() => {
                  setEditing(provider);
                  setFormOpen(true);
                }}
                onTest={() => openStreamTest(provider)}
                onTestModel={(modelId) => openStreamTest(provider, modelId)}
                lastResult={lastResults[provider.providerId]}
                enabledBusy={enabledMutation.isPending}
              />
            );
          })}
        </div>
      )}

      <SiteImportDialog open={siteImportOpen} onClose={() => setSiteImportOpen(false)} />

      <ProviderFormDialog
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
      />

      {streamTestTarget && (
        <StreamTestDialog
          provider={streamTestTarget.provider}
          initialModelId={streamTestTarget.modelId}
          onClose={() => setStreamTestTarget(null)}
          onFinished={handleStreamFinished}
        />
      )}

      <AlertDialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("providers.confirmRemoveTitle", { name: removeTarget?.providerName ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("providers.confirmRemoveDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeMutation.isPending}
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.providerId)}
            >
              {removeMutation.isPending ? <Loader2 className="animate-spin" /> : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  path,
  onCopyPath,
  loading,
  className,
}: {
  label: string;
  value: number | string;
  path?: string;
  onCopyPath?: () => void;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3${
        className ? ` ${className}` : ""
      }`}
    >
      <p className="shrink-0 text-xs text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="h-6 w-16" />
      ) : path ? (
        <button
          type="button"
          onClick={onCopyPath}
          className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right text-sm font-medium text-primary hover:underline"
        >
          <span className="truncate">{path}</span>
          <Copy className="size-3.5 shrink-0" />
        </button>
      ) : (
        <p className="ml-auto text-xl font-semibold tabular-nums">{value}</p>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  expanded,
  onToggleExpand,
  onEnabledChange,
  onRemove,
  onEdit,
  onTest,
  onTestModel,
  lastResult,
  enabledBusy,
}: {
  provider: ProviderSummary;
  expanded: boolean;
  onToggleExpand: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onRemove: () => void;
  onEdit: () => void;
  onTest: () => void;
  onTestModel: (modelId: string) => void;
  lastResult: { success: boolean; message: string } | undefined;
  enabledBusy: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{provider.providerName}</span>
              <Badge variant="secondary">
                {t(`providers.protocol.${provider.apiType}`)}
              </Badge>
              {provider.apiKeySet ? (
                <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
                  {t("providers.apiKeySet")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                  {t("providers.apiKeyMissing")}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {provider.providerId} · {provider.baseUrl} · {provider.modelCount}{" "}
              {t("providers.models")}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-1.5">
          <Switch
            checked={provider.enabled}
            disabled={enabledBusy}
            onCheckedChange={onEnabledChange}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!provider.apiKeySet || provider.models.length === 0}
            title={
              !provider.apiKeySet
                ? t("providers.noKeyToTest")
                : provider.models.length === 0
                  ? t("providers.noModelToTest")
                  : t("providers.modelTestHint")
            }
            onClick={onTest}
          >
            <Zap className="text-amber-500" />
            {t("providers.test")}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove}>
            <Trash2 className="text-destructive" />
          </Button>
        </div>
      </div>

      {lastResult && (
        <div className="px-4 pb-2">
          <p
            className={cn(
              "text-xs",
              lastResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {lastResult.message}
          </p>
        </div>
      )}

      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-4 py-3">
          {provider.models.map((model) => {
            return (
              <div key={model.modelId} className="rounded-xl bg-muted/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{model.modelId}</span>
                  {!model.enabled && (
                    <Badge variant="outline" className="text-muted-foreground">
                      {t("providers.disabled")}
                    </Badge>
                  )}
                  {model.contextWindow != null && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      ctx {model.contextWindow.toLocaleString()}
                    </Badge>
                  )}
                  {model.supportsImage && (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      image
                    </Badge>
                  )}
                  {model.reasoning && (
                    <div className="flex items-center gap-1">
                      <Zap className="size-3 text-amber-500" />
                      {model.reasoning.values.map((level, levelIndex) => (
                        <Badge
                          key={`${level}-${levelIndex}`}
                          variant="outline"
                          className="border-primary/30 bg-primary/8 font-mono text-[10px] text-primary"
                        >
                          {level}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    disabled={!provider.apiKeySet}
                    title={t("providers.modelTestHint")}
                    onClick={() => onTestModel(model.modelId)}
                  >
                    <Zap className="text-amber-500" />
                    {t("providers.test")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新增 / 编辑表单（中转注入模板式：单表单一次填完）
// ---------------------------------------------------------------------------

function emptyDraft(protocol: ProviderApiType): ModelDraft {
  return {
    selected: true,
    advancedOpen: false,
    contextWindow: "",
    supportsImage: false,
    maxOutput: "",
    supportsVideo: false,
    supportsPdf: false,
    capStructured: false,
    capWebSearch: false,
    capMidSystem: false,
    levels: defaultLevels(protocol),
    reasoningMap: "",
  };
}

function draftFromSummary(
  model: ProviderSummary["models"][number],
  fallbackLevels: string[],
): ModelDraft {
  return {
    selected: true,
    advancedOpen: false,
    contextWindow: model.contextWindow != null ? String(model.contextWindow) : "",
    supportsImage: model.supportsImage ?? false,
    maxOutput: model.maxOutputTokens != null ? String(model.maxOutputTokens) : "",
    supportsVideo: model.supportsVideo ?? false,
    supportsPdf: model.supportsPdf ?? false,
    capStructured: model.supportsJsonSchemaOutput ?? false,
    capWebSearch: model.supportsNativeWebSearch ?? false,
    capMidSystem: model.supportsMidConversationSystem ?? false,
    levels: model.reasoning?.values ?? fallbackLevels,
    reasoningMap: model.reasoning?.map ?? "",
  };
}

function ProviderFormDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ProviderSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [protocol, setProtocol] = useState<ProviderApiType>("openai-responses");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState(presetBaseUrl("openai-responses"));
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
  const [connectivity, setConnectivity] = useState<TestResult | null>(null);
  const [fetchInfo, setFetchInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConnectivity(null);
    setFetchInfo(null);
    setShowKey(false);
    if (editing) {
      setProtocol(editing.apiType);
      setProviderName(editing.providerName);
      setBaseUrl(editing.baseUrl);
      setApiKey("");
      setModels(editing.models.map((m) => m.modelId));
      setDrafts(() => {
        const next: Record<string, ModelDraft> = {};
        for (const model of editing.models) {
          next[model.modelId] = draftFromSummary(model, defaultLevels(editing.apiType));
        }
        return next;
      });
    } else {
      setProtocol("openai-responses");
      setProviderName("");
      setBaseUrl(presetBaseUrl("openai-responses"));
      setApiKey("");
      setModels([]);
      setDrafts({});
    }
  }, [open, editing]);

  const switchProtocol = (next: ProviderApiType) => {
    setProtocol(next);
    setBaseUrl((prev) =>
      prev === "" || prev.startsWith(AISPOT_BASE) ? presetBaseUrl(next) : prev,
    );
    // 档位候选集随协议变化（anthropic 含 off、openai 系含 none/xhigh/max），
    // 已选档位统一重置为新协议的全量档位（默认全选）
    setDrafts((prev) => {
      const nextDrafts: Record<string, ModelDraft> = {};
      for (const [id, draft] of Object.entries(prev)) {
        nextDrafts[id] = { ...draft, levels: defaultLevels(next) };
      }
      return nextDrafts;
    });
    setConnectivity(null);
  };

  const testMutation = useMutation({
    mutationFn: () => api.testProviderConnectivity(protocol, baseUrl, apiKey),
    onSuccess: (response) => {
      const data = response.data;
      setConnectivity({ reachable: data.reachable, message: data.message });
    },
    onError: (error) => {
      setConnectivity({
        reachable: false,
        message: error instanceof Error ? error.message : t("providers.connectivityFailed"),
      });
    },
  });

  const fetchMutation = useMutation({
    mutationFn: () => api.fetchProviderModels(protocol, baseUrl, apiKey),
    onSuccess: (response) => {
      const items = response.data.items;
      if (items.length === 0) {
        setFetchInfo(t("providers.wizard.noModels"));
        return;
      }
      setFetchInfo(t("providers.wizard.fetchSuccess", { count: items.length }));
      const merged = [...models];
      for (const id of items) {
        if (!merged.includes(id)) merged.push(id);
      }
      setModels(merged);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const id of items) {
          if (!next[id]) next[id] = emptyDraft(protocol);
        }
        return next;
      });
    },
    onError: (error) => {
      toast({
        title: t("providers.wizard.fetchFailed"),
        description: error instanceof Error ? error.message : t("common.toastErrorGenericDesc"),
        variant: "destructive",
      });
    },
  });

  const injectMutation = useMutation({
    mutationFn: () => {
      const selectedModels: ProviderModelInput[] = models
        .filter((id) => drafts[id]?.selected)
        .map((id) => {
          const draft = drafts[id];
          const contextWindow = Number.parseInt(draft.contextWindow, 10);
          const maxOutput = Number.parseInt(draft.maxOutput, 10);
          return {
            modelId: id,
            contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
            supportsImage: draft.supportsImage ? true : null,
            maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : null,
            supportsVideo: draft.supportsVideo ? true : null,
            supportsPdf: draft.supportsPdf ? true : null,
            supportsJsonSchemaOutput: draft.capStructured ? true : null,
            supportsNativeWebSearch: draft.capWebSearch ? true : null,
            supportsMidConversationSystem: draft.capMidSystem ? true : null,
            reasoningLevels: draft.levels,
            reasoningMap: draft.reasoningMap.trim() ? draft.reasoningMap.trim() : null,
          };
        });
      return api.upsertProvider({
        providerId: editing ? editing.providerId : null,
        providerName: providerName.trim(),
        apiType: protocol,
        baseUrl: normalizeBaseUrlFor(baseUrl, protocol),
        apiKey: apiKey.trim(),
        models: selectedModels,
      });
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      if (editing) {
        toast({ title: t("providers.injectedUpdatedTitle"), variant: "success" });
      } else {
        const provider = response.data.provider;
        const firstModel = provider.models[0];
        const levels = firstModel?.reasoning?.values;
        const level = levels && levels.length > 0 ? levels[levels.length - 1] : "high";
        toast({
          title: t("providers.wizard.injectedTitle"),
          description: t("providers.wizard.injectedDesc", {
            providerId: provider.providerId,
            modelId: firstModel?.modelId ?? "model",
            level,
          }),
          variant: "success",
          duration: 2000,
        });
      }
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

  const selectedCount = useMemo(
    () => models.filter((id) => drafts[id]?.selected).length,
    [models, drafts],
  );

  const canSubmit =
    providerName.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    (editing || apiKey.trim().length > 0) &&
    selectedCount > 0;

  const updateDraft = (modelId: string, patch: Partial<ModelDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [modelId]: { ...(prev[modelId] ?? emptyDraft(protocol)), ...patch },
    }));
  };

  const toggleAll = () => {
    const allSelected = models.every((id) => drafts[id]?.selected);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const id of models) {
        next[id] = { ...(prev[id] ?? emptyDraft(protocol)), selected: !allSelected };
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("providers.editTitle", { name: editing.providerName })
              : t("providers.add")}
          </DialogTitle>
          <DialogDescription>{t("providers.wizard.protocolDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ---------- 基本信息 ---------- */}
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            {t("providers.sectionBasic")}
          </p>

          <div className="space-y-2">
            <div className="flex gap-2">
              {PROTOCOLS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => switchProtocol(item)}
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
          </div>

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
                  placeholder={
                    editing
                      ? t("providers.keyKeepHint")
                      : t("providers.wizard.apiKeyPlaceholder")
                  }
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

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t("providers.wizard.baseUrlTitle")}</Label>
              <Button
                type="button"
                variant="soft"
                size="xs"
                onClick={() => {
                  setBaseUrl(presetBaseUrl(protocol));
                  setConnectivity(null);
                }}
              >
                {t("providers.addAispot")}
              </Button>
            </div>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono"
              placeholder={t("providers.wizard.baseUrlPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("providers.wizard.baseUrlDesc")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testMutation.isPending || !baseUrl.trim() || (editing ? false : !apiKey.trim())}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending && <Loader2 className="animate-spin" />}
              {testMutation.isPending ? t("providers.wizard.testing") : t("providers.wizard.testConnection")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={fetchMutation.isPending || !baseUrl.trim() || !apiKey.trim()}
              onClick={() => fetchMutation.mutate()}
            >
              {fetchMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {fetchMutation.isPending ? t("providers.wizard.fetching") : t("providers.wizard.fetchModels")}
            </Button>
            {!editing && (
              <span className="text-xs text-muted-foreground">{t("providers.wizard.apiKeyDesc")}</span>
            )}
          </div>

          {(connectivity || fetchInfo) && (
            <div className="space-y-0.5">
              {connectivity && (
                <p
                  className={cn(
                    "text-xs",
                    connectivity.reachable
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive",
                  )}
                >
                  {connectivity.message}
                </p>
              )}
              {fetchInfo && <p className="text-xs text-muted-foreground">{fetchInfo}</p>}
            </div>
          )}

          {/* ---------- 模型 ---------- */}
          {models.length > 0 && (
            <>
              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("providers.sectionModels", { count: selectedCount })}
                </p>
                <Button type="button" variant="ghost" size="xs" onClick={toggleAll}>
                  {selectedCount === models.length ? t("common.cancel") : t("common.confirm")}
                </Button>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {models.map((id) => {
                  const draft = drafts[id] ?? emptyDraft(protocol);
                  return (
                    <div key={id} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={draft.selected}
                          onCheckedChange={(checked) => updateDraft(id, { selected: checked === true })}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-sm">{id}</span>
                        <button
                          type="button"
                          onClick={() => updateDraft(id, { advancedOpen: !draft.advancedOpen })}
                          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3.5 transition-transform",
                              draft.advancedOpen && "rotate-90",
                            )}
                          />
                          {t("providers.wizard.advanced")}
                        </button>
                      </div>

                      {draft.selected && (
                        <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                              {t("providers.site.contextTier")}
                            </Label>
                            {CONTEXT_TIERS.map((tier) => {
                              const active =
                                draft.contextWindow === String(tier.context) &&
                                draft.maxOutput === String(tier.maxOutput);
                              return (
                                <button
                                  key={tier.id}
                                  type="button"
                                  onClick={() =>
                                    updateDraft(
                                      id,
                                      active
                                        ? { contextWindow: "", maxOutput: "" }
                                        : {
                                            contextWindow: String(tier.context),
                                            maxOutput: String(tier.maxOutput),
                                          },
                                    )
                                  }
                                  className={cn(
                                    "rounded-lg border px-2.5 py-1 text-xs transition-colors",
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
                          {draft.advancedOpen && (
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="flex items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.wizard.contextWindow")}
                              </Label>
                              <Input
                                value={draft.contextWindow}
                                onChange={(e) => updateDraft(id, { contextWindow: e.target.value })}
                                placeholder={t("providers.wizard.contextWindowPlaceholder")}
                                className="h-7 w-36 text-xs"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                {t("providers.site.maxOutputTokens")}
                              </Label>
                              <Input
                                value={draft.maxOutput}
                                onChange={(e) =>
                                  updateDraft(id, { maxOutput: e.target.value.replace(/[^0-9]/g, "") })
                                }
                                placeholder={t("providers.wizard.contextWindowPlaceholder")}
                                className="h-7 w-32 text-xs"
                              />
                            </div>
                          </div>
                          )}
                          {draft.advancedOpen && (
                          <div className="flex flex-wrap items-center gap-3">
                            <Label className="text-xs text-muted-foreground">
                              {t("providers.site.inputTypes")}
                            </Label>
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
                              <Checkbox checked disabled aria-label={t("providers.site.inputText")} />
                              {t("providers.site.inputText")}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs">
                              <Checkbox
                                checked={draft.supportsImage}
                                onCheckedChange={(checked) =>
                                  updateDraft(id, { supportsImage: checked === true })
                                }
                              />
                              {t("providers.site.inputImage")}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs">
                              <Checkbox
                                checked={draft.supportsVideo}
                                onCheckedChange={(checked) =>
                                  updateDraft(id, { supportsVideo: checked === true })
                                }
                              />
                              {t("providers.site.inputVideo")}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs">
                              <Checkbox
                                checked={draft.supportsPdf}
                                onCheckedChange={(checked) =>
                                  updateDraft(id, { supportsPdf: checked === true })
                                }
                              />
                              {t("providers.site.inputPdf")}
                            </label>
                          </div>
                          )}

                          {draft.advancedOpen && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                              {t("providers.site.capabilities")}
                            </Label>
                            {(
                              [
                                ["capStructured", t("providers.site.capStructured")],
                                ["capWebSearch", t("providers.site.capWebSearch")],
                                ["capMidSystem", t("providers.site.capMidSystem")],
                              ] as const
                            ).map(([key, label]) => {
                              const active = draft[key];
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => updateDraft(id, { [key]: !active })}
                                  className={cn(
                                    "rounded-lg border px-2.5 py-1 text-xs transition-colors",
                                    active
                                      ? "border-primary bg-primary/8 text-foreground"
                                      : "border-border text-muted-foreground hover:bg-muted/50",
                                  )}
                                >
                                  {active ? "✓ " : ""}
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                          )}

                          {draft.advancedOpen && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              {t("providers.wizard.reasoningLevels")}
                            </Label>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {((): string[] => {
                                const candidates = defaultLevels(protocol);
                                // 已保存配置里可能有候选之外的自定义档位，追加在尾部保留
                                return Array.from(
                                  new Set([...candidates, ...draft.levels]),
                                );
                              })().map((level) => {
                                const active = draft.levels.includes(level);
                                return (
                                  <button
                                    key={level}
                                    type="button"
                                    onClick={() =>
                                      updateDraft(id, {
                                        levels: active
                                          ? draft.levels.filter((l) => l !== level)
                                          : Array.from(
                                              new Set([...draft.levels, level]),
                                            ),
                                      })
                                    }
                                    className={cn(
                                      "rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors",
                                      active
                                        ? "border-primary bg-primary/8 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted/50",
                                    )}
                                  >
                                    {level}
                                  </button>
                                );
                              })}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {t("providers.wizard.reasoningLevelsDesc")}
                            </p>
                          </div>
                          )}

                          {draft.advancedOpen && (
                          <div className="space-y-1">
                            <Input
                              value={draft.reasoningMap}
                              onChange={(e) => updateDraft(id, { reasoningMap: e.target.value })}
                              placeholder={t("providers.wizard.reasoningMapPlaceholder")}
                              className="font-mono text-xs"
                            />
                            <p className="text-[11px] text-muted-foreground">
                              {t("providers.wizard.reasoningMapDesc")}
                            </p>
                          </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canSubmit || injectMutation.isPending}
            onClick={() => injectMutation.mutate()}
          >
            {injectMutation.isPending && <Loader2 className="animate-spin" />}
            {injectMutation.isPending
              ? t("providers.wizard.injecting")
              : editing
                ? t("providers.saveChanges")
                : t("providers.inject")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
