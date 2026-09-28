import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowLeft, Download, FolderOpen, Loader2, Upload } from "lucide-react";

import { api } from "@/lib/api";
import type {
  SessionSummary,
  SessionTransferProgress,
  TransferPreviewPayload,
} from "@/types";
import { useToast } from "@/hooks/use-toast";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type TransferStep = "choose" | "export" | "import";
type ImportMode = "skip" | "overwrite";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMillis(ms: number, withTime = false): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const date = d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  if (!withTime) return date;
  return `${date} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/** 导出文件名时间戳：zmate-sessions-20260929-153000.zip */
function zipStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function SessionTransferDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<TransferStep>("choose");
  const [progress, setProgress] = useState<SessionTransferProgress | null>(null);

  // 导出步状态
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionInit, setSelectionInit] = useState(false);
  // 导入步状态
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<TransferPreviewPayload | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("skip");

  // 每次打开都回到第 0 步并清空上一次的状态。
  useEffect(() => {
    if (open) {
      setStep("choose");
      setProgress(null);
      setSearch("");
      setSelectedIds(new Set());
      setSelectionInit(false);
      setZipPath(null);
      setPreview(null);
      setImportMode("skip");
    }
  }, [open]);

  // 迁移进度事件（导出/导入/备份进行中才产生）。
  useEffect(() => {
    if (!open) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<SessionTransferProgress>("session-transfer-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      setProgress(null);
    };
  }, [open]);

  // ------------------------------------------------------------------
  // 导出
  // ------------------------------------------------------------------
  const listQuery = useQuery({
    // 独立 query key：与页面列表（limit 100 / 各自筛选）区分开。
    queryKey: ["session-transfer-export-list"],
    queryFn: () => api.listSessions(undefined, true, 500, 0),
    enabled: open && step === "export",
  });
  const sessions: SessionSummary[] = listQuery.data?.data.items ?? [];

  // 进入导出步后首次拿到列表时默认全选。
  useEffect(() => {
    if (step === "export" && !selectionInit && sessions.length > 0) {
      setSelectedIds(new Set(sessions.map((s) => s.taskId)));
      setSelectionInit(true);
    }
    if (step !== "export" && selectionInit) setSelectionInit(false);
  }, [step, selectionInit, sessions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.taskId.toLowerCase().includes(q),
    );
  }, [sessions, search]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(s.taskId));

  const toggleOne = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((s) => next.delete(s.taskId));
      else filtered.forEach((s) => next.add(s.taskId));
      return next;
    });
  };

  const exportMutation = useMutation({
    mutationFn: (outPath: string) => api.exportSessions(Array.from(selectedIds), outPath),
    onSuccess: (res) => {
      toast({
        title: t("sessions.transfer.exportDoneTitle"),
        description: t("sessions.transfer.exportDoneDesc", {
          exported: res.data.exported,
          size: formatBytes(res.data.fileBytes),
          path: res.data.filePath,
        }),
        variant: "success",
      });
      onClose();
    },
    onError: (e) =>
      toast({
        title: t("sessions.transfer.exportFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      }),
  });

  const handleExportClick = async () => {
    if (selectedIds.size === 0) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const outPath = await save({
      defaultPath: `zmate-sessions-${zipStamp()}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!outPath) return;
    exportMutation.mutate(outPath);
  };

  // ------------------------------------------------------------------
  // 导入
  // ------------------------------------------------------------------
  const inspectMutation = useMutation({
    mutationFn: (path: string) => api.inspectSessionZip(path),
    onSuccess: (res) => setPreview(res.data),
    onError: (e) =>
      toast({
        title: t("sessions.transfer.invalidZip"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      }),
  });

  const importMutation = useMutation({
    mutationFn: () => api.importSessions(zipPath!, importMode),
    onSuccess: (res) => {
      toast({
        title: t("sessions.transfer.importDoneTitle"),
        description: t("sessions.transfer.importDoneDesc", {
          imported: res.data.imported,
          skipped: res.data.skipped,
        }),
        variant: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["session-overview"] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: t("sessions.transfer.importFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      }),
  });

  const handleChooseZip = async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (typeof path !== "string") return;
    setZipPath(path);
    setPreview(null);
    inspectMutation.mutate(path);
  };

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------
  const busy =
    exportMutation.isPending || importMutation.isPending || inspectMutation.isPending;
  const conflictCount = preview?.items.filter((i) => i.existsLocally).length ?? 0;

  const titleKey =
    step === "export"
      ? "sessions.transfer.exportTitle"
      : step === "import"
        ? "sessions.transfer.importTitle"
        : "sessions.transfer.title";
  const descKey =
    step === "export"
      ? "sessions.transfer.exportDesc"
      : step === "import"
        ? "sessions.transfer.importDesc"
        : "sessions.transfer.desc";

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        {/* ---------- 第 0 步：导出 / 导入 ---------- */}
        {step === "choose" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              icon={<Upload className="size-5 text-sky-500" />}
              title={t("sessions.transfer.exportCardTitle")}
              desc={t("sessions.transfer.exportCardDesc")}
              onClick={() => setStep("export")}
            />
            <ChoiceCard
              icon={<Download className="size-5 text-emerald-500" />}
              title={t("sessions.transfer.importCardTitle")}
              desc={t("sessions.transfer.importCardDesc")}
              onClick={() => setStep("import")}
            />
          </div>
        )}

        {/* ---------- 导出：勾选会话 ---------- */}
        {step === "export" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={allFilteredSelected}
                  onCheckedChange={toggleAll}
                  disabled={busy || filtered.length === 0}
                />
                {t("sessions.transfer.selectAll")}
              </label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("sessions.transfer.selectedCount", {
                  selected: selectedIds.size,
                  total: sessions.length,
                })}
              </span>
            </div>

            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sessions.transfer.searchPlaceholder")}
              className="h-9"
              disabled={busy}
            />

            <div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-1">
              {listQuery.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  <Loader2 className="mx-auto size-4 animate-spin" />
                </p>
              ) : filtered.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  {t("sessions.transfer.noMatch")}
                </p>
              ) : (
                filtered.map((s) => {
                  const checked = selectedIds.has(s.taskId);
                  return (
                    <label
                      key={s.taskId}
                      htmlFor={`transfer-x-${s.taskId}`}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors",
                        checked ? "border-primary bg-primary/8" : "border-border hover:bg-muted/50",
                      )}
                    >
                      <Checkbox
                        id={`transfer-x-${s.taskId}`}
                        checked={checked}
                        onCheckedChange={() => toggleOne(s.taskId)}
                        disabled={busy}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {s.title || s.taskId}
                      </span>
                      {s.archived && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {t("sessions.includeArchived")}
                        </Badge>
                      )}
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatMillis(s.updatedAt, true)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ---------- 导入：选包 → 预览 ---------- */}
        {step === "import" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => !busy && void handleChooseZip()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {inspectMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              <span className="min-w-0 truncate font-mono text-xs">
                {zipPath ?? t("sessions.transfer.chooseZip")}
              </span>
            </button>

            {preview && (
              <>
                <p className="text-xs text-muted-foreground">
                  {t("sessions.transfer.previewOf", { total: preview.total })}
                </p>
                <div className="max-h-[32vh] space-y-1.5 overflow-y-auto pr-1">
                  {preview.items.map((item) => (
                    <div key={item.taskId} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex items-center gap-2">
                        {item.existsLocally && (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            {t("sessions.transfer.conflictBadge")}
                          </Badge>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {item.title || item.taskId}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatMillis(item.updatedAt, true)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 pl-0.5 text-[11px] text-muted-foreground">
                        <span>{t("sessions.transfer.messageCount", { n: item.messageCount })}</span>
                        {!item.bodyExists && <span>{t("sessions.transfer.noBody")}</span>}
                        {item.workspacePath && (
                          <span className="min-w-0 truncate font-mono">{item.workspacePath}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {t("sessions.transfer.modeLabel")}
                  </span>
                  <Select
                    value={importMode}
                    onValueChange={(v) => setImportMode(v as ImportMode)}
                    disabled={busy}
                  >
                    <SelectTrigger className="h-9 w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">{t("sessions.transfer.modeSkip")}</SelectItem>
                      <SelectItem value="overwrite">
                        {t("sessions.transfer.modeOverwrite")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {importMode === "skip" && conflictCount > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t("sessions.transfer.skipHint", { conflicts: conflictCount })}
                  </p>
                )}
                <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  {t("sessions.transfer.importWarning")}
                </p>
              </>
            )}
          </div>
        )}

        {/* ---------- 进度 ---------- */}
        {progress && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                {progress.stage === "backup"
                  ? t("sessions.transfer.progressBackup")
                  : progress.stage === "export"
                    ? t("sessions.transfer.progressExporting", {
                        done: progress.done,
                        total: progress.total,
                      })
                    : t("sessions.transfer.progressImporting", {
                        done: progress.done,
                        total: progress.total,
                      })}
              </span>
              {progress.stage !== "backup" && (
                <span className="tabular-nums">
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progressPct ?? 8}%` }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "choose" ? (
            <Button variant="outline" onClick={() => onClose()} disabled={busy}>
              {t("sessions.transfer.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setStep("choose")}
                disabled={busy}
              >
                <ArrowLeft />
                {t("sessions.transfer.back")}
              </Button>
              {step === "export" ? (
                <Button
                  onClick={() => void handleExportClick()}
                  disabled={busy || selectedIds.size === 0}
                >
                  {exportMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Upload />
                  )}
                  {t("sessions.transfer.exportButton", { selected: selectedIds.size })}
                </Button>
              ) : (
                <Button
                  onClick={() => importMutation.mutate()}
                  disabled={busy || !preview || preview.total === 0}
                >
                  {importMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  {t("sessions.transfer.importButton", { selected: preview?.total ?? 0 })}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCard({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{desc}</p>
    </button>
  );
}
