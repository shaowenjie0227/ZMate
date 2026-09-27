/** 上下文档位：选择后自动填充上下文与最大输出（最大输出 ≈ 上下文 × 0.384） */
export const CONTEXT_TIERS = [
  { id: "200k", label: "200K", context: 200000, maxOutput: 76800 },
  { id: "272k", label: "272K", context: 272000, maxOutput: 104448 },
  { id: "500k", label: "500K", context: 500000, maxOutput: 192000 },
  { id: "1m", label: "1M", context: 1000000, maxOutput: 384000 },
] as const;

export type ContextTierId = (typeof CONTEXT_TIERS)[number]["id"];
