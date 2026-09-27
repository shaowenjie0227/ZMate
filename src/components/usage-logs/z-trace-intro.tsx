import { useEffect, useRef, useState } from "react";

/**
 * 「使用日志」打开动画：一枚发光光点沿 Z 的笔画轨迹书写——
 * 第一笔（上横）平稳出发 → 斜线加速过渡 → 末笔（下横）减速收笔，
 * 沿途留下高亮拖尾构成 Z 字，收笔时整字短暂增亮后淡出，衔接页面内容。
 */

const DRAW_MS = 1000; // 书写时长
const FLASH_MS = 180; // 收笔增亮
const FADE_MS = 260; // 整体淡出

/** 时间(0~1) → 路径长度(0~1) 分段变速：上横平稳、斜线快、末笔减速 */
const KEYS: Array<[number, number]> = [
  [0, 0],
  [0.4, 0.34],
  [0.62, 0.62],
  [1, 1],
];

function progressAt(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  for (let i = 1; i < KEYS.length; i++) {
    const [t1, p1] = KEYS[i];
    const [t0, p0] = KEYS[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      const eased = i === KEYS.length - 1 ? 1 - Math.pow(1 - k, 2.2) : k;
      return p0 + (p1 - p0) * eased;
    }
  }
  return 1;
}

/** Z 的书写路径：上横（左→右）→ 斜线（右上→左下）→ 下横（左→右） */
const Z_PATH = "M 18 24 H 102 L 18 96 H 102";
const TAIL = 12; // 拖尾长度（归一化 pathLength 单位的百分比）

export function ZTraceIntro({ onFinish }: { onFinish: () => void }) {
  const [fading, setFading] = useState(false);
  const pathRef = useRef<SVGPathElement | null>(null);
  const trailRef = useRef<SVGPathElement | null>(null);
  const dotRef = useRef<SVGGElement | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    const path = pathRef.current;
    const trail = trailRef.current;
    const dot = dotRef.current;
    if (!path || !trail || !dot) return;

    const total = 1000; // pathLength 归一化，便于按百分比控制
    path.style.strokeDasharray = `${total}`;
    path.style.strokeDashoffset = `${total}`;
    trail.style.strokeDasharray = `${TAIL} ${total}`;
    trail.style.strokeDashoffset = `${total}`;

    let raf = 0;
    const start = performance.now();

    const finishUp = () => {
      if (finished.current) return;
      finished.current = true;
      // 收笔：整字增亮一瞬，然后淡出交还内容
      path.classList.add("z-trace-flash");
      window.setTimeout(() => setFading(true), FLASH_MS);
      window.setTimeout(onFinish, FLASH_MS + FADE_MS);
    };

    const tick = (now: number) => {
      const t = (now - start) / DRAW_MS;
      const p = progressAt(Math.min(t, 1));
      const head = p * total;

      path.style.strokeDashoffset = `${total - head}`;
      // 拖尾：只显示光点身后最近的一段
      trail.style.strokeDashoffset = `${TAIL - head}`;
      const pt = path.getPointAtLength(head);
      dot.setAttribute("transform", `translate(${pt.x} ${pt.y})`);

      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        // 光点停在终点并隐去，留下完整 Z
        dot.style.opacity = "0";
        finishUp();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onFinish]);

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-40 flex items-center justify-center transition-opacity ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      aria-hidden
    >
      <svg
        width="150"
        height="124"
        viewBox="0 0 120 120"
        fill="none"
        className="overflow-visible"
      >
        <defs>
          <filter id="z-trace-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* 未书写部分的幽灵轮廓，暗示即将成形的 Z */}
        <path
          d={Z_PATH}
          className="stroke-foreground"
          strokeOpacity={0.06}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* 已书写的主体笔画 */}
        <path
          ref={pathRef}
          d={Z_PATH}
          pathLength={1000}
          className="stroke-primary"
          strokeOpacity={0.55}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* 光点身后的高亮拖尾 */}
        <path
          ref={trailRef}
          d={Z_PATH}
          pathLength={1000}
          className="stroke-primary"
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#z-trace-glow)"
        />
        {/* 发光光点 */}
        <g ref={dotRef} filter="url(#z-trace-glow)">
          <circle r={9} className="fill-primary" opacity={0.25} />
          <circle r={4.5} className="fill-primary" />
          <circle r={2} fill="white" />
        </g>
      </svg>
    </div>
  );
}
