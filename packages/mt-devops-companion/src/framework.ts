import { exec } from "node:child_process";

export interface FrameworkPaths {
  cacheDir: string;
  configDir: string;
  logDir: string;
}

/**
 * Resolves the framework's XDG-based state directories by sourcing the
 * user's real shell profile and reading the vars config_manager.py
 * already exports (CACHE_DIR, CONFIG_DIR, LOG_DIR) -- never reimplements
 * that resolution logic (config.yaml overrides, XDG fallbacks) here, so
 * this always agrees with what the framework itself considers "the"
 * cache/config/log dirs. Non-interactive `.bashrc` sourcing is safe:
 * every background/side-effect hook in the framework guards on
 * `[[ $- != *i* ]]`.
 */
export function resolveFrameworkPaths(): Promise<FrameworkPaths> {
  return new Promise((resolve, reject) => {
    const script =
      'source ~/.bashrc >/dev/null 2>&1; printf "%s\\n%s\\n%s\\n" "$CACHE_DIR" "$CONFIG_DIR" "$LOG_DIR"';
    exec(script, { shell: "/bin/bash" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [cacheDir, configDir, logDir] = stdout.trim().split("\n");
      if (!cacheDir || !configDir || !logDir) {
        reject(new Error("Could not resolve CACHE_DIR/CONFIG_DIR/LOG_DIR from the shell profile."));
        return;
      }
      resolve({ cacheDir, configDir, logDir });
    });
  });
}
