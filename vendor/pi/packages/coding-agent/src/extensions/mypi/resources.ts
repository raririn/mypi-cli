import { join } from "node:path";
import { getPackageDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

/** Make MyPi-authored skills part of the runtime instead of optional profile resources. */
export default function myPiResourcesExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({
		skillPaths: [join(getPackageDir(), "skills")],
	}));
}
