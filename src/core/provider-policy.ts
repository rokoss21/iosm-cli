const DISABLED_PROVIDER_IDS = new Set<string>(["google-antigravity"]);

function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

export function isProviderAllowed(providerId: string): boolean {
	if (!providerId) return false;
	return !DISABLED_PROVIDER_IDS.has(normalizeProviderId(providerId));
}

export function getDisabledProviderIds(): string[] {
	return [...DISABLED_PROVIDER_IDS];
}

export function filterAllowedProviderIds(providerIds: readonly string[]): string[] {
	return providerIds.filter((providerId) => isProviderAllowed(providerId));
}

export function filterAllowedProviders<T extends { id: string }>(providers: readonly T[]): T[] {
	return providers.filter((provider) => isProviderAllowed(provider.id));
}
