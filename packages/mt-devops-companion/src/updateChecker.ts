import { createWriteStream } from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const REPO_OWNER = "MatStacey";
const REPO_NAME = "mt-devops-vscode-extension-pack";

/**
 * Every extension this pack ships, as (VS Code extension ID, npm package
 * name) pairs -- the package name is what release.yml's `vsce package`
 * names each .vsix asset after (see PACKAGE_NAME-VERSION.vsix in any
 * release). All three are version-bumped and released together by that
 * workflow, so checking one release covers all of them; only extensions
 * actually installed are ever offered an update.
 */
const KNOWN_EXTENSIONS: Array<{ id: string; packageName: string }> = [
  { id: "MatStacey.mt-devops-companion", packageName: "mt-devops-companion" },
  { id: "MatStacey.generic-dev-extension-pack", packageName: "generic-dev-extension-pack" },
  { id: "MatStacey.mt-devops-vscode-extension-pack", packageName: "mt-devops-vscode-extension-pack" },
];

const LAST_CHECK_KEY = "mtDevops.lastUpdateCheckAt";
const SKIPPED_VERSION_KEY = "mtDevops.skippedUpdateVersion";
const BACKGROUND_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "mt-devops-companion-update-checker";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface LatestRelease {
  version: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

interface OutdatedExtension {
  id: string;
  displayName: string;
  currentVersion: string;
  asset: ReleaseAsset;
}

/** Numeric major.minor.patch comparison -- this pack has never used pre-release suffixes (see release.yml's plain `vX.Y.Z` tagging), so a full semver library would be pure unused surface. */
function isNewerVersion(candidate: string, current: string): boolean {
  const c = candidate.split(".").map((n) => parseInt(n, 10) || 0);
  const cur = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(c.length, cur.length); i++) {
    const a = c[i] ?? 0;
    const b = cur[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }).on("error", reject);
  });
}

/** Downloads a URL to disk, following redirects manually -- Node's https.get doesn't auto-follow them, and GitHub release assets always redirect once to objects.githubusercontent.com. */
function downloadFile(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        const location = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          downloadFile(location, destPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const data = await httpsGetJson<{ tag_name: string; html_url: string; assets: ReleaseAsset[] }>(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
  );
  return {
    version: data.tag_name.replace(/^v/, ""),
    htmlUrl: data.html_url,
    assets: data.assets,
  };
}

function findOutdatedExtensions(release: LatestRelease): OutdatedExtension[] {
  const outdated: OutdatedExtension[] = [];
  for (const known of KNOWN_EXTENSIONS) {
    const ext = vscode.extensions.getExtension(known.id);
    if (!ext) continue;
    const currentVersion = ext.packageJSON.version as string;
    if (!isNewerVersion(release.version, currentVersion)) continue;
    const asset = release.assets.find((a) => a.name === `${known.packageName}-${release.version}.vsix`);
    if (!asset) continue;
    outdated.push({
      id: known.id,
      displayName: ext.packageJSON.displayName ?? known.packageName,
      currentVersion,
      asset,
    });
  }
  return outdated;
}

async function installFromAsset(asset: ReleaseAsset): Promise<void> {
  const tmpPath = path.join(os.tmpdir(), asset.name);
  await downloadFile(asset.browser_download_url, tmpPath);
  await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tmpPath));
}

async function offerUpdate(
  context: vscode.ExtensionContext,
  release: LatestRelease,
  outdated: OutdatedExtension[],
): Promise<void> {
  const names = outdated.map((o) => `${o.displayName} (${o.currentVersion} → ${release.version})`).join(", ");
  const choice = await vscode.window.showInformationMessage(
    `MT DevOps extension update available: ${names}.`,
    "Update Now",
    "Release Notes",
    "Skip This Version",
  );

  if (choice === "Update Now") {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Updating MT DevOps extensions..." },
      async () => {
        for (const ext of outdated) {
          await installFromAsset(ext.asset);
        }
      },
    );
    const reload = await vscode.window.showInformationMessage(
      "MT DevOps extensions updated. Reload the window to finish.",
      "Reload Now",
    );
    if (reload === "Reload Now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }

  if (choice === "Release Notes") {
    vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
    return;
  }

  if (choice === "Skip This Version") {
    await context.globalState.update(SKIPPED_VERSION_KEY, release.version);
  }
}

/**
 * Checks the latest GitHub release against every installed extension
 * from this pack, and offers to download+install (via VS Code's own
 * `workbench.extensions.installExtension` command, pointed at the
 * downloaded .vsix -- no shelling out to the `code` CLI, which isn't
 * guaranteed to be on PATH) whichever are outdated.
 *
 * `interactive` is true for the manual "Check for Updates" command
 * (always reports a result, ignores the skip flag and the TTL) and
 * false for the background check run at activation (respects both, so
 * a user who dismissed 0.9.1 isn't renagged every session, and a
 * network call doesn't happen on every single window open).
 */
export async function checkForUpdates(context: vscode.ExtensionContext, interactive: boolean): Promise<void> {
  if (!interactive) {
    const lastChecked = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - lastChecked < BACKGROUND_CHECK_INTERVAL_MS) return;
  }

  let release: LatestRelease;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (interactive) {
      vscode.window.showErrorMessage(
        `MT DevOps: couldn't check for updates -- ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  const outdated = findOutdatedExtensions(release);
  if (outdated.length === 0) {
    if (interactive) vscode.window.showInformationMessage("MT DevOps extensions are up to date.");
    return;
  }

  if (!interactive && context.globalState.get<string>(SKIPPED_VERSION_KEY) === release.version) return;

  await offerUpdate(context, release, outdated);
}
