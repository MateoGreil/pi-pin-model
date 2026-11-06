# pi-pin-model

A Pi extension guarding the saved default provider/model and, when present in the pin, thinking level. It stores `pinned-model.json` next to the agent's `settings.json`, using `PI_CODING_AGENT_DIR` or otherwise `~/.pi/agent`.

## Install

Remove the old local `~/.pi/agent/extensions/pin-model.ts` and any explicit configuration pointing to it **before installing**, to avoid duplicate commands and settings writers. If using a different agent directory, remove the copy there instead.

Once the repository and `v0.1.0` tag are available:

```sh
pi install git:github.com/MateoGreil/pi-pin-model@v0.1.0
```

## Commands

- `/pin-model`: pin the current session's provider/model.
- `/pin-model provider/model`: pin the supplied provider/model without checking model availability.
- `/pin-model --show`: show the pin, if any.
- `/pin-model --clear`: delete the pin file, leaving settings unchanged.

## Behavior and limitations

- On extension load, an absent pin file is automatically seeded from valid saved defaults, including `defaultThinkingLevel` when present. **Clearing is not permanent:** the next extension load seeds a new pin if valid defaults remain.
- On session start and shutdown, saved defaults that differ from the pin are restored. Pinning via the command also restores them immediately. Unrelated settings fields are preserved, but the JSON file is reformatted.
- Session model selection only displays an informational notification; it does not change the active model or immediately rewrite settings. Events with source `restore` are ignored.
- A command-created pin includes only provider/model, not the current thinking level. It replaces any previous pin's thinking level and leaves the saved thinking default untouched.
- Only existing, readable JSON settings with string provider/model defaults can be restored. Missing/malformed settings are not created or repaired; project settings are not managed. File writes are synchronous, non-atomic, and not coordinated across processes.
- Pi 1.5.0 already separates ordinary session model switches from configured defaults. This extension guards saved-file drift; it does not replace Pi's model-selection behavior.

Tested for Pi **1.5.0** using offline API fakes. Pi apps and other versions are not certified; no live-provider integration is tested.

## Tests

Requires Node.js **>=22.22.0**. Run `npm test`; no package installation is needed for these tests. `node:test` uses disposable settings directories inside this worktree, sets `PI_CODING_AGENT_DIR` **before each dynamic import**, and never reads or writes actual home settings. No network calls or credentials are used. Only `src/index.ts` is loaded by the Pi manifest.

## License

No license has been selected (`UNLICENSED`). This public Git package is marked `private: true` to prevent accidental npm publication.
