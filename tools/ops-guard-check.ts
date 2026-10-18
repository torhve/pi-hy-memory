import { parseOps } from "../src/protocol.js";

const bank = new Set(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
const allowed = new Map<number, Set<string>>([
	[0, bank],
	[1, bank],
	[2, bank],
]);

// Real failure: two drafts in one chunk both UPDATE the same entry id.
const doubleTarget = parseOps(
	JSON.stringify({
		ops: [
			{ action: "UPDATE", draft: 0, target: "aaaaaaaaaaaa" },
			{ action: "UPDATE", draft: 1, target: "aaaaaaaaaaaa" },
			{ action: "UPDATE", draft: 2, target: "bbbbbbbbbbbb" },
		],
	}),
	3,
	bank,
	allowed,
);
console.log("ops:", doubleTarget.ops.map((o) => `${o.action}:${o.action === "DELETE" ? o.target : o.draft}`).join(" "));
console.log("downgraded:", doubleTarget.downgraded.length, "| rejected:", doubleTarget.rejected.length);

// Cross-draft target guard must still win over the new one.
const crossDraft = parseOps(
	JSON.stringify({ ops: [{ action: "UPDATE", draft: 0, target: "bbbbbbbbbbbb" }] }),
	1,
	bank,
	new Map([[0, new Set(["aaaaaaaaaaaa"])]]),
);
console.log("cross-draft ->", crossDraft.ops[0].action, "| downgraded:", crossDraft.downgraded.length);
