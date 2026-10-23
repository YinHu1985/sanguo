/** The monthly ruler budget is independent of officer actions and tactical AP.
 * Missing flags keep legacy callers limited. State creation/loading mirrors the
 * current rules so switching this off also works for existing campaigns. */
export const commandLimitEnabled = (state) => state.commandLimitEnabled !== false;

export const canIssueCommand = (state) => !commandLimitEnabled(state) || state.commandsRemaining > 0;

/** Preserve the original monthly accounting for later re-enabling the limit,
 * but never accumulate negative balances during unrestricted test play. */
export function consumeCommand(state) {
  state.commandsRemaining = Math.max(0, (Number(state.commandsRemaining) || 0) - 1);
}
