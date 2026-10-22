// @effect-diagnostics nodeBuiltinImport:off - Exercises the patched AppImage install on a real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AppImageUpdater } from "electron-updater";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => vi.unstubAllEnvs());

const installAppImage = (removeInstaller: boolean) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-install-"));
  const appImage = NodePath.join(root, "T3-Code.AppImage");
  const installerPath = NodePath.join(root, "pending.AppImage");
  NodeFS.writeFileSync(appImage, "old");
  if (!removeInstaller) NodeFS.writeFileSync(installerPath, "new");
  vi.stubEnv("APPIMAGE", appImage);
  // An empty dir stands in for a dead AppImage mount: either way `mv` is not found.
  vi.stubEnv("PATH", NodePath.join(root, "empty"));
  const updater = { installerPath, spawnLog: async () => true, emit: () => true };
  try {
    AppImageUpdater.prototype["doInstall"].call(updater as unknown as AppImageUpdater, {
      isSilent: true,
      isForceRunAfter: true,
      isAdminRightsRequired: false,
    });
    return NodeFS.readdirSync(root).map((name) => [
      name,
      NodeFS.readFileSync(`${root}/${name}`, "utf8"),
    ]);
  } catch (error) {
    return {
      error: String(error),
      files: NodeFS.readdirSync(root),
      appImage: NodeFS.existsSync(appImage) ? NodeFS.readFileSync(appImage, "utf8") : null,
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

it("replaces the AppImage without a PATH lookup", () => {
  expect(installAppImage(false)).toEqual([["T3-Code.AppImage", "new"]]);
});

it("keeps the running AppImage when the swap fails", () => {
  expect(installAppImage(true)).toMatchObject({ files: ["T3-Code.AppImage"], appImage: "old" });
});
