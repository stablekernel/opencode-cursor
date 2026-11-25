import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugin tests must never read the developer's real opencode auth.json
// (a stored Cursor key would trigger live discovery).
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "oc-cursor-test-data-"));
