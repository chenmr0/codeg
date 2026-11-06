import { fork } from "node:child_process";
import * as path from "node:path";
import type { SyncOptions } from "../../index";
import type { SyncResult, IndexProgress } from "../../extraction";
import { resolvedSyncPolicy } from "../sync-policy";
/** The child owns writer admission from planning to publication. Cancellation
 * completes only after child exit, including all its native workers. */
export function runPortableRebuild(
  root: string,
  dataDir: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const policy = options[resolvedSyncPolicy];
  if (!policy?.enabled) return Promise.reject(new Error("Background rebuild requires an enabled sync policy snapshot"));
  return new Promise((resolve, reject) => {
    const child = fork(
      path.join(__dirname, "publisher-worker.js"),
      [root, dataDir],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: process.execArgv.filter(
          (arg) =>
            arg === "--liftoff-only" ||
            /^--max[-_]old[-_]space[-_]size=\d+$/.test(arg),
        ),
        env: { ...process.env, CODEGRAPH_ADAPTIVE_CHILD: "1" },
      },
    );
    let result: SyncResult | undefined,
      failure: Error | undefined,
      stderr = "";
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
      timer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      timer.unref();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", (error) => {
      failure = error;
    });
    child.on(
      "message",
      (message: {
        type: string;
        result?: SyncResult;
        progress?: IndexProgress;
        error?: string;
      }) => {
        if (message.type === "result") result = message.result;
        if (message.type === "error") failure = new Error(message.error);
        if (message.type === "progress" && message.progress) {
          try {
            options.onProgress?.(message.progress);
          } catch (error) {
            failure = error as Error;
            cancel();
          }
        }
      },
    );
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", cancel);
      if (timer) clearTimeout(timer);
      if (cancelled || failure || code !== 0 || !result)
        reject(
          failure ??
            new Error(
              cancelled
                ? "Background rebuild cancelled"
                : `Background rebuild exited ${code}: ${stderr}`,
            ),
        );
      else resolve(result);
    });
    child.send({
      policy,
      parentExecArgv: [...process.execArgv],
    });
    if (options.signal?.aborted) cancel();
  });
}
