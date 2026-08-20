import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { StructuredOutputError } from "../src/core/structured-output.ts";

const schema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};

type RpcClientPrivate = {
	send: (command: unknown) => Promise<{ id: string; type: "response"; command: "prompt"; success: true }>;
	handleLine: (line: string) => void;
};

describe("RpcClient structured output", () => {
	it("waits for the result correlated to the accepted prompt id", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(async () => ({ id: "req_7", type: "response", command: "prompt", success: true }));

		const pending = client.promptStructured("answer", { schema });
		setTimeout(() => {
			privateClient.handleLine(
				JSON.stringify({
					type: "structured_result",
					result: {
						value: { answer: "rpc" },
						schemaHash: "hash",
						method: "native",
						attempts: 1,
						requestId: "req_7",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				}),
			);
		}, 0);

		await expect(pending).resolves.toMatchObject({ value: { answer: "rpc" }, requestId: "req_7" });
		expect(privateClient.send).toHaveBeenCalledWith({
			type: "prompt",
			message: "answer",
			images: undefined,
			structuredOutput: { schema },
		});
	});

	it("reconstructs typed structured failures", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		privateClient.send = vi.fn(async () => ({ id: "req_8", type: "response", command: "prompt", success: true }));

		const pending = client.promptStructured("answer", { schema });
		setTimeout(() => {
			privateClient.handleLine(
				JSON.stringify({
					type: "structured_result_error",
					error: {
						code: "validation_exhausted",
						message: "invalid result",
						schemaHash: "hash",
						attempts: 3,
						requestId: "req_8",
					},
				}),
			);
		}, 0);

		await expect(pending).rejects.toBeInstanceOf(StructuredOutputError);
		await expect(pending).rejects.toMatchObject({ code: "validation_exhausted", attempts: 3 });
	});
});
