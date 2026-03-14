import { getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { Container, fuzzyFilter, getEditorKeybindings, Input, Spacer, Text, TruncatedText } from "@mariozechner/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export type LoginProviderKind = "oauth" | "api_key";

export type LoginProviderOption = {
	id: string;
	name: string;
	kind: LoginProviderKind;
};

const DEFAULT_API_KEY_LOGIN_PROVIDERS: LoginProviderOption[] = [
	{ id: "openrouter", name: "OpenRouter", kind: "api_key" },
];

/**
 * Component that renders an OAuth provider selector
 */
export class OAuthSelectorComponent extends Container {
	private searchInput: Input;
	private summaryText: Text;
	private listContainer: Container;
	private allProviders: LoginProviderOption[] = [];
	private filteredProviders: LoginProviderOption[] = [];
	private selectedIndex: number = 0;
	private maxVisible: number = 10;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private onSelectCallback: (provider: LoginProviderOption) => void;
	private onCancelCallback: () => void;
	private apiKeyProviders: LoginProviderOption[];

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (provider: LoginProviderOption) => void,
		onCancel: () => void,
		apiKeyProviders: LoginProviderOption[] = DEFAULT_API_KEY_LOGIN_PROVIDERS,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.apiKeyProviders = apiKeyProviders.filter((provider) => provider.kind === "api_key");

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to authenticate:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		if (mode === "login") {
			this.addChild(new TruncatedText(theme.fg("muted", "OAuth + API key providers")));
		}
		this.summaryText = new Text(theme.fg("muted", "Loading providers..."), 0, 0);
		this.addChild(this.summaryText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		const sep = theme.fg("muted", " · ");
		const controlsHint =
			rawKeyHint("↑/↓", "navigate") +
			sep +
			keyHint("selectConfirm", "select") +
			sep +
			keyHint("selectCancel", "close") +
			sep +
			rawKeyHint("type", "search");
		this.addChild(new TruncatedText(controlsHint));
		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.loadProviders();
		this.updateList();
	}

	private loadProviders(): void {
		const oauthProviders: LoginProviderOption[] = getOAuthProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			kind: "oauth",
		}));
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));

		if (this.mode === "login") {
			const apiKeyProviders = this.apiKeyProviders
				.filter((provider) => !oauthProviderIds.has(provider.id))
				.sort((a, b) => a.name.localeCompare(b.name));
			this.allProviders = [...oauthProviders, ...apiKeyProviders];
			this.applyFilter(this.searchInput.getValue());
			return;
		}

		// Logout mode: show only providers with saved credentials in auth.json.
		const savedCredentialsProviders = [...oauthProviders];
		const apiProvidersById = new Map(
			this.apiKeyProviders
				.filter((provider) => !oauthProviderIds.has(provider.id))
				.map((provider) => [provider.id, provider] as const),
		);

		// Include ad-hoc API-key providers from auth.json so users can always logout.
		for (const providerId of this.authStorage.list()) {
			const credential = this.authStorage.get(providerId);
			if (credential?.type === "api_key" && !oauthProviderIds.has(providerId) && !apiProvidersById.has(providerId)) {
				apiProvidersById.set(providerId, {
					id: providerId,
					name: providerId,
					kind: "api_key",
				});
			}
		}
		savedCredentialsProviders.push(...apiProvidersById.values());

		this.allProviders = savedCredentialsProviders.filter((provider) => {
			const credentials = this.authStorage.get(provider.id);
			if (!credentials) return false;
			if (provider.kind === "oauth") return credentials.type === "oauth";
			return credentials.type === "api_key";
		});
		this.allProviders.sort((a, b) => a.name.localeCompare(b.name));
		this.applyFilter(this.searchInput.getValue());
	}

	private applyFilter(query: string): void {
		const trimmed = query.trim();
		this.filteredProviders = trimmed
			? fuzzyFilter(this.allProviders, trimmed, (provider) => `${provider.name} ${provider.id}`)
			: this.allProviders;
		if (this.filteredProviders.length === 0) {
			this.selectedIndex = 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, this.filteredProviders.length - 1);
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		const shown = this.filteredProviders.length;
		const total = this.allProviders.length;
		const summary = `${theme.fg("muted", "Showing")} ${theme.fg("accent", String(shown))}${theme.fg("muted", "/")}${theme.fg("muted", String(total))}`;
		this.summaryText.setText(summary);

		if (this.filteredProviders.length === 0) {
			const message = this.allProviders.length === 0 ? "No providers available" : "No matching providers.";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				Math.max(0, this.filteredProviders.length - this.maxVisible),
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			// Check if user is authenticated for this provider
			const credentials = this.authStorage.get(provider.id);
			const isConfigured =
				provider.kind === "oauth"
					? credentials?.type === "oauth"
					: credentials?.type === "api_key" || this.authStorage.hasAuth(provider.id);
			const statusIndicator = isConfigured
				? provider.kind === "oauth"
					? theme.fg("success", " ✓ logged in")
					: theme.fg("success", " ✓ key configured")
				: "";
			const providerKindBadge = provider.kind === "api_key" ? theme.fg("warning", " [API key]") : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", provider.name);
				line = prefix + text + providerKindBadge + statusIndicator;
			} else {
				const text = `  ${provider.name}`;
				line = text + providerKindBadge + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		// Up arrow
		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredProviders.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "selectDown")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredProviders.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Page up/down
		else if (kb.matches(keyData, "selectPageUp")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.updateList();
		} else if (kb.matches(keyData, "selectPageDown")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + this.maxVisible);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "selectConfirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
			this.updateList();
		}
	}
}
