/*
 * Vite 插件:向 dev 页面注入 Tauri IPC mock 启动脚本(仅用于浏览器端 GUI 功能测试)。
 * 通过 vite.config.mock.ts 挂载,不会影响默认构建与 tauri dev。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BOOT_PATH = fileURLToPath(new URL("./mock-boot.js", import.meta.url));
const BOOT_URL = "/__zmate_mock_boot.js";

export function tauriMockPlugin() {
  return {
    name: "zmate-tauri-mock",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { src: BOOT_URL },
            injectTo: "head-prepend",
          },
        ],
      };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.split("?")[0] === BOOT_URL) {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.end(readFileSync(BOOT_PATH, "utf8"));
          return;
        }
        next();
      });
    },
  };
}
