// @effect-diagnostics nodeBuiltinImport:off -- The AppImage install swaps files synchronously inside electron-updater's quitAndInstall.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, type AppUpdater, autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;

// electron-updater deletes the running AppImage, then moves the download in with a
// PATH-resolved `mv`. When that `mv` fails (ENOTCONN from a dead AppImage mount on PATH)
// no app is left to launch. Rename over it instead, staged beside the destination so the
// rename stays on one filesystem and the old AppImage survives any failure.
export class AtomicAppImageUpdater extends AppImageUpdater {
  protected override doInstall(options: Parameters<AppImageUpdater["doInstall"]>[0]): boolean {
    const appImage = process.env.APPIMAGE;
    const installerPath = this.installerPath;
    // Upstream throws on a missing or relative APPIMAGE before it touches any file.
    if (appImage === undefined || !NodePath.isAbsolute(appImage)) {
      return super.doInstall(options);
    }
    if (installerPath === null) {
      this.dispatchError(new Error("No update filepath provided, can't quit and install"));
      return false;
    }
    const name = NodePath.basename(appImage);
    // A versioned file name follows the download; a custom one is kept (electron-builder#2964).
    const destination =
      NodePath.basename(installerPath) === name || !/\d+\.\d+\.\d+/u.test(name)
        ? appImage
        : NodePath.join(NodePath.dirname(appImage), NodePath.basename(installerPath));
    const staged = NodePath.join(NodePath.dirname(destination), `.${name}.update`);
    NodeFS.rmSync(staged, { force: true });
    try {
      try {
        NodeFS.linkSync(installerPath, staged);
      } catch {
        NodeFS.copyFileSync(installerPath, staged);
      }
      NodeFS.renameSync(staged, destination);
    } catch (error) {
      NodeFS.rmSync(staged, { force: true });
      throw error;
    }
    NodeFS.rmSync(installerPath, { force: true });
    if (destination !== appImage) {
      NodeFS.rmSync(appImage, { force: true });
      this.emit("appimage-filename-updated", destination);
    }
    const env = { ...process.env, APPIMAGE_SILENT_INSTALL: "true" };
    if (options.isForceRunAfter) {
      void this.spawnLog(destination, [], env);
    } else {
      NodeChildProcess.execFileSync(destination, [], {
        env: { ...env, APPIMAGE_EXIT_AFTER_INSTALL: "true" },
      });
    }
    return true;
  }
}

let selectedUpdater: AppUpdater | undefined;
const updater = () =>
  (selectedUpdater ??=
    autoUpdater instanceof AppImageUpdater ? new AtomicAppImageUpdater() : autoUpdater);

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (options) =>
    Effect.suspend(() => {
      updater().setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      updater().autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      updater().autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      updater().channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      updater().allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => updater().allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      updater().allowDowngrade = value;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      updater().fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      updater().disableDifferentialDownload = value;
      return Effect.void;
    }),
  checkForUpdates: Effect.suspend(() => {
    const channel = updater().channel;
    return Effect.tryPromise({
      try: () => updater().checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = updater().channel;
    return Effect.tryPromise({
      try: () => updater().downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.suspend(() => {
      const channel = updater().channel;
      return Effect.try({
        try: () => updater().quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
  on: (eventName, listener) => {
    const eventTarget = updater() as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  },
});

export const layer = Layer.succeed(ElectronUpdater, make);
