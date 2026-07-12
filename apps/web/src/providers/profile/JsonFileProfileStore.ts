import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { settleByAbort } from "@/domain/pipeline/cachePeek";
import { systemClock, type Clock } from "@/domain/pipeline/clock";
import { MasterProfileSchema, type MasterProfile } from "@/shared/schema";
import type { ProfileLoad, ProfileStore } from "./ProfileStore";

// data/profile/master.json (decision 47). Unlike the page cache, this is
// DURABLE USER DATA: corrupt is an honest `unreadable` state (never a silent
// empty), every save is atomic (tmp + rename), and the previous file is
// copied to master.json.bak ONLY when it currently zod-parses — an unreadable
// current file moves aside to master.json.corrupt-<timestamp> instead, so the
// explicit `overwrite: true` recovery path can never destroy the last good
// .bak with corrupt bytes.

const MAIN = "master.json";

// settleByAbort maps BOTH abort and rejection to the fallback — right for
// cache peeks, wrong for a save whose disk failure must surface. Each op is
// wrapped into a settled shape first so only the abort arm becomes the
// fallback and real failures rethrow.
type Settled<T> = { ok: true; value: T } | { ok: false; err: unknown };
const ABORTED = { ok: false, err: null, aborted: true } as const;

export class JsonFileProfileStore implements ProfileStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async load(signal?: AbortSignal): Promise<ProfileLoad> {
    return this.raced(this.readState(), signal);
  }

  async save(profile: MasterProfile, signal?: AbortSignal): Promise<void> {
    return this.raced(this.writeState(profile), signal);
  }

  private async readState(): Promise<ProfileLoad> {
    let raw: string;
    try {
      raw = await readFile(this.mainPath, "utf8");
    } catch (err) {
      if (isNotFound(err)) return { kind: "empty" };
      return this.unreadable(`The profile file could not be read: ${describe(err)}`);
    }
    try {
      return { kind: "ok", profile: MasterProfileSchema.parse(JSON.parse(raw)) };
    } catch (err) {
      return this.unreadable(`The profile file is not valid: ${describe(err)}`);
    }
  }

  private async writeState(profile: MasterProfile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.protectCurrent();
    const tmp = path.join(this.dir, `${MAIN}.tmp`);
    await writeFile(tmp, JSON.stringify(profile, null, 2), "utf8");
    await rename(tmp, this.mainPath); // atomic on the same volume
  }

  /** The parse-gated .bak discipline (decision 47). */
  private async protectCurrent(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.mainPath, "utf8");
    } catch (err) {
      if (isNotFound(err)) return; // first save — nothing to protect
      // Unreadable at the fs level: move it aside like corrupt bytes. If even
      // that fails, the save fails — never rename-over a file we could not
      // safeguard.
      await this.moveAside();
      return;
    }
    try {
      MasterProfileSchema.parse(JSON.parse(raw));
    } catch {
      await this.moveAside(); // corrupt bytes must never land in .bak
      return;
    }
    await copyFile(this.mainPath, this.bakPath);
  }

  private async moveAside(): Promise<void> {
    await rename(this.mainPath, path.join(this.dir, `${MAIN}.corrupt-${this.clock.now()}`));
  }

  private raced<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    const wrapped: Promise<Settled<T>> = work.then(
      (value) => ({ ok: true, value }),
      (err: unknown) => ({ ok: false, err }),
    );
    return settleByAbort<Settled<T> | typeof ABORTED>(wrapped, ABORTED, signal).then((settled) => {
      if (settled === ABORTED) {
        throw new DOMException("The profile store operation was aborted.", "AbortError");
      }
      if (!settled.ok) throw settled.err;
      return (settled as { ok: true; value: T }).value;
    });
  }

  private unreadable(detail: string): ProfileLoad {
    return { kind: "unreadable", detail, bakPath: this.bakPath };
  }

  private get mainPath(): string {
    return path.join(this.dir, MAIN);
  }

  private get bakPath(): string {
    return path.join(this.dir, `${MAIN}.bak`);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
