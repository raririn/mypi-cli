import type { PathMetadata } from "./package-manager.ts";
import type { ProductModuleClass } from "../product/registry.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	/** Sealed MyPi product authority. Dynamic extension discovery never sets this field. */
	productClass?: ProductModuleClass;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
		productClass?: ProductModuleClass;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
		productClass: options.productClass,
	};
}

export function hasProductAuthority(
	sourceInfo: SourceInfo | undefined,
	allowedClasses?: readonly ProductModuleClass[],
): boolean {
	if (!sourceInfo?.productClass || sourceInfo.source !== "product") return false;
	if (!sourceInfo.path.startsWith(`<product:${sourceInfo.productClass}:`) || !sourceInfo.path.endsWith(">")) return false;
	return allowedClasses ? allowedClasses.includes(sourceInfo.productClass) : true;
}
