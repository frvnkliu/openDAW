# Studio MCP: the Script API for agents

Let an agent edit an openDAW project without a browser, through the Script API. The agent writes the same scripts as
the studio's script editor. A Node host checks each script, runs it in a worker, applies its changes to a project file
as one undoable request, and gives back the console output.

This is the "Bring your own AI" case of the manual's AI page: the user brings the agent. It adds no prompting and no
generation to openDAW.

## Design

* No new Script API. The host implements `ScriptHostProtocol`: `fetchProject` gives the project file, and
  `applyUpdates` applies the update tasks with the same checksum check as `CodeEditorPage` and records the updates as
  `BoxEditing` does. Undo inverts them.
* The worker runs the existing `ScriptRunner`. The connection code of `ScriptWorker.ts` and `ScriptHost.ts` moves
  into `ScriptConnection.ts` without a change in behaviour, so that the Node worker and host use the same code.
* The type check uses the compiler options and declaration files of the editor (`monaco-setup.ts`), with TypeScript
  from the repository instead of Monaco's.
* The `docs` tool gives the existing guide (`packages/studio/scripting/docs/guide`) and the declarations.
* A workspace is a directory with `project.od` and `requests/`. Each request keeps its script, its result and the
  updates for undo.

## Pull requests

1. lib-box: process a constructor pointer before a later change of the same pointer. Without it, undo fails for a
   script that adds a unit and sets its output to null, in the studio and here.
2. The package with `run`, `undo` and `docs`, as commands and as an MCP server.
3. Rendering: `renderMixdown` and `saveFile` in the Node host, and samples.

## Questions

1. Location: `packages/studio/mcp` as `@opendaw/studio-mcp`?
2. Rendering in Node: the core-wasm tests already render projects in Node (`test/helpers/load-full-engine.ts` and
   `render-od.ts`). Can that code move into `src` as a Node entry of `studio-core-wasm`, or should the host run
   `offline-worker.ts` in a worker thread?

## How this was written

Code, tests and this plan written with Claude Code (Claude Opus 5.5), and reviewed by the contributor.
