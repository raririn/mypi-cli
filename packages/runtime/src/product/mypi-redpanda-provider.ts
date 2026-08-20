import type { ExtensionAPI } from "../core/extensions/types.ts";
import {
  REDPANDA_PROVIDER_CONFIG,
  REDPANDA_PROVIDER_ID,
} from "./redpanda-provider-core.ts";

export default function redPandaProviderExtension(pi: ExtensionAPI): void {
  pi.registerProvider(REDPANDA_PROVIDER_ID, REDPANDA_PROVIDER_CONFIG);
}
