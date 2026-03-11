import { describe, expect, it } from "vitest";
import { collectSubagentRenderableText } from "../src/core/sdk.js";

describe("collectSubagentRenderableText", () => {
	it("extracts assistant text parts", () => {
		expect(
			collectSubagentRenderableText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal" },
					{ type: "text", text: "Implemented fix." },
					{ type: "text", text: "  Ran tests.  " },
				],
			}),
		).toEqual(["Implemented fix.", "Ran tests."]);
	});

	it("uses displayable custom message content as fallback output", () => {
		expect(
			collectSubagentRenderableText({
				role: "custom",
				display: true,
				content: "Execution plan (1/3 complete)\nCurrent: Add tests",
			}),
		).toEqual(["Execution plan (1/3 complete)\nCurrent: Add tests"]);
	});

	it("ignores hidden custom messages", () => {
		expect(
			collectSubagentRenderableText({
				role: "custom",
				display: false,
				content: "internal runtime context",
			}),
		).toEqual([]);
	});
});
