import assert from "node:assert/strict";
import test from "node:test";

const COPY_DIST = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/hosted/ownership-conflict-ui.js",
  import.meta.url,
).href;
const CLIENT_DIST = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/hosted/daemon-client.js",
  import.meta.url,
).href;

const owner = {
  pid: 4242,
  hostname: "workstation.local",
  startedAt: "2026-08-15T00:00:00.000Z",
  surface: "pi-cli",
  ownerId: "owner-id",
  processStartTime: 1_700_000_000_000,
  cooperativeHandoffAvailable: true,
};

test("ownership selectors disclose the PID and stage all destructive choices", async () => {
  const {
    canOfferRob,
    formatRequestHandoffPrompt,
    formatRobPrompt,
    formatSigkillPrompt,
  } = await import(COPY_DIST);

  assert.equal(canOfferRob(owner, "workstation.local"), true);
  assert.equal(canOfferRob({ ...owner, ownerId: null }, "workstation.local"), false);
  assert.equal(canOfferRob(owner, "another-host"), false);

  const request = formatRequestHandoffPrompt(owner);
  assert.match(request.title, /pid 4242/);
  assert.match(request.title, /workstation\.local/);
  assert.match(request.title, /Safest: return to or manage .* manually/);
  assert.match(request.requestOption, /^Request handoff/);
  assert.match(request.cancelOption, /^Cancel \(recommended\)/);
  assert.doesNotMatch(`${request.title}\n${request.requestOption}`, /Rob|SIGTERM|SIGKILL/,
    "the first selector does not expose force");

  const rob = formatRobPrompt(owner, "The owner is busy.");
  for (const warning of [
    /abort/i,
    /queued or unsent/i,
    /cannot undo .*tool side effects/i,
    /SIGTERM/,
    /authoritative writer lock/i,
    /SIGKILL.*explicit confirmation/i,
  ]) assert.match(rob.title, warning);
  assert.match(rob.cancelOption, /^Cancel \(recommended\)/);
  assert.match(rob.robOption, /^Rob session/);

  const kill = formatSigkillPrompt(owner);
  assert.match(kill.title, /SIGKILL.*pid 4242/);
  assert.match(kill.message, /without normal session_shutdown cleanup/);
  assert.match(kill.message, /prior tool side effects cannot be undone/);
  assert.match(kill.message, /writer lock/);
});

test("SIGKILL carries only the one-shot authorization returned after SIGTERM", async () => {
  const { HostedOwnershipConflictError } = await import(CLIENT_DIST);
  const error = new HostedOwnershipConflictError({
    sessionId: "blocked",
    sessionFile: "/tmp/blocked.jsonl",
    owner,
  });
  const calls = [];
  error.bindHandoffRequester(async (force, hard, confirmationToken) => {
    calls.push({ force, hard, confirmationToken });
    return hard
      ? { status: "released" }
      : { status: "needs-sigkill", confirmationToken: "one-shot-token" };
  });

  assert.equal((await error.requestHandoff(true)).status, "needs-sigkill");
  assert.equal((await error.requestHandoff(true, true)).status, "released");
  assert.deepEqual(calls, [
    { force: true, hard: false, confirmationToken: undefined },
    { force: true, hard: true, confirmationToken: "one-shot-token" },
  ]);
});
