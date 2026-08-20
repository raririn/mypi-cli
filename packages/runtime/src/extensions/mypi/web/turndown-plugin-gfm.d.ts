/** Types missing from the upstream CommonJS package. */
declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: (service: TurndownService) => void;
}
