import type { ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";

export const PRODUCT_MODULE_CLASSES = ["required", "capability", "provider", "surface", "compatibility"] as const;
export type ProductModuleClass = (typeof PRODUCT_MODULE_CLASSES)[number];

const PRODUCT_MODULE_AUTHORITY = Symbol("mypi.product-module-authority");

export type ProductModule = Extract<InlineExtension, { name: string }> & {
	readonly [PRODUCT_MODULE_AUTHORITY]: ProductModuleClass;
};

export function defineProductModule(
	name: string,
	moduleClass: ProductModuleClass,
	factory: ExtensionFactory,
): ProductModule {
	return {
		name,
		factory,
		hidden: true,
		builtIn: true,
		[PRODUCT_MODULE_AUTHORITY]: moduleClass,
	};
}

/**
 * Return sealed product authority only for objects created in this module.
 * Dynamic/user extension metadata cannot name or serialize the private symbol.
 */
export function getProductModuleClass(input: InlineExtension): ProductModuleClass | undefined {
	if (typeof input === "function") return undefined;
	const candidate = (input as Partial<ProductModule>)[PRODUCT_MODULE_AUTHORITY];
	return PRODUCT_MODULE_CLASSES.includes(candidate as ProductModuleClass) ? candidate : undefined;
}
