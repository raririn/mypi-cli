import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bashGuardExtension, {
	buildBlockMessage,
	detectDangerousCommand,
	splitCommandSegments,
} from "../../src/product/mypi-bash-guard.ts";

const rule = (command: string) => detectDangerousCommand(command)?.rule;

describe("bash-guard detector: find-root", () => {
	it("flags filesystem-wide scans", () => {
		assert.equal(rule("find / -name foo.conf"), "find-root");
		assert.equal(rule("find /usr -type f -mtime -1"), "find-root");
		assert.equal(rule("find /var -name '*.log'"), "find-root");
		assert.equal(rule("sudo find / -perm -4000"), "find-root");
		assert.equal(rule("timeout 30 find / -name x"), "find-root");
		assert.equal(rule("find / -name '*.log' | head -5"), "find-root");
		assert.equal(rule("find -L / -name x"), "find-root");
	});

	it("allows scoped searches", () => {
		assert.equal(rule("find . -name foo"), undefined);
		assert.equal(rule("find ./src -name '*.ts'"), undefined);
		assert.equal(rule("find /etc -name '*.conf'"), undefined);
		assert.equal(rule("find /tmp/build -type d"), undefined);
		assert.equal(rule("find -name foo"), undefined);
		assert.equal(rule("find node_modules -maxdepth 2"), undefined);
	});
});

describe("bash-guard detector: rm-dangerous", () => {
	it("flags root, home, cwd-bomb, and unexpanded-variable targets", () => {
		assert.equal(rule("rm -rf /"), "rm-dangerous");
		assert.equal(rule("rm -rf /*"), "rm-dangerous");
		assert.equal(rule("rm -fr ~"), "rm-dangerous");
		assert.equal(rule("rm -rf $HOME"), "rm-dangerous");
		assert.equal(rule("rm -r /usr"), "rm-dangerous");
		assert.equal(rule("rm -rf /home/*"), "rm-dangerous");
		assert.equal(rule("rm -rf ."), "rm-dangerous");
		assert.equal(rule("rm -rf *"), "rm-dangerous");
		assert.equal(rule("rm -rf ./*"), "rm-dangerous");
		assert.equal(rule("rm -rf $BUILD_DIR/"), "rm-dangerous");
		assert.equal(rule("rm -rf ${OUT_DIR}/*"), "rm-dangerous");
		assert.equal(rule("rm --no-preserve-root -rf /"), "rm-dangerous");
		assert.equal(rule("sudo rm -rf /var"), "rm-dangerous");
		assert.equal(rule('rm -rf "/"'), "rm-dangerous");
		assert.equal(rule("echo done && rm -rf /"), "rm-dangerous");
		assert.equal(rule("echo $(rm -rf /)"), "rm-dangerous");
	});

	it("allows ordinary removals", () => {
		assert.equal(rule("rm foo.txt"), undefined);
		assert.equal(rule("rm -rf ./build"), undefined);
		assert.equal(rule("rm -rf node_modules"), undefined);
		assert.equal(rule("rm -rf /tmp/scratch-123"), undefined);
		assert.equal(rule("rm -rf dist coverage"), undefined);
		assert.equal(rule("rm -f $LOCKFILE"), undefined);
		assert.equal(rule("rm -rf $WORKDIR/build"), undefined);
	});
});

describe("bash-guard detector: chmod-recursive-root", () => {
	it("flags recursive permission blasts", () => {
		assert.equal(rule("chmod -R 777 /"), "chmod-recursive-root");
		assert.equal(rule("chmod -R 777 ~"), "chmod-recursive-root");
		assert.equal(rule("chmod -R 755 /usr"), "chmod-recursive-root");
		assert.equal(rule("chmod --recursive 777 $HOME"), "chmod-recursive-root");
	});

	it("allows scoped chmod", () => {
		assert.equal(rule("chmod -R 755 ./public"), undefined);
		assert.equal(rule("chmod 777 ./script.sh"), undefined);
		assert.equal(rule("chmod +x run.sh"), undefined);
	});
});

describe("bash-guard detector: fs-destroy", () => {
	it("flags filesystem and raw-device destruction", () => {
		assert.equal(rule("mkfs.ext4 /dev/sdb1"), "fs-destroy");
		assert.equal(rule("wipefs -a /dev/nvme0n1"), "fs-destroy");
		assert.equal(rule("dd if=disk.img of=/dev/sda bs=4M"), "fs-destroy");
		assert.equal(rule("echo x > /dev/sda"), "fs-destroy");
		assert.equal(rule("cat img >/dev/nvme0n1p2"), "fs-destroy");
	});

	it("allows benign dd and redirects", () => {
		assert.equal(rule("dd if=/dev/urandom of=key.bin bs=32 count=1"), undefined);
		assert.equal(rule("echo hi > /dev/null"), undefined);
		assert.equal(rule("dd if=a.img of=b.img"), undefined);
	});
});

describe("bash-guard segment splitting", () => {
	it("splits on control operators and subshells, strips quotes", () => {
		assert.deepEqual(splitCommandSegments("echo hi; rm -rf /"), [["echo", "hi"], ["rm", "-rf", "/"]]);
		assert.deepEqual(splitCommandSegments('rm -rf "/"'), [["rm", "-rf", "/"]]);
		assert.deepEqual(splitCommandSegments("echo `rm x`"), [["echo"], ["rm", "x"]]);
		assert.deepEqual(splitCommandSegments("a && b || c | d"), [["a"], ["b"], ["c"], ["d"]]);
	});

	it("does not split inside quotes", () => {
		assert.deepEqual(splitCommandSegments("grep 'a && b' file"), [["grep", "a && b", "file"]]);
		assert.equal(rule("grep 'rm -rf /' README.md"), undefined);
		assert.equal(rule('echo "find / is dangerous"'), undefined);
	});
});

describe("bash-guard block message", () => {
	it("names the rule and forbids bypasses", () => {
		const match = detectDangerousCommand("rm -rf /");
		assert.ok(match);
		const message = buildBlockMessage(match);
		assert.match(message, /rule: rm-dangerous/);
		assert.match(message, /run the exactly same command again/);
		assert.match(message, /Do NOT attempt to bypass/);
	});
});

type Handler = (event: any, ctx: any) => unknown;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: { emit() {} },
	};
	const fire = async (event: string, payload: any, ctx: any) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(payload, ctx);
			if (result) return result;
		}
		return result;
	};
	return { pi, fire };
}

const bashCall = (command: string) => ({ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } });

describe("bash-guard extension flow", () => {
	it("block → exact re-run confirms → approval admits exactly one execution", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		let confirms = 0;
		const ctx = { hasUI: true, ui: { confirm: async () => { confirms += 1; return true; } } };

		const first = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(first.block, true);
		assert.match(first.reason, /rule: rm-dangerous/);
		assert.equal(confirms, 0);

		const second = await fire("tool_call", bashCall("rm -rf /"), ctx);
		assert.equal(second, undefined);
		assert.equal(confirms, 1);

		// Approval was single-use: the third attempt starts a fresh cycle.
		const third = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(third.block, true);
		assert.match(third.reason, /blocked by a safety rule/);
		assert.equal(confirms, 1);
	});

	it("a different dangerous command needs its own cycle", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		const ctx = { hasUI: true, ui: { confirm: async () => true } };

		await fire("tool_call", bashCall("rm -rf /"), ctx);
		const other = (await fire("tool_call", bashCall("find / -name x"), ctx)) as any;
		assert.equal(other.block, true);
		assert.match(other.reason, /rule: find-root/);
	});

	it("denial blocks the command for the rest of the run", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		const ctx = { hasUI: true, ui: { confirm: async () => false } };

		await fire("tool_call", bashCall("rm -rf /"), ctx);
		const denied = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(denied.block, true);
		assert.match(denied.reason, /user disapproved/);

		const again = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(again.block, true);
		assert.match(again.reason, /user disapproved/);
	});

	it("state resets on new input", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		const ctx = { hasUI: true, ui: { confirm: async () => { throw new Error("confirm must not be called after reset"); } } };

		await fire("tool_call", bashCall("rm -rf /"), ctx);
		await fire("input", { source: "user", text: "next task" }, ctx);
		const afterReset = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(afterReset.block, true);
		assert.match(afterReset.reason, /blocked by a safety rule/);
	});

	it("blocks without UI instead of prompting", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		const ctx = { hasUI: false, ui: {} };

		await fire("tool_call", bashCall("rm -rf /"), ctx);
		const second = (await fire("tool_call", bashCall("rm -rf /"), ctx)) as any;
		assert.equal(second.block, true);
		assert.match(second.reason, /no approval UI/);
	});

	it("ignores safe commands and non-bash tools", async () => {
		const { pi, fire } = createFakePi();
		bashGuardExtension(pi as any);
		const ctx = { hasUI: true, ui: { confirm: async () => true } };
		assert.equal(await fire("tool_call", bashCall("ls -la"), ctx), undefined);
		assert.equal(await fire("tool_call", { type: "tool_call", toolCallId: "t2", toolName: "read", input: { path: "/" } }, ctx), undefined);
	});
});
