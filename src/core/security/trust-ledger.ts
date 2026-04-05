import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TrustSourceType = "npm" | "git" | "tool-download";
export type TrustActorScope = "user" | "workspace" | "session" | "non-interactive-override";

export interface TrustLedgerEntry {
	key: string;
	sourceType: TrustSourceType;
	source: string;
	identity: string;
	host: string;
	fingerprint: string;
	approvedAt: string;
	actorScope: TrustActorScope;
}

interface TrustLedgerFile {
	version: number;
	entries: TrustLedgerEntry[];
}

const TRUST_LEDGER_FILENAME = "trust-ledger.json";

export class TrustLedger {
	private readonly path: string;
	private data: TrustLedgerFile;

	constructor(agentDir: string) {
		this.path = join(agentDir, TRUST_LEDGER_FILENAME);
		this.data = this.load();
	}

	getPath(): string {
		return this.path;
	}

	get(key: string): TrustLedgerEntry | undefined {
		return this.data.entries.find((entry) => entry.key === key);
	}

	getAll(): TrustLedgerEntry[] {
		return this.data.entries.map((entry) => ({ ...entry }));
	}

	upsert(entry: TrustLedgerEntry): void {
		const index = this.data.entries.findIndex((item) => item.key === entry.key);
		if (index >= 0) {
			this.data.entries[index] = { ...entry };
		} else {
			this.data.entries.push({ ...entry });
		}
		this.save();
	}

	private load(): TrustLedgerFile {
		if (!existsSync(this.path)) {
			return { version: 1, entries: [] };
		}
		try {
			const raw = readFileSync(this.path, "utf8");
			const parsed = JSON.parse(raw) as Partial<TrustLedgerFile>;
			const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
			return {
				version: typeof parsed.version === "number" ? parsed.version : 1,
				entries: entries
					.filter((entry): entry is TrustLedgerEntry => {
						return (
							typeof entry === "object" &&
							entry !== null &&
							typeof (entry as TrustLedgerEntry).key === "string" &&
							typeof (entry as TrustLedgerEntry).sourceType === "string" &&
							typeof (entry as TrustLedgerEntry).source === "string" &&
							typeof (entry as TrustLedgerEntry).identity === "string" &&
							typeof (entry as TrustLedgerEntry).host === "string" &&
							typeof (entry as TrustLedgerEntry).fingerprint === "string" &&
							typeof (entry as TrustLedgerEntry).approvedAt === "string" &&
							typeof (entry as TrustLedgerEntry).actorScope === "string"
						);
					})
					.map((entry) => ({ ...entry })),
			};
		} catch {
			return { version: 1, entries: [] };
		}
	}

	private save(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
	}
}
