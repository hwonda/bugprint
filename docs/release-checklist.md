# Release checklist

These steps need your accounts, so bugprint's tooling cannot do them for you.

1. **Identity.** Replace `YOUR_GITHUB_USER` in `server.json`. Then add these fields to `package.json`:
   ```json
   "author": "Your Name <you@example.com>",
   "repository": { "type": "git", "url": "git+https://github.com/YOUR_GITHUB_USER/bugprint.git" },
   "homepage": "https://github.com/YOUR_GITHUB_USER/bugprint#readme",
   "bugs": "https://github.com/YOUR_GITHUB_USER/bugprint/issues",
   "mcpName": "io.github.YOUR_GITHUB_USER/bugprint"
   ```
   `mcpName` must equal `name` in `server.json`. Also put your name in `LICENSE`.
2. **GitHub.** Create the repository and push `main`. CI runs on Linux, macOS and Windows; Windows is only verified there.
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
