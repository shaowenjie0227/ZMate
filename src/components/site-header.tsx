import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

interface SiteHeaderProps {
  title: string;
  /** 渲染在标题栏右侧的操作区（如页面级刷新按钮） */
  action?: ReactNode;
}

export function SiteHeader({ title, action }: SiteHeaderProps) {
  return (
    <header
      className="relative z-[70] flex h-12 shrink-0 items-center gap-2 border-b px-4"
      data-tauri-drag-region
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 !h-4" />
      <h1 className="text-sm font-medium" data-tauri-drag-region>
        {title}
      </h1>
      {/* 页面可通过 portal 往这里塞自己的操作按钮 */}
      <div
        id="site-header-actions"
        className="ml-auto flex items-center gap-2"
        data-tauri-no-drag
      />
      {action ? (
        <div className="flex items-center gap-2" data-tauri-no-drag>
          {action}
        </div>
      ) : null}
    </header>
  );
}
