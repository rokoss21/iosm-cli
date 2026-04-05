import type { TrustActorScope, TrustSourceType } from "./trust-ledger.js";
import { TrustLedger } from "./trust-ledger.js";

const DEFAULT_ALLOWED_HOSTS = [
	"registry.npmjs.org",
	"npmjs.org",
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"api.github.com",
	"raw.githubusercontent.com",
];

export interface SecurityConsentRequest {
	action: "install" | "update" | "download";
	sourceType: TrustSourceType;
	source: string;
	identity: string;
	host: string;
	fingerprint: string;
	reason: "new-source" | "fingerprint-change";
	previousFingerprint?: string;
}

export interface SourceVerificationInput {
	action: "install" | "update" | "download";
	sourceType: TrustSourceType;
	source: string;
	identity: string;
	host: string;
	fingerprint: string;
	allowOverride?: boolean;
	allowPrompt?: boolean;
}

export interface SourceVerificationResult {
	approved: boolean;
	reusedApproval: boolean;
	reason: "already-trusted" | "new-source-approved" | "fingerprint-reapproved";
}

export class SourceSecurityManager {
	private readonly ledger: TrustLedger;
	private readonly allowedHosts: Set<string>;
	private readonly consentProvider?: (request: SecurityConsentRequest) => Promise<boolean>;

	constructor(options: {
		agentDir: string;
		allowedHosts?: string[];
		consentProvider?: (request: SecurityConsentRequest) => Promise<boolean>;
	}) {
		this.ledger = new TrustLedger(options.agentDir);
		const normalizedHosts = (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)
			.map((host) => host.trim().toLowerCase())
			.filter((host) => host.length > 0);
		this.allowedHosts = new Set(normalizedHosts);
		this.consentProvider = options.consentProvider;
	}

	getLedgerPath(): string {
		return this.ledger.getPath();
	}

	getAllowedHosts(): string[] {
		return [...this.allowedHosts];
	}

	async verify(input: SourceVerificationInput): Promise<SourceVerificationResult> {
		this.assertHostAllowed(input.host);
		const key = this.buildKey(input.sourceType, input.identity);
		const existing = this.ledger.get(key);
		if (existing && existing.fingerprint === input.fingerprint) {
			return {
				approved: true,
				reusedApproval: true,
				reason: "already-trusted",
			};
		}

		const reason: SecurityConsentRequest["reason"] = existing ? "fingerprint-change" : "new-source";
		const approved =
			input.allowOverride === true
				? true
				: input.allowPrompt === false
					? false
					: await this.requestConsent({
						action: input.action,
						sourceType: input.sourceType,
						source: input.source,
						identity: input.identity,
						host: input.host,
						fingerprint: input.fingerprint,
						reason,
						previousFingerprint: existing?.fingerprint,
					});
		if (!approved) {
			if (existing && existing.fingerprint !== input.fingerprint) {
				throw new Error(
					`Source fingerprint changed for ${input.source} (${existing.fingerprint} -> ${input.fingerprint}). Update blocked until re-approved.`,
				);
			}
			throw new Error(`Source ${input.source} is not trusted. Re-run with explicit trust approval.`);
		}

		const actorScope: TrustActorScope = input.allowOverride ? "non-interactive-override" : "user";
		this.ledger.upsert({
			key,
			sourceType: input.sourceType,
			source: input.source,
			identity: input.identity,
			host: input.host.toLowerCase(),
			fingerprint: input.fingerprint,
			approvedAt: new Date().toISOString(),
			actorScope,
		});

		return {
			approved: true,
			reusedApproval: false,
			reason: reason === "new-source" ? "new-source-approved" : "fingerprint-reapproved",
		};
	}

	private async requestConsent(request: SecurityConsentRequest): Promise<boolean> {
		if (!this.consentProvider) {
			return false;
		}
		return this.consentProvider(request);
	}

	private buildKey(sourceType: TrustSourceType, identity: string): string {
		return `${sourceType}:${identity}`;
	}

	private assertHostAllowed(hostRaw: string): void {
		const host = hostRaw.trim().toLowerCase();
		if (!host) {
			throw new Error("Security policy rejected source with empty host.");
		}
		if (!this.allowedHosts.has(host)) {
			throw new Error(`Security policy rejected source host "${host}" (not in allowlist).`);
		}
	}
}
