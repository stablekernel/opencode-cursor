import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The plugin mirrors skills into <cwd>/.cursor/skills/ while dogfooding
    // this repo, and default vitest discovery then collects the mirrored
    // skills' own test files (94 load failures for anyone running `npm test`
    // locally). .cursor/ is gitignored; exclude it from test discovery.
    exclude: [...configDefaults.exclude, ".cursor/**"],
  },
});
