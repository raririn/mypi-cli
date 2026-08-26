export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pizzeria/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

/** Honest client identity for model requests — the app's real name and
 *  version. Used when the `honestUserAgent` config option is enabled, in
 *  place of any compatibility (Claude Code-style) user-agent. */
export function getHonestModelUserAgent(version: string): string {
	return `pizzeria/${version}`;
}
