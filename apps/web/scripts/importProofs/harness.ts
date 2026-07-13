// Shared PASS/FAIL harness for the try-import.ts proof modes (pre-split
// under the script-size convention; the try-cache.ts precedent).

const t0 = Date.now();
export const at = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
export const elapsedSeconds = (): number => (Date.now() - t0) / 1000;

export const checks: { name: string; pass: boolean; detail?: string }[] = [];

export function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`[${at()}] ${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

export function finish(): void {
  const failed = checks.filter((entry) => !entry.pass);
  console.log(JSON.stringify({ checks: checks.length, failed: failed.map((f) => f.name) }, null, 2));
  // exitCode, not exit(): a hard exit races undici's socket teardown on
  // Windows (libuv UV_HANDLE_CLOSING assert) and turns a green run into 127.
  process.exitCode = failed.length === 0 ? 0 : 1;
}
