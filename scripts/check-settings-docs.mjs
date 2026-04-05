#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(join(__dirname, ".."));
const outputPath = join(root, "docs", "configuration.generated.md");
const before = readFileSync(outputPath, "utf8");

const run = spawnSync("node", [join(root, "scripts", "generate-settings-docs.mjs")], {
	encoding: "utf8",
});
if (run.status !== 0) {
	process.stderr.write(run.stderr || run.stdout || "Failed to generate settings docs.\n");
	process.exit(run.status ?? 1);
}

const after = readFileSync(outputPath, "utf8");
if (before !== after) {
	process.stderr.write("Settings docs are out of sync with schema.\n");
	process.exit(1);
}
process.stdout.write("Settings docs are in sync with schema.\n");
