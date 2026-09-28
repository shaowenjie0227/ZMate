import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageStageState = "active" | "exiting" | "idle";

// 页面保活期间（idle）不会卸载，需要"仅当前页可见"的东西（如页头操作按钮）
// 应消费此上下文自行隐藏
const PageStageContext = createContext<PageStageState>("active");

export function usePageStage() {
  return useContext(PageStageContext);
}

interface PageStageProps {
  state: PageStageState;
  padded?: boolean;
  /** 与内容外壳一起做纵向 flex 撑满（如账号管理分栏） */
  fillHeight?: boolean;
  scrollable?: boolean;
  children: ReactNode;
}

export function PageStage({
  state,
  padded = true,
  fillHeight = false,
  scrollable = true,
  children,
}: PageStageProps) {
  const shellTransitionStyle: CSSProperties = {
    transitionDuration: state === "active" ? "140ms" : "170ms",
    transitionTimingFunction: "cubic-bezier(0.2, 0.82, 0.3, 1)",
  };
  const contentTransitionStyle: CSSProperties = {
    transitionDuration: state === "active" ? "240ms" : "180ms",
    transitionTimingFunction: "cubic-bezier(0.22, 0.84, 0.32, 1)",
    transitionDelay: state === "active" ? "16ms" : "0ms",
  };

  return (
    <PageStageContext.Provider value={state}>
      <section
        aria-hidden={state !== "active"}
        style={shellTransitionStyle}
        className={cn(
          "absolute inset-0 [will-change:opacity] transition-opacity motion-reduce:transition-none",
          scrollable ? "overflow-y-auto scrollbar-hide" : "overflow-hidden",
          state === "active" && "z-20 opacity-100 pointer-events-auto",
          state === "exiting" && "z-10 opacity-0 pointer-events-none",
          state === "idle" && "z-0 opacity-0 pointer-events-none",
        )}
      >
        <div
          style={contentTransitionStyle}
          className={cn(
            "h-full transform-gpu [will-change:transform,opacity] transition-[opacity,transform] motion-reduce:transition-none",
            state === "active" && "opacity-100 translate-y-0",
            state === "exiting" && "opacity-0 -translate-y-px",
            state === "idle" && "opacity-0 translate-y-0.5",
          )}
        >
          {padded ? (
            <div
              className={cn(
                "w-full min-w-0 px-4 pb-6 pt-[9px] lg:px-6 lg:pt-[17px]",
                fillHeight && "flex h-full min-h-0 flex-col",
              )}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </div>
      </section>
    </PageStageContext.Provider>
  );
}
