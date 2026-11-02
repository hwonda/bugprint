# Release checklist

These steps need your accounts, so bugprint's tooling cannot do them for you.

1. **Identity.** The repository fields and `mcpName` (`io.github.hwonda/bugprint`) are filled in. Still to do: add `"author": "Your Name <you@example.com>"` to `package.json` and put your name in `LICENSE`. `mcpName` must stay equal to `name` in `server.json`.
2. **GitHub.** https://github.com/hwonda/bugprint. CI runs on pushes to `main` and `feat/**` and on pull requests; Windows is only verified there.
3. **Version.** Bump `version` in `package.json`, `src/version.ts` and `server.json` (both fields) together, then move the "Unreleased" section of `CHANGELOG.md` under the new version.
4. **npm.** Check that the name is still free (`npm view bugprint` should return 404), then run:
   ```bash
   npm run check && npm run build && npm pack --dry-run
   npm publish --access public
   ```
5. **MCP Registry.** Install `mcp-publisher` (`brew install mcp-publisher`), then run:
   ```bash
   mcp-publisher validate
   mcp-publisher login github
   mcp-publisher publish
   ```
   The `server.json` schema follows the registry docs as of 2026-11 (schema `2025-12-11`). The registry is still in preview, so run `mcp-publisher validate` first.
