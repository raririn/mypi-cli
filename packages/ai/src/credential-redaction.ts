import type { StreamOptions } from "./types.ts";

const OPENROUTER_KEY = /\bsk-or-v1-[a-fA-F0-9]{64}\b/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_FIELD_VALUE =
	/((?:["']?)(?:aws_secret_access_key|awsSecretAccessKey|secretAccessKey|SecretAccessKey|AWS_SECRET_ACCESS_KEY)(?:["']?)\s*(?:=|:)\s*(?:["']?))([A-Za-z0-9/+=]{40})(?=["'\s,;}]|$)/gi;
const AWS_SECRET_VALUE = /^[A-Za-z0-9/+=]{40}$/;
const MAX_PAYLOAD_DEPTH = 64;

export type CredentialKind = "openrouter" | "awsAccessKeyId" | "awsSecretAccessKey";

export const CREDENTIAL_REDACTION_PLACEHOLDERS = Object.freeze({
	openrouter: "[REDACTED_OPENROUTER_API_KEY]",
	awsAccessKeyId: "[REDACTED_AWS_ACCESS_KEY_ID]",
	awsSecretAccessKey: "[REDACTED_AWS_SECRET_ACCESS_KEY]",
});

function isAwsSecretField(name: string): boolean {
	const normalized = name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
	return normalized === "awssecretaccesskey" || normalized === "secretaccesskey";
}

function redactString(value: string, kinds: Set<CredentialKind>, forceAwsSecret = false): string {
	let next = value.replace(OPENROUTER_KEY, () => {
		kinds.add("openrouter");
		return CREDENTIAL_REDACTION_PLACEHOLDERS.openrouter;
	});
	next = next.replace(AWS_ACCESS_KEY_ID, () => {
		kinds.add("awsAccessKeyId");
		return CREDENTIAL_REDACTION_PLACEHOLDERS.awsAccessKeyId;
	});
	next = next.replace(AWS_SECRET_FIELD_VALUE, (_match, prefix: string) => {
		kinds.add("awsSecretAccessKey");
		return `${prefix}${CREDENTIAL_REDACTION_PLACEHOLDERS.awsSecretAccessKey}`;
	});
	if (forceAwsSecret && AWS_SECRET_VALUE.test(next)) {
		kinds.add("awsSecretAccessKey");
		next = CREDENTIAL_REDACTION_PLACEHOLDERS.awsSecretAccessKey;
	}
	return next;
}

function isOpaqueBinary(value: object): boolean {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Return a copy-on-write provider-bound payload with conservative well-known
 * credentials replaced. Authentication options and headers are intentionally
 * outside this value and are never inspected or modified.
 */
export function redactCredentialPayload<T>(payload: T): {
	value: T;
	changed: boolean;
	kinds: CredentialKind[];
} {
	const kinds = new Set<CredentialKind>();
	const seen = new WeakMap<object, unknown>();

	const visit = (value: unknown, depth: number, fieldName?: string): unknown => {
		if (typeof value === "string") {
			return redactString(value, kinds, fieldName ? isAwsSecretField(fieldName) : false);
		}
		if (
			!value ||
			typeof value !== "object" ||
			isOpaqueBinary(value) ||
			value instanceof Date ||
			value instanceof URL
		) {
			return value;
		}
		if (depth > MAX_PAYLOAD_DEPTH) {
			throw new Error("Provider payload exceeds the credential-redaction nesting limit");
		}
		const previous = seen.get(value);
		if (previous) return previous;

		if (Array.isArray(value)) {
			const clone = new Array<unknown>(value.length);
			seen.set(value, clone);
			let changed = false;
			for (let index = 0; index < value.length; index++) {
				const child = visit(value[index], depth + 1);
				clone[index] = child;
				if (child !== value[index]) changed = true;
			}
			if (!changed) {
				seen.set(value, value);
				return value;
			}
			return clone;
		}

		const descriptors = Object.getOwnPropertyDescriptors(value);
		const clone = Object.create(Object.getPrototypeOf(value)) as object;
		seen.set(value, clone);
		let changed = false;
		for (const key of Object.keys(value)) {
			const child = visit(Reflect.get(value, key), depth + 1, key);
			if (child !== Reflect.get(value, key)) {
				descriptors[key] = { ...descriptors[key], value: child };
				changed = true;
			}
		}
		if (!changed) {
			seen.set(value, value);
			return value;
		}
		Object.defineProperties(clone, descriptors);
		return clone;
	};

	const value = visit(payload, 0) as T;
	return { value, changed: kinds.size > 0, kinds: [...kinds] };
}

/** Apply final payload redaction after any caller-provided payload hook. */
export function withCredentialRedaction<T extends StreamOptions | undefined>(options: T): StreamOptions {
	const onPayload = options?.onPayload;
	return {
		...(options ?? {}),
		onPayload: async (payload, model) => {
			const replacement = onPayload ? await onPayload(payload, model) : undefined;
			return redactCredentialPayload(replacement === undefined ? payload : replacement).value;
		},
	};
}
