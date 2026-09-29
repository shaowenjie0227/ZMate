/*
 * 浏览器端 GUI 测试专用配置:在默认配置基础上挂载 Tauri IPC mock。
 * 用法:pnpm vite --config vite.config.mock.ts
 */
import { defineConfig, mergeConfig, type UserConfig } from "vite";
import baseFactory from "./vite.config";
import { tauriMockPlugin } from "./scripts/mock/vite-plugin-tauri-mock.mjs";

export default defineConfig(async () => {
  const base = (await baseFactory()) as UserConfig;
  return mergeConfig(base, {
    plugins: [tauriMockPlugin()],
  });
});
