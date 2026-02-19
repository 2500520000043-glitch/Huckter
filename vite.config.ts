import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const isLanMode = mode === "lan";
  const plugins: PluginOption[] = [react()];
  if (isLanMode) {
    plugins.push(
      basicSsl({
        name: "aurora-chat-ui-lan"
      })
    );
  }

  return {
    plugins,
    server: isLanMode
      ? {
          host: "0.0.0.0",
          https: {},
          port: 5173,
          strictPort: true
        }
      : undefined,
    preview: isLanMode
      ? {
          host: "0.0.0.0",
          https: {},
          port: 4173,
          strictPort: true
        }
      : undefined
  };
});
