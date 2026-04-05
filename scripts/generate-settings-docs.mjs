#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(join(__dirname, ".."));
const schemaPath = join(root, "src", "core", "settings.schema.json");
const outputPath = join(root, "docs", "configuration.generated.md");

/** @type {{properties?: Record<string, any>}} */
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const top = schema.properties ?? {};

/** @type {string[]} */
const lines = [];
lines.push("# Generated Settings Reference");
lines.push("");
lines.push("This file is generated from `src/core/settings.schema.json`.");
lines.push("");

const appendProperty = (name, descriptor, prefix = "") => {
	const key = prefix ? `${prefix}.${name}` : name;
	const type = Array.isArray(descriptor.type) ? descriptor.type.join(" | ") : descriptor.type ?? "object";
	const defaultValue =
		descriptor.default === undefined ? "`(none)`" : `\`${JSON.stringify(descriptor.default)}\``;
	const enumValue =
		Array.isArray(descriptor.enum) && descriptor.enum.length > 0
			? `\`${descriptor.enum.map((item) => String(item)).join(" | ")}\``
			: "`(any)`";
	lines.push(`## \`${key}\``);
	lines.push("");
	lines.push(`- Type: \`${type}\``);
	lines.push(`- Default: ${defaultValue}`);
	lines.push(`- Allowed values: ${enumValue}`);
	lines.push(`- Description: ${descriptor.description ?? "No description."}`);
	lines.push("");
};

for (const [name, descriptor] of Object.entries(top)) {
	appendProperty(name, descriptor);
	if (descriptor && typeof descriptor === "object" && descriptor.properties) {
		for (const [nestedName, nestedDescriptor] of Object.entries(descriptor.properties)) {
			appendProperty(nestedName, nestedDescriptor, name);
		}
	}
}

writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`Generated ${outputPath}\n`);
