import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  server: { port: 5301, fs: { allow: [resolve(import.meta.dirname, "../../..")] } },
  build: { outDir: "dist" },
});
