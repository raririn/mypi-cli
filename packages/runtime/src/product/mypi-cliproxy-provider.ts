import type { ExtensionAPI } from "../core/extensions/types.ts";
import {
  createCliProxyProvider,
  type CliProxyProviderDependencies,
} from "./cliproxy-provider-core.ts";
import { loadConfiguredServiceTier, type ServiceTier } from "./global-config.ts";

interface CliProxyExtensionDependencies extends CliProxyProviderDependencies {
  /** Test seam; production reads the provider-neutral config.yaml field. */
  readonly loadServiceTier?: () => Promise<ServiceTier>;
}

/** CLIProxyAPI consumes the same provider-neutral service-tier setting as any
 * future capable adapter. Unsupported catalog models remain unchanged. */
export function registerCliProxyProvider(
  pi: ExtensionAPI,
  dependencies: CliProxyExtensionDependencies = {},
): void {
  const loadTier = dependencies.loadServiceTier ?? loadConfiguredServiceTier;
  let effectiveTier: ServiceTier = "default";

  pi.registerProvider(createCliProxyProvider({
    ...dependencies,
    isPriorityEnabled: () => effectiveTier === "priority",
  }));

  const refresh = async () => {
    effectiveTier = await loadTier();
  };
  pi.on("session_start", refresh);
  // Configuration changes made through /settings take effect at the explicit
  // turn boundary, never halfway through a provider request.
  pi.on("turn_start", refresh);
}

export default function cliProxyProviderExtension(pi: ExtensionAPI): void {
  registerCliProxyProvider(pi);
}
