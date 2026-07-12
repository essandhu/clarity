import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyMasterProfile, type MasterProfile } from "@/shared/schema";
import { JsonFileProfileStore } from "./JsonFileProfileStore";

const NOW = 1_700_000_000_000;
const fakeClock = { now: () => NOW };

function profile(name: string): MasterProfile {
  return emptyMasterProfile(name, new Date(NOW).toISOString());
}

let dir: string;
let store: JsonFileProfileStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "clarity-profile-"));
  store = new JsonFileProfileStore(dir, fakeClock);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonFileProfileStore", () => {
  it("reports empty when no file exists — never unreadable", async () => {
    expect(await store.load()).toEqual({ kind: "empty" });
  });

  it("round-trips a saved profile", async () => {
    const saved = profile("Maya Chen");
    await store.save(saved);
    const loaded = await store.load();
    expect(loaded).toEqual({ kind: "ok", profile: saved });
  });

  it("reports corrupt bytes as unreadable naming the .bak path — never empty", async () => {
    await writeFile(path.join(dir, "master.json"), "{ not json", "utf8");
    const loaded = await store.load();
    expect(loaded.kind).toBe("unreadable");
    if (loaded.kind !== "unreadable") return;
    expect(loaded.detail).toContain("not valid");
    expect(loaded.bakPath).toBe(path.join(dir, "master.json.bak"));
  });

  it("reports schema-invalid JSON as unreadable (durable data is never silently discarded)", async () => {
    await writeFile(path.join(dir, "master.json"), JSON.stringify({ version: 2 }), "utf8");
    expect((await store.load()).kind).toBe("unreadable");
  });

  it("copies the previous GOOD file to .bak before renaming over it", async () => {
    const first = profile("First Save");
    const second = profile("Second Save");
    await store.save(first);
    await store.save(second);
    const bak = JSON.parse(await readFile(path.join(dir, "master.json.bak"), "utf8")) as unknown;
    expect(bak).toEqual(first);
    const main = JSON.parse(await readFile(path.join(dir, "master.json"), "utf8")) as unknown;
    expect(main).toEqual(second);
  });

  it("a corrupted main file round-trips from the .bak", async () => {
    const good = profile("Recoverable");
    await store.save(good);
    await store.save(profile("Newer"));
    // The .bak now holds `good`. Corrupt the main file and restore by hand —
    // the documented recovery path the unreadable-state UI copy names.
    await writeFile(path.join(dir, "master.json"), "corrupted!!", "utf8");
    const bakBytes = await readFile(path.join(dir, "master.json.bak"), "utf8");
    await writeFile(path.join(dir, "master.json"), bakBytes, "utf8");
    const loaded = await store.load();
    expect(loaded).toEqual({ kind: "ok", profile: good });
  });

  it("recovery-path protection: overwriting a corrupt main file leaves the good .bak byte-intact", async () => {
    const good = profile("The Good Backup");
    await store.save(good);
    await store.save(profile("Later Save")); // .bak = good
    const bakBefore = await readFile(path.join(dir, "master.json.bak"), "utf8");
    await writeFile(path.join(dir, "master.json"), "corrupt bytes", "utf8");

    // The explicit overwrite:true recovery save (decision 47): corrupt bytes
    // must move aside, NEVER into .bak.
    await store.save(profile("Recovery Save"));

    const bakAfter = await readFile(path.join(dir, "master.json.bak"), "utf8");
    expect(bakAfter).toBe(bakBefore);
    const aside = await readFile(path.join(dir, `master.json.corrupt-${NOW}`), "utf8");
    expect(aside).toBe("corrupt bytes");
    const main = JSON.parse(await readFile(path.join(dir, "master.json"), "utf8")) as unknown;
    expect(main).toEqual(profile("Recovery Save"));
  });

  it("leaves no .tmp file behind after a save (atomic rename)", async () => {
    await store.save(profile("Tidy"));
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("an aborted signal settles store I/O promptly as an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(store.save(profile("Never Lands"), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(store.load(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a real disk failure still surfaces as an error, not a silent success", async () => {
    // Point the store at a path whose parent is a FILE — mkdir must fail.
    const blocked = path.join(dir, "master.json"); // will be a file
    await writeFile(blocked, "occupied", "utf8");
    const badStore = new JsonFileProfileStore(path.join(blocked, "nested"), fakeClock);
    await expect(badStore.save(profile("Doomed"))).rejects.toBeTruthy();
  });
});
