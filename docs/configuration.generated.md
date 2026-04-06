# Generated Settings Reference

This file is generated from `src/core/settings.schema.json`.

## `permissionMode`

- Type: `string`
- Default: `"ask"`
- Allowed values: `ask | auto | yolo`
- Description: Default permission behavior for tool execution.

## `permissionAllow`

- Type: `array`
- Default: `[]`
- Allowed values: `(any)`
- Description: Legacy allow rules in <tool:match> format. Migrated into policy v2 at runtime.

## `permissionDeny`

- Type: `array`
- Default: `[]`
- Allowed values: `(any)`
- Description: Legacy deny rules in <tool:match> format. Migrated into policy v2 at runtime.

## `permissions`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `permissions.extensionToolEnforcement`

- Type: `boolean`
- Default: `false`
- Allowed values: `(any)`
- Description: Require requiredPermission metadata for extension tools in auto mode.

## `sandbox`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `sandbox.enabled`

- Type: `boolean`
- Default: `false`
- Allowed values: `(any)`
- Description: Enable Linux bubblewrap sandbox for process-based tools.

## `terminal`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `terminal.showImages`

- Type: `boolean`
- Default: `true`
- Allowed values: `(any)`
- Description: Render images inline when the terminal supports it.

## `terminal.clearOnShrink`

- Type: `boolean`
- Default: `false`
- Allowed values: `(any)`
- Description: Clear trailing rows when content shrinks to avoid stale artifacts.

## `terminal.compactFooter`

- Type: `boolean`
- Default: `false`
- Allowed values: `(any)`
- Description: Use a compact single-line footer layout.

## `webSearch`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `webSearch.enabled`

- Type: `boolean`
- Default: `true`
- Allowed values: `(any)`
- Description: Enable built-in web search tool integration.

## `webSearch.providerMode`

- Type: `string`
- Default: `"auto"`
- Allowed values: `auto | tavily`
- Description: Primary web search provider selection strategy.

## `webSearch.fallbackMode`

- Type: `string`
- Default: `"searxng_ddg"`
- Allowed values: `searxng_ddg | searxng_only | none`
- Description: Fallback provider policy when primary lookup fails.

## `telegram`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `telegram.enabled`

- Type: `boolean`
- Default: `false`
- Allowed values: `(any)`
- Description: Enable Telegram bridge mode.

## `telegram.botToken`

- Type: `string`
- Default: `(none)`
- Allowed values: `(any)`
- Description: Telegram bot token for Bot API access.

## `telegram.allowedUserIds`

- Type: `array`
- Default: `[]`
- Allowed values: `(any)`
- Description: Allowlist of Telegram user IDs permitted to control the bridge (non-numeric values are ignored at runtime).

## `telegram.transport`

- Type: `string`
- Default: `"long-polling"`
- Allowed values: `long-polling`
- Description: Telegram transport mode.

## `telegram.chatDefaults`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `telegram.retry`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

## `telegram.debug`

- Type: `object`
- Default: `(none)`
- Allowed values: `(any)`
- Description: No description.

