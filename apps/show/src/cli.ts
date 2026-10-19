import { parseArgs } from "node:util";
import { dispatch } from "./dispatch.js";
import { runDryRun } from "./dry-run.js";
import { serviceMain } from "./service.js";
import { runSpecialPublish } from "./special/publish-cli.js";
import { fromInvocationDir } from "./special/paths.js";
import { runSpecialRender } from "./special/render-cli.js";
import { parseWeekArg } from "./weeks.js";

// `pnpm run show` is one timer run; `--dry-run` and `--render <dir>` are the read-only
// review paths (spec §10). ⚠️ `pnpm run show`, never `pnpm show`: the latter is pnpm's
// own `view` command.
const { values } = parseArgs({
  options: {
    week: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "print-prompt": { type: "boolean", default: false },
    render: { type: "string" },
    force: { type: "boolean", default: false },
    repost: { type: "boolean", default: false },
    special: { type: "string" },
    publish: { type: "string" },
  },
});

const d = dispatch(values);
if (d.kind === "usage") {
  process.stderr.write(`${d.message}\n`);
  process.exit(2);
}

if (d.kind === "special-render") {
  process.exitCode = await runSpecialRender({ dir: fromInvocationDir(values.special!), out: fromInvocationDir(values.render!) });
} else if (d.kind === "special-publish") {
  process.exitCode = await runSpecialPublish({ dir: fromInvocationDir(values.special!), out: fromInvocationDir(values.publish!) });
} else if (d.kind === "review") {
  process.exitCode = await runDryRun({ week: values.week, printPrompt: values["print-prompt"], render: values.render });
} else {
  process.exitCode = await serviceMain({ week: values.week ? parseWeekArg(values.week) : undefined, force: values.force, repost: values.repost });
}
