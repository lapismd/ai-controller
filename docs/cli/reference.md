# Controller command reference

Generated from the command tree.

## init

Initialize private configuration and credentials.

Options: `--workspace`.

## serve

Run the durable controller and its execution providers.

Options: global options only.

## status

Inspect the running controller.

Options: `--watch`.

## doctor

Check local configuration and permissions without starting agents.

Options: global options only.

## config show

Show configuration with credential references.

Options: global options only.

## config validate

Validate configuration and private credentials.

Options: global options only.

## service install

Install the user service.

Options: global options only.

## service start

Start the user service.

Options: global options only.

## service stop

Stop the user service.

Options: global options only.

## service restart

Restart the user service.

Options: global options only.

## service status

Status the user service.

Options: global options only.

## service uninstall

Uninstall the user service.

Options: global options only.

## logs

Read structured service logs.

Options: `--follow`.

## providers list

List authorized providers and capabilities.

Options: global options only.

## threads list

List owned execution threads.

Options: global options only.

## threads create

Create a provider-bound thread.

Options: `--provider`, `--workspace`, `--private`.

## threads show

Read thread, turns, interactions and replay cursor.

Options: `--thread`.

## turns submit

Durably accept one turn with a stable command identity.

Options: `--thread`, `--command`, `--text`.

## turns show

Inspect execution and output completeness.

Options: `--turn`.

## turns cancel

Request cancellation; inspect the eventual outcome.

Options: `--turn`.

## commands show

Resolve a lost command acknowledgement.

Options: `--command`.

## events watch

Watch committed thread snapshots and events.

Options: `--thread`.

## interactions respond

Answer a live approval or structured question.

Options: `--id`, `--response`.

## context show

Inspect retained turn preparation and omissions.

Options: `--turn`.

## memory search

Search the thread's authorized memory scope.

Options: `--thread`, `--query`.

## memory get

Read memory and its source evidence.

Options: `--thread`, `--ref`.

## token show

Explicitly reveal the configured client token.

Options: global options only.
