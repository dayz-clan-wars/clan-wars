import { parseArgs } from "node:util";
import { runDryRun } from "./dry-run.js";
import { serviceMain } from "./service.js";
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
  },
});

if (values["dry-run"] || values.render) {
  process.exitCode = await runDryRun({ week: values.week, printPrompt: values["print-prompt"], render: values.render });
} else {
  process.exitCode = await serviceMain({ week: values.week ? parseWeekArg(values.week) : undefined, force: values.force, repost: values.repost });
}
