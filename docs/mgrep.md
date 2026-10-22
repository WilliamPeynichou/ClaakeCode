# Optional Mixedbread mgrep tool

The existing `grep` tool continues to use ripgrep locally. `mgrep` adds semantic search and is disabled by default in tool settings.

## Privacy and costs

Mixedbread stores indexed files in its cloud. Review its terms, pricing, `.gitignore` and `.mgrepignore` before indexing. Enabling the tool does not install the CLI, log in, upload files or start a watcher.

## Setup (manual)

1. Install Node.js and `npm install -g @mixedbread/mgrep`.
2. Run `mgrep login` in your terminal.
3. Review ignore rules and explicitly run `mgrep watch` from the desired workspace to upload/index files. Stop it when appropriate.
4. Ensure the CLI is available in the PATH inherited by Claake Code, then enable **Mgrep** in tool settings.

The agent tool accepts `query` and an optional `limit` (1–25, default 10). It searches from the workspace root with content snippets. Automatic sync, web search, answer generation and agentic search are disabled through environment overrides. Searches may incur Mixedbread usage costs. Index freshness remains under user control.

The tool has a 30-second timeout and bounded output. There is no automatic installation, authentication or fallback masquerading as semantic search: missing CLI/authentication/index errors are returned to the agent, which can use `grep` instead.
