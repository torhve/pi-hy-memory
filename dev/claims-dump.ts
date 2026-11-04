import { readFileSync } from "node:fs";
import type { BankEntry } from "../src/types.js";
import { suiteClaims } from "./suite-claim.js";

for (const run of process.argv.slice(2)) {
	const bank = JSON.parse(readFileSync(`out/${run}/bank.json`, "utf8")) as BankEntry[];
	console.log("===", run);
	for (const e of bank) {
		if (e.status !== "active") continue;
		const claims = suiteClaims(e.statement);
		if (claims.length === 0) continue;
		console.log(
			claims.map((c) => `${c.mode} ${c.value} ${c.record ? "record" : "assert"}`).join(", "),
			"|",
			e.statement.slice(0, 200),
		);
	}
}
