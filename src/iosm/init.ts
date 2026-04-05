import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { promises as fsPromises } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { IosmConfig } from "./config.js";
import { loadIosmConfig } from "./config.js";
import {
	calculateDecisionConfidence,
	calculateIosmIndex,
	calculateIosmMetricsFromRawMeasurements,
	createMetricRecord,
	hasCompleteNumericMetricRecord,
	hasCompleteTierMetricRecord,
	IOSM_METRICS,
} from "./metrics.js";
import {
	listIosmCycles,
	planIosmCycle,
	recordIosmCycleHistory,
	type IosmCycleListItem,
	type PlannedIosmCycle,
} from "./cycle.js";
import { writeAgentsGuideDocument, writeIosmGuideDocument } from "./guide.js";
import {
	getIosmBaselineReportPath,
	getIosmBaselinesDir,
	getIosmConfigPath,
	getIosmContractCatalogPath,
	getIosmCycleDir,
	getIosmCycleReportPath,
	getIosmCyclesDir,
	getIosmDecisionLogPath,
	getIosmHypothesesPath,
	getIosmInvariantCatalogPath,
	getIosmMetricsHistoryPath,
	getIosmPatternLibraryPath,
	getIosmPhaseReportPath,
	getIosmWaiverRegisterPath,
	getIosmWorkspaceDir,
} from "./paths.js";
import type {
	IosmBaselineReport,
	IosmCycleReport,
	IosmCycleScope,
	IosmEvidenceTier,
	IosmMetric,
	IosmMetricRecord,
	IosmPhase,
} from "./types.js";
import { IOSM_PHASES } from "./types.js";
const MAX_ANALYZED_FILES = 6000;
const MAX_TEXT_FILE_BYTES = 1_000_000;

const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"target",
	"vendor",
	".idea",
	".vscode",
	".iosm",
]);

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".cs",
	".rb",
	".php",
	".swift",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".sh",
	".sql",
]);

const TEXT_CONFIG_EXTENSIONS = new Set([
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".txt",
	".ini",
	".env",
	".xml",
]);

const KNOWN_TEXT_BASENAMES = new Set([
	"Dockerfile",
	"Makefile",
	"README",
	"README.md",
	"README.txt",
	"LICENSE",
	".gitignore",
	"package.json",
	"pnpm-workspace.yaml",
	"bun.lockb",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"requirements.txt",
	"composer.json",
	"Gemfile",
	"pom.xml",
]);

const EXTENSION_TO_LANGUAGE = new Map<string, string>([
	[".ts", "TypeScript"],
	[".tsx", "TypeScript"],
	[".js", "JavaScript"],
	[".jsx", "JavaScript"],
	[".mjs", "JavaScript"],
	[".cjs", "JavaScript"],
	[".py", "Python"],
	[".go", "Go"],
	[".rs", "Rust"],
	[".java", "Java"],
	[".kt", "Kotlin"],
	[".kts", "Kotlin"],
	[".cs", "C#"],
	[".rb", "Ruby"],
	[".php", "PHP"],
	[".swift", "Swift"],
	[".c", "C/C++"],
	[".cc", "C/C++"],
	[".cpp", "C/C++"],
	[".h", "C/C++"],
	[".hpp", "C/C++"],
	[".sql", "SQL"],
	[".sh", "Shell"],
]);

const PRIMARY_SERVICE_DIRS = new Set(["services", "apps", "api", "server", "backend", "workers", "worker"]);
const DOMAIN_HINTS = ["domain", "core", "billing", "payment", "checkout", "auth", "identity", "user", "order"];

type UnknownRecord = Record<string, unknown>;

interface ProjectFileSample {
	path: string;
	lines: number;
	bytes: number;
	extension: string;
	basename: string;
}

interface LanguageStat {
	language: string;
	files: number;
	lines: number;
}

interface ContractSignal {
	kind: string;
	path: string;
	description: string;
}

interface ProjectSignals {
	filesAnalyzed: number;
	sourceFileCount: number;
	testFileCount: number;
	docFileCount: number;
	topLanguages: LanguageStat[];
	modules: string[];
	services: string[];
	domains: string[];
	contracts: ContractSignal[];
	sourceSystems: string[];
	testRatio: number;
	docsRatio: number;
	namingConsistency: number;
	dependencyCount: number;
	hasCiSignals: boolean;
}

interface InitialCycleSummary {
	cycleId: string;
	cycleDir: string;
	reportPath: string;
	baselineReportPath: string;
	hypothesesPath: string;
	reusedExistingCycle: boolean;
}

export interface IosmInitOptions {
	cwd?: string;
	force?: boolean;
}

export interface IosmInitAnalysis {
	generated_at: string;
	files_analyzed: number;
	source_file_count: number;
	test_file_count: number;
	doc_file_count: number;
	top_languages: LanguageStat[];
	cycle_scope: IosmCycleScope;
	detected_contracts: ContractSignal[];
	source_systems: string[];
	goals: string[];
	raw_measurements: Record<string, unknown>;
	metrics: IosmMetricRecord<number | null>;
	metric_confidences: IosmMetricRecord<number>;
	metric_tiers: IosmMetricRecord<IosmEvidenceTier>;
}

export interface IosmInitResult {
	rootDir: string;
	created: string[];
	overwritten: string[];
	skipped: string[];
	analysis: IosmInitAnalysis;
	cycle?: InitialCycleSummary;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function pushUnique(target: string[], value: string): void {
	if (!target.includes(value)) {
		target.push(value);
	}
}

function markPathByExistence(filePath: string, existedBefore: boolean, result: IosmInitResult): void {
	if (existedBefore) {
		pushUnique(result.overwritten, filePath);
	} else {
		pushUnique(result.created, filePath);
	}
}

function isTestPath(path: string): boolean {
	const normalized = path.toLowerCase();
	return (
		normalized.includes("/__tests__/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/test/") ||
		normalized.endsWith(".test.ts") ||
		normalized.endsWith(".test.tsx") ||
		normalized.endsWith(".test.js") ||
		normalized.endsWith(".test.jsx") ||
		normalized.endsWith(".spec.ts") ||
		normalized.endsWith(".spec.tsx") ||
		normalized.endsWith(".spec.js") ||
		normalized.endsWith(".spec.jsx") ||
		normalized.endsWith("_test.go") ||
		normalized.includes("/spec/") ||
		normalized.includes("/specs/")
	);
}

function isDocPath(path: string): boolean {
	const normalized = path.toLowerCase();
	return (
		normalized === "readme.md" ||
		normalized.startsWith("docs/") ||
		normalized.endsWith(".md") ||
		normalized.endsWith(".mdx")
	);
}

function isBinaryBuffer(buffer: Buffer): boolean {
	const sampleLength = Math.min(buffer.length, 4096);
	for (let index = 0; index < sampleLength; index++) {
		if (buffer[index] === 0) {
			return true;
		}
	}
	return false;
}

function shouldIgnoreDirectory(name: string): boolean {
	if (IGNORED_DIRECTORIES.has(name)) {
		return true;
	}
	if (name.startsWith(".")) {
		return name !== ".github";
	}
	return false;
}

function isPotentialTextFile(filePath: string, extension: string, basenameValue: string): boolean {
	if (SOURCE_EXTENSIONS.has(extension) || TEXT_CONFIG_EXTENSIONS.has(extension)) {
		return true;
	}
	if (KNOWN_TEXT_BASENAMES.has(basenameValue)) {
		return true;
	}
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".proto") || lower.endsWith(".graphql") || lower.endsWith(".gql")) {
		return true;
	}
	return false;
}

function collectProjectFiles(rootDir: string): ProjectFileSample[] {
	const files: ProjectFileSample[] = [];
	const queue: string[] = [rootDir];

	while (queue.length > 0 && files.length < MAX_ANALYZED_FILES) {
		const current = queue.shift();
		if (!current) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (files.length >= MAX_ANALYZED_FILES) {
				break;
			}

			const absolutePath = join(current, entry.name);
			const relativePath = relative(rootDir, absolutePath).split("\\").join("/");

			if (entry.isDirectory()) {
				if (!shouldIgnoreDirectory(entry.name)) {
					queue.push(absolutePath);
				}
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const extension = extname(entry.name).toLowerCase();
			if (!isPotentialTextFile(relativePath, extension, entry.name)) {
				continue;
			}

			let bytes = 0;
			try {
				bytes = statSync(absolutePath).size;
			} catch {
				continue;
			}

			if (bytes > MAX_TEXT_FILE_BYTES) {
				continue;
			}

			let contentBuffer: Buffer;
			try {
				contentBuffer = readFileSync(absolutePath);
			} catch {
				continue;
			}

			if (isBinaryBuffer(contentBuffer)) {
				continue;
			}

			const content = contentBuffer.toString("utf8");
			const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;

			files.push({
				path: relativePath,
				lines,
				bytes,
				extension,
				basename: entry.name,
			});
		}
	}

	return files;
}

// Concurrency-limited Promise.all using a simple semaphore
async function withConcurrencyLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<unknown>
): Promise<void> {
	const executing: Promise<unknown>[] = [];
	for (const item of items) {
		const p: Promise<unknown> = fn(item).then(() => executing.splice(executing.indexOf(p), 1));
		executing.push(p);
		if (executing.length >= limit) await Promise.race(executing);
	}
	await Promise.all(executing);
}

export async function collectProjectFilesAsync(rootDir: string): Promise<ProjectFileSample[]> {
	const files: ProjectFileSample[] = [];
	const queue: string[] = [rootDir];

	while (queue.length > 0 && files.length < MAX_ANALYZED_FILES) {
		const currentBatch = queue.splice(0, queue.length);
		const pendingFiles: Array<{ absolutePath: string; relativePath: string; extension: string; entryName: string }> = [];

		await Promise.all(
			currentBatch.map(async (current) => {
				let entries: Dirent[];
				try {
					entries = await fsPromises.readdir(current, { withFileTypes: true });
				} catch {
					return;
				}

				for (const entry of entries) {
					if (files.length >= MAX_ANALYZED_FILES) {
						break;
					}

					const absolutePath = join(current, entry.name);
					const relativePath = relative(rootDir, absolutePath).split("\\").join("/");

					if (entry.isDirectory()) {
						if (!shouldIgnoreDirectory(entry.name)) {
							queue.push(absolutePath);
						}
						continue;
					}

					if (!entry.isFile()) {
						continue;
					}

					const extension = extname(entry.name).toLowerCase();
					if (!isPotentialTextFile(relativePath, extension, entry.name)) {
						continue;
					}

					pendingFiles.push({ absolutePath, relativePath, extension, entryName: entry.name });
				}
			}),
		);

		await withConcurrencyLimit(pendingFiles, 10, async ({ absolutePath, relativePath, extension, entryName }) => {
			if (files.length >= MAX_ANALYZED_FILES) {
				return;
			}

			let bytes = 0;
			try {
				bytes = (await fsPromises.stat(absolutePath)).size;
			} catch {
				return;
			}

			if (bytes > MAX_TEXT_FILE_BYTES) {
				return;
			}

			let contentBuffer: Buffer;
			try {
				contentBuffer = Buffer.from(await fsPromises.readFile(absolutePath));
			} catch {
				return;
			}

			if (isBinaryBuffer(contentBuffer)) {
				return;
			}

			const content = contentBuffer.toString("utf8");
			const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;

			if (files.length < MAX_ANALYZED_FILES) {
				files.push({
					path: relativePath,
					lines,
					bytes,
					extension,
					basename: entryName,
				});
			}
		});
	}

	return files;
}

function toMetricTier(confidence: number): IosmEvidenceTier {
	if (confidence >= 0.85) {
		return "A";
	}
	if (confidence >= 0.65) {
		return "B";
	}
	return "C";
}

function detectContractSignals(files: ProjectFileSample[]): ContractSignal[] {
	const contracts: ContractSignal[] = [];
	for (const file of files) {
		const normalized = file.path.toLowerCase();
		if (normalized.endsWith(".proto")) {
			contracts.push({
				kind: "protobuf",
				path: file.path,
				description: "Protocol buffer service or schema",
			});
			continue;
		}

		if (normalized.endsWith(".graphql") || normalized.endsWith(".gql")) {
			contracts.push({
				kind: "graphql",
				path: file.path,
				description: "GraphQL schema contract",
			});
			continue;
		}

		if (
			(normalized.includes("openapi") || normalized.includes("swagger")) &&
			(normalized.endsWith(".yaml") || normalized.endsWith(".yml") || normalized.endsWith(".json"))
		) {
			contracts.push({
				kind: "openapi",
				path: file.path,
				description: "OpenAPI/Swagger API contract",
			});
			continue;
		}

		if (normalized.includes("/contracts/") || normalized.includes("contract")) {
			if (
				normalized.endsWith(".yaml") ||
				normalized.endsWith(".yml") ||
				normalized.endsWith(".json") ||
				normalized.endsWith(".md")
			) {
				contracts.push({
					kind: "custom",
					path: file.path,
					description: "Repository contract declaration",
				});
			}
		}
	}

	const unique = new Map<string, ContractSignal>();
	for (const contract of contracts) {
		const key = `${contract.kind}:${contract.path}`;
		if (!unique.has(key)) {
			unique.set(key, contract);
		}
	}

	return Array.from(unique.values()).slice(0, 20);
}

function detectTopModules(files: ProjectFileSample[]): {
	modules: string[];
	services: string[];
	domains: string[];
} {
	const moduleWeights = new Map<string, number>();
	const serviceWeights = new Map<string, number>();
	const domainCandidates = new Set<string>();

	for (const file of files) {
		if (!SOURCE_EXTENSIONS.has(file.extension) || isTestPath(file.path)) {
			continue;
		}

		const segments = file.path.split("/").filter((segment) => segment.length > 0);
		if (segments.length === 0) {
			continue;
		}

		if (segments[0] === "src" && segments.length >= 2) {
			const moduleName = segments[1];
			moduleWeights.set(moduleName, (moduleWeights.get(moduleName) ?? 0) + file.lines + 1);
			if (DOMAIN_HINTS.some((hint) => moduleName.toLowerCase().includes(hint))) {
				domainCandidates.add(moduleName);
			}
		}

		if (segments.length >= 2 && (segments[0] === "packages" || segments[0] === "modules")) {
			const moduleName = `${segments[0]}/${segments[1]}`;
			moduleWeights.set(moduleName, (moduleWeights.get(moduleName) ?? 0) + file.lines + 1);
		}

		if (PRIMARY_SERVICE_DIRS.has(segments[0])) {
			const serviceName = segments[1] ? `${segments[0]}/${segments[1]}` : segments[0];
			serviceWeights.set(serviceName, (serviceWeights.get(serviceName) ?? 0) + file.lines + 1);
			if (segments[1] && DOMAIN_HINTS.some((hint) => segments[1].toLowerCase().includes(hint))) {
				domainCandidates.add(segments[1]);
			}
		}
	}

	const sortByWeight = (weights: Map<string, number>, limit: number): string[] =>
		Array.from(weights.entries())
			.sort((left, right) => right[1] - left[1])
			.map(([name]) => name)
			.slice(0, limit);

	const modules = sortByWeight(moduleWeights, 12);
	const services = sortByWeight(serviceWeights, 8);
	let domains = Array.from(domainCandidates).slice(0, 8);

	if (domains.length === 0) {
		domains = modules
			.map((moduleName) => moduleName.split("/").pop() ?? moduleName)
			.filter((entry) => entry.length > 0)
			.slice(0, 6);
	}

	return { modules, services, domains };
}

function detectDependencyCount(rootDir: string): number {
	const packageJsonPath = join(rootDir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return 0;
	}

	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as UnknownRecord;
		const dependencies = parsed.dependencies;
		const devDependencies = parsed.devDependencies;
		const depCount = dependencies && typeof dependencies === "object" ? Object.keys(dependencies as UnknownRecord).length : 0;
		const devDepCount =
			devDependencies && typeof devDependencies === "object"
				? Object.keys(devDependencies as UnknownRecord).length
				: 0;
		return depCount + devDepCount;
	} catch {
		return 0;
	}
}

function detectSourceSystems(rootDir: string, files: ProjectFileSample[], topLanguages: LanguageStat[]): string[] {
	const systems: string[] = [];
	const lowerPaths = new Set(files.map((file) => file.path.toLowerCase()));

	if (lowerPaths.has("package.json")) {
		systems.push("npm");
	}
	if (lowerPaths.has("pnpm-workspace.yaml")) {
		systems.push("pnpm-workspace");
	}
	if (lowerPaths.has("go.mod")) {
		systems.push("go-mod");
	}
	if (lowerPaths.has("cargo.toml")) {
		systems.push("cargo");
	}
	if (lowerPaths.has("pyproject.toml") || lowerPaths.has("requirements.txt")) {
		systems.push("python-packaging");
	}

	if (existsSync(join(rootDir, ".github", "workflows"))) {
		systems.push("github-actions");
	}

	for (const language of topLanguages.slice(0, 3)) {
		systems.push(`lang:${language.language}`);
	}

	return Array.from(new Set(systems));
}

function computeNamingConsistency(files: ProjectFileSample[]): number {
	let kebab = 0;
	let snake = 0;
	let camel = 0;
	let other = 0;

	for (const file of files) {
		if (!SOURCE_EXTENSIONS.has(file.extension) || isTestPath(file.path)) {
			continue;
		}
		const baseWithoutExt = file.basename.replace(/\.[^.]+$/, "");
		if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(baseWithoutExt)) {
			kebab += 1;
		} else if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(baseWithoutExt)) {
			snake += 1;
		} else if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(baseWithoutExt)) {
			camel += 1;
		} else {
			other += 1;
		}
	}

	const total = kebab + snake + camel + other;
	if (total === 0) {
		return 0.65;
	}

	const dominant = Math.max(kebab, snake, camel, 0);
	const consistency = dominant / total;
	return round3(clamp01(0.45 + consistency * 0.5));
}

async function deriveProjectSignals(rootDir: string): Promise<ProjectSignals> {
	const files = await collectProjectFilesAsync(rootDir);

	const languageAccumulator = new Map<string, { files: number; lines: number }>();
	let sourceFileCount = 0;
	let testFileCount = 0;
	let docFileCount = 0;
	let hasCiSignals = false;

	for (const file of files) {
		if (isDocPath(file.path)) {
			docFileCount += 1;
		}
		if (file.path.toLowerCase().startsWith(".github/workflows/")) {
			hasCiSignals = true;
		}
		if (!SOURCE_EXTENSIONS.has(file.extension)) {
			continue;
		}

		sourceFileCount += 1;
		if (isTestPath(file.path)) {
			testFileCount += 1;
		}

		const language = EXTENSION_TO_LANGUAGE.get(file.extension) ?? "Other";
		const current = languageAccumulator.get(language) ?? { files: 0, lines: 0 };
		current.files += 1;
		current.lines += file.lines;
		languageAccumulator.set(language, current);
	}

	const topLanguages = Array.from(languageAccumulator.entries())
		.sort((left, right) => right[1].lines - left[1].lines)
		.map(([language, stats]) => ({
			language,
			files: stats.files,
			lines: stats.lines,
		}))
		.slice(0, 6);

	const { modules, services, domains } = detectTopModules(files);
	const contracts = detectContractSignals(files);
	const dependencyCount = detectDependencyCount(rootDir);
	const namingConsistency = computeNamingConsistency(files);
	const testRatio = sourceFileCount === 0 ? 0 : clamp01(testFileCount / Math.max(sourceFileCount, 1));
	const docsRatio = files.length === 0 ? 0 : clamp01(docFileCount / Math.max(files.length, 1));
	const sourceSystems = detectSourceSystems(rootDir, files, topLanguages);

	return {
		filesAnalyzed: files.length,
		sourceFileCount,
		testFileCount,
		docFileCount,
		topLanguages,
		modules,
		services,
		domains,
		contracts,
		sourceSystems,
		testRatio,
		docsRatio,
		namingConsistency,
		dependencyCount,
		hasCiSignals,
	};
}

function buildCycleScope(signals: ProjectSignals, maxScopeItems: number): IosmCycleScope {
	const scoped: IosmCycleScope = {
		modules: [],
		services: [],
		domains: [],
		contracts: [],
		rationale: "Auto-filled from repository structure during iosm init.",
	};

	let total = 0;
	const append = (key: "modules" | "services" | "domains" | "contracts", values: string[]) => {
		for (const value of values) {
			if (total >= maxScopeItems) {
				return;
			}
			if (!scoped[key].includes(value)) {
				scoped[key].push(value);
				total += 1;
			}
		}
	};

	append("modules", signals.modules.slice(0, 8));
	append("services", signals.services.slice(0, 6));
	append(
		"domains",
		signals.domains
			.map((domain) => domain.split("/").pop() ?? domain)
			.filter((domain) => domain.length > 0)
			.slice(0, 6),
	);
	append(
		"contracts",
		signals.contracts
			.map((contract) => contract.path)
			.slice(0, 4),
	);

	if (total === 0) {
		scoped.modules = ["repository"];
		total = 1;
	}

	const sourceLines = [`scope_items=${total}`, `max_scope_items=${maxScopeItems}`];
	if (signals.modules.length > scoped.modules.length) {
		sourceLines.push(`modules_truncated=${signals.modules.length - scoped.modules.length}`);
	}
	if (signals.services.length > scoped.services.length) {
		sourceLines.push(`services_truncated=${signals.services.length - scoped.services.length}`);
	}
	scoped.rationale = `Auto-filled from repository structure (${sourceLines.join(", ")}).`;

	return scoped;
}

function buildRawMeasurements(signals: ProjectSignals): Record<string, unknown> {
	const moduleCount = Math.max(signals.modules.length, 1);
	const contractCount = signals.contracts.length;
	const docsSignal = clamp01(0.25 + signals.docsRatio * 2.2 + (signals.docFileCount > 0 ? 0.1 : 0));
	const ciBoost = signals.hasCiSignals ? 0.12 : 0;

	const semanticGlossaryCoverage = round3(clamp01(0.45 + docsSignal * 0.45));
	const semanticNamingConsistency = round3(clamp01(signals.namingConsistency));
	const semanticAmbiguityRatio = round3(clamp01(0.35 - docsSignal * 0.2));

	const logicInvariantPassRate = round3(clamp01(0.52 + signals.testRatio * 0.4 + ciBoost * 0.3));
	const inferredInvariantCount = Math.max(3, Math.min(10, moduleCount + (contractCount > 0 ? 1 : 0)));

	const performanceLatencyScore = round3(clamp01(0.48 + signals.testRatio * 0.22 + ciBoost));
	const performanceReliabilityScore = round3(clamp01(0.58 + signals.testRatio * 0.2 + ciBoost));
	const performanceResilienceScore = round3(clamp01(0.5 + (contractCount > 0 ? 0.08 : 0) + signals.testRatio * 0.18));

	const simplicityApiSurfaceScore = round3(clamp01(1 - Math.min(0.65, moduleCount / 22)));
	const simplicityDependencyHygiene = round3(clamp01(1 - Math.min(0.7, signals.dependencyCount / 140)));
	const simplicityOnboardingScore = round3(clamp01(0.48 + docsSignal * 0.45));

	const modularityCouplingScore = round3(clamp01(1 - Math.min(0.72, moduleCount / 20)));
	const modularityCohesionScore = round3(clamp01(0.46 + Math.min(0.24, 1 / moduleCount) + (contractCount > 0 ? 0.12 : 0)));
	const modularityContractScore = round3(contractCount > 0 ? 1 : 0.58);
	const modularityChangeSurfaceScore = round3(clamp01(1 - Math.min(0.82, moduleCount / 18)));
	const modularityChangeSurface = Math.max(1, Math.min(12, moduleCount));

	const flowLeadTimeScore = round3(clamp01(0.45 + signals.testRatio * 0.2 + ciBoost));
	const flowDeployFrequencyScore = round3(clamp01(0.4 + ciBoost + signals.docsRatio * 0.08));
	const flowChangeFailureScore = round3(clamp01(0.62 + signals.testRatio * 0.25));
	const flowReviewLatencyScore = round3(clamp01(0.5 + ciBoost + signals.docsRatio * 0.1));

	return {
		semantic: {
			glossary_coverage: semanticGlossaryCoverage,
			naming_consistency: semanticNamingConsistency,
			ambiguity_ratio: semanticAmbiguityRatio,
		},
		logic: {
			invariant_pass_rate: logicInvariantPassRate,
			passed_invariants: Math.round(inferredInvariantCount * logicInvariantPassRate),
			total_invariants: inferredInvariantCount,
		},
		performance: {
			latency_score: performanceLatencyScore,
			reliability_score: performanceReliabilityScore,
			resilience_score: performanceResilienceScore,
			error_budget_respected: performanceReliabilityScore >= 0.7,
		},
		simplicity: {
			api_surface_score: simplicityApiSurfaceScore,
			dependency_hygiene: simplicityDependencyHygiene,
			onboarding_score: simplicityOnboardingScore,
		},
		modularity: {
			coupling_score: modularityCouplingScore,
			cohesion_score: modularityCohesionScore,
			contract_score: modularityContractScore,
			change_surface_score: modularityChangeSurfaceScore,
			change_surface: modularityChangeSurface,
			contracts_pass: modularityContractScore >= 0.8,
		},
		flow: {
			lead_time_score: flowLeadTimeScore,
			deploy_frequency_score: flowDeployFrequencyScore,
			change_failure_score: flowChangeFailureScore,
			review_latency_score: flowReviewLatencyScore,
		},
	};
}

function buildMetricConfidences(signals: ProjectSignals): IosmMetricRecord<number> {
	const docsConfidence = clamp01(0.52 + signals.docsRatio * 0.35);
	const testConfidence = clamp01(0.5 + signals.testRatio * 0.4 + (signals.hasCiSignals ? 0.08 : 0));
	const dependencyConfidence = clamp01(0.55 + (signals.dependencyCount > 0 ? 0.12 : 0));

	return {
		semantic: round3(clamp01(docsConfidence)),
		logic: round3(clamp01(testConfidence)),
		performance: round3(clamp01(0.52 + signals.testRatio * 0.22 + (signals.hasCiSignals ? 0.1 : 0))),
		simplicity: round3(clamp01(Math.max(docsConfidence, dependencyConfidence - 0.05))),
		modularity: round3(clamp01(0.56 + (signals.modules.length > 0 ? 0.08 : 0) + (signals.contracts.length > 0 ? 0.08 : 0))),
		flow: round3(clamp01(0.48 + (signals.hasCiSignals ? 0.14 : 0))),
	};
}

function goalForMetric(metric: IosmMetric): string {
	switch (metric) {
		case "semantic":
			return "Increase glossary coverage and naming consistency for core domain language.";
		case "logic":
			return "Increase invariant/test confidence for critical logic paths and edge cases.";
		case "performance":
			return "Improve latency and reliability signals for primary user journeys.";
		case "simplicity":
			return "Reduce onboarding friction by shrinking API/dependency surface complexity.";
		case "modularity":
			return "Reduce coupling and change surface while strengthening contract boundaries.";
		case "flow":
			return "Improve lead-time and review-latency flow signals for safer delivery cadence.";
	}
}

function buildGoals(metrics: IosmMetricRecord<number | null>): string[] {
	const ordered = IOSM_METRICS.map((metric) => ({ metric, value: metrics[metric] ?? 0 }))
		.sort((left, right) => left.value - right.value)
		.slice(0, 3)
		.map((entry) => goalForMetric(entry.metric));

	if (ordered.length === 0) {
		return ["Establish IOSM baseline metrics and define an initial cycle scope."];
	}

	const unique = Array.from(new Set(ordered));
	if (unique.length === 1) {
		unique.push("Establish IOSM baseline metrics and define an initial cycle scope.");
	}
	return unique.slice(0, 3);
}

function createIosmConfigTemplate(systemName: string): string {
	const encodedSystemName = JSON.stringify(systemName);

	return `iosm:
  metadata:
    system_name: ${encodedSystemName}
    scope: repository
    criticality_profile: standard
    delivery_boundary: ${encodedSystemName}
  planning:
    use_economic_decision: true
    prioritization_formula: wsjf_confidence
    min_confidence: 0.70
    hypothesis_required: true
    cycle_scope_required: true
  cycle_capacity:
    max_goals: 3
    max_scope_items: 5
    max_expected_change_surface: 3
  cycle_policy:
    max_iterations_per_phase: 3
    stabilization:
      target_index: 0.98
      consecutive_cycles: 3
      global_metric_floor: 0.60
      max_consecutive_unexplained_declines: 2
      metric_floors:
        logic: 0.95
        performance: 0.85
  quality_gates:
    gate_I:
      semantic_min: 0.95
      logical_consistency_min: 1.00
      duplication_max: 0.05
    gate_O:
      latency_ms:
        p50_max: 60
        p95_max: 150
        p99_max: 250
      error_budget_respected: true
      chaos_pass_rate_min: 1.00
    gate_S:
      at_least_one_dimension: true
      api_surface_reduction_min: 0.20
      dependency_hygiene_min: 0.95
      onboarding_time_minutes_max: 15
      regression_budget_max: 0
    gate_M:
      change_surface_max: 3
      coupling_max: 0.20
      cohesion_min: 0.80
      contracts_pass: true
  guardrails:
    max_negative_delta:
      semantic: 0.02
      logic: 0.00
      performance: 0.03
      simplicity: 0.03
      modularity: 0.02
      flow: 0.02
  evidence:
    min_decision_confidence: 0.80
    freshness_sla_hours:
      tier_a: 24
      tier_b: 168
    min_metric_confidence:
      semantic: 0.70
      logic: 0.90
      performance: 0.90
      simplicity: 0.70
      modularity: 0.70
      flow: 0.80
  waivers:
    max_duration_days: 14
    require_human_approval: true
  metric_targets:
    semantic:
      glossary_coverage_min: 0.95
      naming_consistency_min: 0.95
      ambiguity_ratio_max: 0.05
    logic:
      invariant_pass_rate_min: 1.00
    performance:
      latency_ms:
        p50_max: 60
        p95_max: 150
        p99_max: 250
    simplicity:
      onboarding_time_minutes_max: 15
    modularity:
      change_surface_max: 3
    flow:
      lead_time_hours_max: 24
      deploy_frequency_per_week_min: 5
      change_failure_rate_max: 0.15
      review_latency_hours_max: 24
  index:
    weights:
      semantic: 0.15
      logic: 0.20
      performance: 0.25
      simplicity: 0.15
      modularity: 0.15
      flow: 0.10
  automation:
    allow_agents: true
    human_approval_required_for:
      - waivers
      - public_contract_changes
      - threshold_relaxation
      - destructive_data_changes
  reporting:
    persist_history: true
    output_format: json
  learning:
    update_pattern_library: true
    update_decision_log: true
    update_glossary: true
`;
}

function writeScaffoldFileWithExistenceCheck(
	filePath: string,
	content: string,
	force: boolean,
	result: IosmInitResult,
): void {
	const existed = existsSync(filePath);
	if (existed && !force) {
		pushUnique(result.skipped, filePath);
		return;
	}

	writeFileSync(filePath, content, "utf8");
	markPathByExistence(filePath, existed, result);
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function countScopeItems(scope: IosmCycleScope): number {
	return scope.modules.length + scope.services.length + scope.domains.length + scope.contracts.length;
}

function createInvariantsCatalog(signals: ProjectSignals, nowIso: string): UnknownRecord {
	const invariants: UnknownRecord[] = [
		{
			id: "inv-build-green",
			statement: "Build/test pipeline remains green for cycle scope changes.",
			status: "active",
			evidence_tier: signals.hasCiSignals ? "B" : "C",
			owner: "unassigned",
		},
		{
			id: "inv-contract-compatibility",
			statement: "Public contracts are backward compatible unless an approved waiver exists.",
			status: "active",
			evidence_tier: signals.contracts.length > 0 ? "B" : "C",
			owner: "unassigned",
		},
		{
			id: "inv-metric-freshness",
			statement: "IOSM baseline and cycle metrics must be refreshed each cycle before decisioning.",
			status: "active",
			evidence_tier: "C",
			owner: "unassigned",
		},
	];

	return {
		version: 1,
		generated_at: nowIso,
		invariants,
	};
}

function createContractCatalog(signals: ProjectSignals, nowIso: string): UnknownRecord {
	return {
		version: 1,
		generated_at: nowIso,
		contracts: signals.contracts.map((contract, index) => ({
			id: `contract-${String(index + 1).padStart(3, "0")}`,
			kind: contract.kind,
			path: contract.path,
			description: contract.description,
			status: "tracked",
			owner: "unassigned",
		})),
	};
}

function createWaiverRegister(nowIso: string): UnknownRecord {
	return {
		version: 1,
		generated_at: nowIso,
		waivers: [],
	};
}

function formatMetricInline(metric: IosmMetric, value: number | null): string {
	return `${metric}=${value === null ? "n/a" : value.toFixed(3)}`;
}

function createDecisionLog(systemName: string, analysis: IosmInitAnalysis): string {
	const metricLine = IOSM_METRICS.map((metric) => formatMetricInline(metric, analysis.metrics[metric])).join(", ");
	const confidenceLine = IOSM_METRICS.map((metric) => `${metric}=${analysis.metric_confidences[metric].toFixed(2)}`).join(", ");
	const goals = analysis.goals.map((goal) => `- ${goal}`).join("\n");
	const contractsLine =
		analysis.detected_contracts.length > 0
			? analysis.detected_contracts.map((contract) => `${contract.kind}:${contract.path}`).join(", ")
			: "none";
	const topLanguagesLine =
		analysis.top_languages.length > 0
			? analysis.top_languages
					.map((language) => `${language.language}(${language.files} files)`)
					.join(", ")
			: "unknown";

	return [
		"# IOSM Decision Log",
		"",
		`## Initialization Snapshot (${analysis.generated_at})`,
		`- System: ${systemName}`,
		`- Files analyzed: ${analysis.files_analyzed}`,
		`- Source files: ${analysis.source_file_count}`,
		`- Test files: ${analysis.test_file_count}`,
		`- Docs files: ${analysis.doc_file_count}`,
		`- Top languages: ${topLanguagesLine}`,
		`- Contracts detected: ${contractsLine}`,
		`- Baseline metrics: ${metricLine}`,
		`- Metric confidence: ${confidenceLine}`,
		"",
		"## Initial Decision",
		"- Decision: CONTINUE",
		"- Rationale: Project baseline captured; continue through IOSM phases with evidence upgrades.",
		"",
		"## Initial Goals",
		goals,
		"",
	].join("\n");
}

function createPatternLibrary(analysis: IosmInitAnalysis): string {
	const modulesLine = analysis.cycle_scope.modules.length > 0 ? analysis.cycle_scope.modules.join(", ") : "none";
	const servicesLine = analysis.cycle_scope.services.length > 0 ? analysis.cycle_scope.services.join(", ") : "none";
	const domainsLine = analysis.cycle_scope.domains.length > 0 ? analysis.cycle_scope.domains.join(", ") : "none";
	const contractsLine =
		analysis.detected_contracts.length > 0
			? analysis.detected_contracts.map((contract) => contract.path).join(", ")
			: "none";

	return [
		"# IOSM Pattern Library",
		"",
		`## Baseline Patterns (${analysis.generated_at})`,
		`- Scoped modules: ${modulesLine}`,
		`- Scoped services: ${servicesLine}`,
		`- Scoped domains: ${domainsLine}`,
		`- Contracts: ${contractsLine}`,
		"",
		"## Notes",
		"- Entries above are auto-detected during `iosm init` and should be refined during Improve/Shrink phases.",
		"- Capture validated reusable tactics here after cycle completion.",
		"",
	].join("\n");
}

function deriveInitAnalysis(signals: ProjectSignals, config: IosmConfig): IosmInitAnalysis {
	const nowIso = new Date().toISOString();
	const maxScopeItems = Math.max(
		1,
		Math.min(
			config.iosm.cycle_capacity.max_scope_items,
			config.iosm.cycle_capacity.max_expected_change_surface,
		),
	);
	const cycleScope = buildCycleScope(signals, maxScopeItems);
	const rawMeasurements = buildRawMeasurements(signals);
	const metrics = calculateIosmMetricsFromRawMeasurements(rawMeasurements, config);
	const metricConfidences = buildMetricConfidences(signals);
	const metricTiers = createMetricRecord((metric) => toMetricTier(metricConfidences[metric]));
	const goals = buildGoals(metrics);

	return {
		generated_at: nowIso,
		files_analyzed: signals.filesAnalyzed,
		source_file_count: signals.sourceFileCount,
		test_file_count: signals.testFileCount,
		doc_file_count: signals.docFileCount,
		top_languages: signals.topLanguages,
		cycle_scope: cycleScope,
		detected_contracts: signals.contracts,
		source_systems: signals.sourceSystems,
		goals,
		raw_measurements: rawMeasurements,
		metrics,
		metric_confidences: metricConfidences,
		metric_tiers: metricTiers,
	};
}

function seedCycleArtifactsFromAnalysis(
	rootDir: string,
	cycleId: string,
	analysis: IosmInitAnalysis,
	config: IosmConfig,
): void {
	const baselinePath = getIosmBaselineReportPath(cycleId, rootDir);
	const reportPath = getIosmCycleReportPath(cycleId, rootDir);
	const hypothesesPath = getIosmHypothesesPath(cycleId, rootDir);

	if (!existsSync(baselinePath) || !existsSync(reportPath) || !existsSync(hypothesesPath)) {
		return;
	}

	const baseline = readJson<IosmBaselineReport>(baselinePath);
	baseline.cycle_scope = analysis.cycle_scope;
	baseline.source_systems = analysis.source_systems.length > 0 ? analysis.source_systems : baseline.source_systems;
	baseline.baseline_metrics = {
		values: analysis.metrics,
		raw_measurements: analysis.raw_measurements,
	};
	baseline.captured_at = analysis.generated_at;
	writeJson(baselinePath, baseline);

	const report = readJson<IosmCycleReport>(reportPath);
	report.status = "active";
	report.cycle_scope = analysis.cycle_scope;
	report.raw_measurements = analysis.raw_measurements;
	report.metrics = analysis.metrics;
	report.metric_confidences = analysis.metric_confidences;
	report.metric_tiers = analysis.metric_tiers;
	report.metric_deltas = createMetricRecord(() => 0);
	report.decline_coverage = createMetricRecord(() => true);
	report.iosm_index = calculateIosmIndex(analysis.metrics, config.iosm.index.weights);
	report.decision_confidence = calculateDecisionConfidence(analysis.metric_confidences, config.iosm.index.weights);
	report.incomplete =
		!hasCompleteNumericMetricRecord(report.metrics) ||
		!hasCompleteNumericMetricRecord(report.metric_confidences) ||
		!hasCompleteTierMetricRecord(report.metric_tiers) ||
		report.window.length === 0;
	report.decision = "CONTINUE";
	report.automation_actors = [
		...(report.automation_actors ?? []),
		{
			type: "agent",
			role: "analyzer",
			identity: "iosm-init",
			provenance: "repo-static-analysis",
		},
	];
	const scopeItems = countScopeItems(analysis.cycle_scope);
	report.cycle_capacity = {
		goal_count: report.goals.length,
		scope_size: scopeItems,
		expected_change_surface: scopeItems > 0 ? scopeItems : Math.max(report.hypotheses.length, 1),
		pass:
			report.goals.length <= config.iosm.cycle_capacity.max_goals &&
			scopeItems <= config.iosm.cycle_capacity.max_scope_items &&
			(scopeItems > 0 ? scopeItems : Math.max(report.hypotheses.length, 1)) <=
				config.iosm.cycle_capacity.max_expected_change_surface,
	};
	writeJson(reportPath, report);
}

function getCycleArtifactPaths(rootDir: string, cycleId: string): string[] {
	return [
		getIosmBaselineReportPath(cycleId, rootDir),
		getIosmHypothesesPath(cycleId, rootDir),
		getIosmCycleReportPath(cycleId, rootDir),
		...IOSM_PHASES.map((phase) => getIosmPhaseReportPath(cycleId, phase, rootDir)),
	];
}

function shouldReuseCycleForInit(cycle: IosmCycleListItem | undefined): boolean {
	if (!cycle) {
		return false;
	}

	return cycle.decision === "CONTINUE" || cycle.decision === "unknown";
}

function planOrReuseCycle(
	rootDir: string,
	force: boolean,
	analysis: IosmInitAnalysis,
	config: IosmConfig,
	result: IosmInitResult,
): InitialCycleSummary | undefined {
	let existingCycles: IosmCycleListItem[] = [];
	try {
		existingCycles = listIosmCycles(rootDir);
	} catch {
		existingCycles = [];
	}

	const latestCycle = existingCycles[0];
	const shouldReuse = shouldReuseCycleForInit(latestCycle);
	let planned: PlannedIosmCycle | undefined;
	let reusedExistingCycle = false;
	const existedBeforePlan = new Map<string, boolean>();

	if (!shouldReuse) {
		planned = planIosmCycle({
			cwd: rootDir,
			goals: analysis.goals,
			force,
		});
	} else if (force) {
		reusedExistingCycle = true;
		const cycleId = latestCycle.cycleId;
		for (const artifactPath of getCycleArtifactPaths(rootDir, cycleId)) {
			existedBeforePlan.set(artifactPath, existsSync(artifactPath));
		}
		planned = planIosmCycle({
			cwd: rootDir,
			cycleId,
			goals: analysis.goals,
			force: true,
		});
	} else {
		const cycleId = latestCycle.cycleId;
		return {
			cycleId,
			cycleDir: getIosmCycleDir(cycleId, rootDir),
			reportPath: getIosmCycleReportPath(cycleId, rootDir),
			baselineReportPath: getIosmBaselineReportPath(cycleId, rootDir),
			hypothesesPath: getIosmHypothesesPath(cycleId, rootDir),
			reusedExistingCycle: true,
		};
	}

	if (!planned) {
		return undefined;
	}

	const artifactPaths = getCycleArtifactPaths(rootDir, planned.cycleId);
	for (const filePath of artifactPaths) {
		markPathByExistence(filePath, existedBeforePlan.get(filePath) ?? false, result);
	}

	seedCycleArtifactsFromAnalysis(rootDir, planned.cycleId, analysis, config);

	return {
		cycleId: planned.cycleId,
		cycleDir: planned.cycleDir,
		reportPath: planned.reportPath,
		baselineReportPath: planned.baselineReportPath,
		hypothesesPath: planned.hypothesesPath,
		reusedExistingCycle,
	};
}

export async function initIosmWorkspace(options: IosmInitOptions = {}): Promise<IosmInitResult> {
	const rootDir = resolve(options.cwd ?? process.cwd());
	const force = options.force ?? false;

	const bootstrapAnalysis: IosmInitAnalysis = {
		generated_at: new Date().toISOString(),
		files_analyzed: 0,
		source_file_count: 0,
		test_file_count: 0,
		doc_file_count: 0,
		top_languages: [],
		cycle_scope: {
			modules: [],
			services: [],
			domains: [],
			contracts: [],
			rationale: "not analyzed",
		},
		detected_contracts: [],
		source_systems: [],
		goals: ["Establish IOSM baseline metrics and define an initial cycle scope."],
		raw_measurements: {},
		metrics: createMetricRecord(() => null),
		metric_confidences: createMetricRecord(() => 0.5),
		metric_tiers: createMetricRecord(() => "C"),
	};

	const result: IosmInitResult = {
		rootDir,
		created: [],
		overwritten: [],
		skipped: [],
		analysis: bootstrapAnalysis,
	};

	const systemName = basename(rootDir);

	mkdirSync(rootDir, { recursive: true });
	mkdirSync(getIosmWorkspaceDir(rootDir), { recursive: true });
	mkdirSync(getIosmBaselinesDir(rootDir), { recursive: true });
	mkdirSync(getIosmCyclesDir(rootDir), { recursive: true });

	writeScaffoldFileWithExistenceCheck(getIosmConfigPath(rootDir), createIosmConfigTemplate(systemName), force, result);

	const { config } = loadIosmConfig(rootDir);
	const signals = await deriveProjectSignals(rootDir);
	const analysis = deriveInitAnalysis(signals, config);
	result.analysis = analysis;

	const invariantsCatalog = createInvariantsCatalog(signals, analysis.generated_at);
	const contractsCatalog = createContractCatalog(signals, analysis.generated_at);
	const waiverRegister = createWaiverRegister(analysis.generated_at);
	const decisionLog = createDecisionLog(systemName, analysis);
	const patternLibrary = createPatternLibrary(analysis);

	writeScaffoldFileWithExistenceCheck(getIosmMetricsHistoryPath(rootDir), "", force, result);
	writeScaffoldFileWithExistenceCheck(
		getIosmWaiverRegisterPath(rootDir),
		stringify(waiverRegister),
		force,
		result,
	);
	writeScaffoldFileWithExistenceCheck(
		getIosmInvariantCatalogPath(rootDir),
		stringify(invariantsCatalog),
		force,
		result,
	);
	writeScaffoldFileWithExistenceCheck(
		getIosmContractCatalogPath(rootDir),
		stringify(contractsCatalog),
		force,
		result,
	);
	writeScaffoldFileWithExistenceCheck(getIosmDecisionLogPath(rootDir), decisionLog, force, result);
	writeScaffoldFileWithExistenceCheck(getIosmPatternLibraryPath(rootDir), patternLibrary, force, result);
	writeScaffoldFileWithExistenceCheck(join(getIosmBaselinesDir(rootDir), ".gitkeep"), "", force, result);
	writeScaffoldFileWithExistenceCheck(join(getIosmCyclesDir(rootDir), ".gitkeep"), "", force, result);

	result.cycle = planOrReuseCycle(rootDir, force, analysis, config, result);
	const heuristicIndex = calculateIosmIndex(analysis.metrics, config.iosm.index.weights);
	const heuristicConfidence = calculateDecisionConfidence(analysis.metric_confidences, config.iosm.index.weights);
	const guideWrite = writeIosmGuideDocument(
		{
			rootDir,
			cycleId: result.cycle?.cycleId,
			assessmentSource: "heuristic",
			metrics: analysis.metrics,
			iosmIndex: heuristicIndex,
			decisionConfidence: heuristicConfidence,
			goals: analysis.goals,
			filesAnalyzed: analysis.files_analyzed,
			sourceFileCount: analysis.source_file_count,
			testFileCount: analysis.test_file_count,
			docFileCount: analysis.doc_file_count,
		},
		true,
	);
	if (guideWrite.written) {
		markPathByExistence(guideWrite.path, guideWrite.existed, result);
	} else {
		pushUnique(result.skipped, guideWrite.path);
	}

	const agentsWrite = writeAgentsGuideDocument(
		{
			rootDir,
			cycleId: result.cycle?.cycleId,
			assessmentSource: "heuristic",
			iosmIndex: heuristicIndex,
			decisionConfidence: heuristicConfidence,
			goals: analysis.goals,
			filesAnalyzed: analysis.files_analyzed,
			sourceFileCount: analysis.source_file_count,
			testFileCount: analysis.test_file_count,
			docFileCount: analysis.doc_file_count,
		},
		true,
	);
	if (agentsWrite.written) {
		markPathByExistence(agentsWrite.path, agentsWrite.existed, result);
	} else {
		pushUnique(result.skipped, agentsWrite.path);
	}

	if (result.cycle) {
		try {
			recordIosmCycleHistory(rootDir, result.cycle.cycleId);
		} catch {
			// Keep init resilient even if history record cannot be persisted yet.
		}
	}

	return result;
}
