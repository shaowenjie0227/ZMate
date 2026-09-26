import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

interface SiteHeaderProps {
  title: string;
}

export function SiteHeader({ title }: SiteHeaderProps) {
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
    </header>
  );
}
