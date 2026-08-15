import type { HostedOwnershipConflictInfo } from "./daemon-client.ts";

type Owner = HostedOwnershipConflictInfo["owner"];

export function canOfferRob(owner: Owner, localHostname: string): boolean {
	return owner.pid > 0
		&& owner.hostname === localHostname
		&& typeof owner.ownerId === "string"
		&& owner.ownerId.length > 0
		&& typeof owner.processStartTime === "number"
		&& Number.isFinite(owner.processStartTime);
}

export interface OwnershipOwnerCopy {
	pidLabel: string;
	ownerLabel: string;
	manualAdvice: string;
}

export function formatOwnershipOwner(owner: Owner): OwnershipOwnerCopy {
	const pidLabel = owner.pid > 0 ? `pid ${owner.pid}` : "an unknown PID";
	const hostLabel = owner.hostname !== "unknown" ? ` on ${owner.hostname}` : "";
	return {
		pidLabel,
		ownerLabel: `${owner.surface} (${pidLabel}${hostLabel})`,
		manualAdvice: owner.pid > 0
			? `Safest: return to or manage the other MyPi process manually using reported pid ${owner.pid}${hostLabel}.`
			: "Safest: return to the other MyPi surface and close or release this session manually.",
	};
}

export function formatRequestHandoffPrompt(owner: Owner): {
	title: string;
	requestOption: string;
	cancelOption: string;
} & OwnershipOwnerCopy {
	const copy = formatOwnershipOwner(owner);
	return {
		...copy,
		title: `Session already has a live external owner\n${copy.ownerLabel}\n${copy.manualAdvice}\n\nRequest handoff does not kill the owner. It asks that process to approve a clean release.`,
		requestOption: `Request handoff — Ask ${copy.ownerLabel} to release the session cleanly`,
		cancelOption: `Cancel (recommended) — Leave ${copy.ownerLabel} unchanged`,
	};
}

export function formatRobPrompt(owner: Owner, detail: string): {
	title: string;
	robOption: string;
	cancelOption: string;
} & OwnershipOwnerCopy {
	const copy = formatOwnershipOwner(owner);
	return {
		...copy,
		title: `Clean handoff did not complete\n${detail}\n${copy.manualAdvice}\n\nRob is destructive: it aborts an active model or tool turn and asks the owner to shut down. It can lose queued or unsent in-memory input. It cannot undo filesystem, process, network, or other tool side effects already performed. If the exact same-host owner does not exit, MyPi may send SIGTERM. Resume still fails unless this process later acquires the authoritative writer lock. SIGKILL is never sent from this choice; it requires another explicit confirmation.`,
		robOption: `Rob session — Abort work in ${copy.pidLabel}, request shutdown, then allow verified SIGTERM fallback`,
		cancelOption: `Cancel (recommended) — Manage ${copy.pidLabel} manually and preserve the current owner`,
	};
}

export function formatSigkillPrompt(owner: Owner): {
	title: string;
	message: string;
} & OwnershipOwnerCopy {
	const copy = formatOwnershipOwner(owner);
	return {
		...copy,
		title: `Send SIGKILL to ${copy.pidLabel}?`,
		message: `SIGTERM did not stop the verified owner. SIGKILL terminates it immediately, without normal session_shutdown cleanup. Queued or unsent input may be lost, and prior tool side effects cannot be undone. MyPi will still wait for the abandoned writer lock to become reclaimable before retrying. ${copy.manualAdvice}`,
	};
}
