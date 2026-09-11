import { execFile } from "node:child_process";

export interface FrameworkPaths {
  cacheDir: string;
  configDir: string;
  logDir: string;
}

const START_MARKER = "@@MT_DEVOPS_OUTPUT_START@@";
const END_MARKER = "@@MT_DEVOPS_OUTPUT_END@@";

/**
 * Runs a script body in a genuinely interactive bash (`-i`), the only
 * mode in which ~/.bashrc actually loads the framework -- both a plain
 * `bash -c` and a login `bash -lc` skip it entirely, since Debian's
 * default ~/.bashrc starts with `case $- in *i*) ;; *) return;; esac`.
 * Framework functions (mt-status, docker-ls, ...) are only defined
 * after that point, so anything that needs them must go through here.
 *
 * Interactive startup can print its own banner/warnings to stdout
 * (verified: this machine's ~/.bashrc ends with an unconditional
 * `echo` "environment loaded" line) before the script body's own
 * output -- so the real payload is wrapped in sentinel markers and
 * extracted between them, rather than trusting stdout to be clean.
 *
 * `scriptBody` must always be a fixed literal written in this
 * extension's own source (e.g. "mt-status --json") -- never a string
 * built from user input or a QuickPick selection. execFile passes it
 * as a single argv element to `bash -ic`, not through an outer shell,
 * so there's no argv-splitting/injection surface from this call itself;
 * the trust boundary is simply that bash -ic interprets its own -c
 * argument as a script by design.
 */
function runInteractiveShell(scriptBody: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = `echo "${START_MARKER}"; ${scriptBody}; echo "${END_MARKER}"`;
    execFile("/bin/bash", ["-ic", wrapped], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      const start = stdout.indexOf(START_MARKER);
      const end = stdout.indexOf(END_MARKER);
      if (start === -1 || end === -1 || end < start) {
        reject(new Error(stderr.trim() || "Framework shell output was missing its markers."));
        return;
      }
      resolve(stdout.slice(start + START_MARKER.length, end).trim());
    });
  });
}

/**
 * Resolves the framework's XDG-based state directories by reading the
 * vars config_manager.py already exports (CACHE_DIR, CONFIG_DIR,
 * LOG_DIR) -- never reimplements that resolution logic (config.yaml
 * overrides, XDG fallbacks) here, so this always agrees with what the
 * framework itself considers "the" cache/config/log dirs.
 */
export async function resolveFrameworkPaths(): Promise<FrameworkPaths> {
  const output = await runInteractiveShell('printf "%s\\n%s\\n%s\\n" "$CACHE_DIR" "$CONFIG_DIR" "$LOG_DIR"');
  const [cacheDir, configDir, logDir] = output.split("\n");
  if (!cacheDir || !configDir || !logDir) {
    throw new Error("Could not resolve CACHE_DIR/CONFIG_DIR/LOG_DIR from the shell profile.");
  }
  return { cacheDir, configDir, logDir };
}

/**
 * Runs one of the framework's own `--json` commands (added in Phase 0:
 * mt-status, mt-doctor, docker-ls, k8s-status, k8s-pods) and parses its
 * output as JSON. See runInteractiveShell's docstring for the trust
 * contract on `command`.
 */
export async function runFrameworkJson<T = unknown>(command: string): Promise<T> {
  const output = await runInteractiveShell(command);
  try {
    return JSON.parse(output) as T;
  } catch {
    // Guard clauses in framework commands (e.g. "no active kubectl
    // context") print a colorized human message on the non---json
    // path instead of JSON when a precondition isn't met -- surface
    // that real reason, stripped of ANSI codes, rather than a generic
    // parse-failure message.
    // eslint-disable-next-line no-control-regex
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
    throw new Error(stripped || `${command} did not return valid JSON.`);
  }
}
