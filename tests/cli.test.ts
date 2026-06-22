import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("haiflow CLI", () => {
  test("version prints the package version", async () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));
    const proc = Bun.spawn(["bun", "run", "bin/haiflow.ts", "version"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toBe(pkg.version);
  });
});
