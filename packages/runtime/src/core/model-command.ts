export type ParsedModelCommand =
	| { readonly persistGlobal: boolean; readonly modelReference?: string }
	| { readonly error: string };

export function parseModelCommandArguments(args: string): ParsedModelCommand {
	const tokens = args.trim().split(/\s+/u).filter(Boolean);
	const globalCount = tokens.filter((token) => token === "--global").length;
	const values = tokens.filter((token) => token !== "--global");
	if (
		globalCount > 1
		|| values.length > 1
		|| tokens.some((token) => token.startsWith("--") && token !== "--global")
	) {
		return { error: "Usage: /model [--global] <provider/model> [--global]" };
	}
	return {
		persistGlobal: globalCount === 1,
		...(values[0] ? { modelReference: values[0] } : {}),
	};
}
