import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var isLanMode = mode === "lan";
    var plugins = [react()];
    if (isLanMode) {
        plugins.push(basicSsl({
            name: "aurora-chat-ui-lan"
        }));
    }
    return {
        plugins: plugins,
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
