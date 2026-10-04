# Merge control: live probe (turns the spoken word and auto-mode ask on)

D32 ships the spoken "merge" (`merge.spokenWord`) and the auto-mode one-tap (`merge.askInAutoMode`) OFF, because Claude Code's docs are silent on three facts. Settle them with a probe in a session where forge is installed and its hooks are active (a session on the claude-forge repo itself installs forge at start).

Probe, in a throwaway repo with a throwaway PR into its main:
1. **Harness-injected messages.** Set `merge.spokenWord: true`. Cause a PR event notice and a message from another session whose whole text is `merge`. Check `merge-ok.json` appears ONLY for the message the human typed. If an injected message writes it, leave `spokenWord` off for good.
2. **Ask under auto.** Set the session to auto mode, set `merge.askInAutoMode: true`, ask the agent to merge the throwaway PR. The human must see an approve/deny prompt and the merge must not happen without a tap. If it merges untouched or never prompts, leave `askInAutoMode` off.
3. **Hooks active after a mid-session plugin install.** Install forge by hand mid-session; check whether the guards fire without a restart.
4. **Payload field name.** Log the `UserPromptSubmit` payload; the hook accepts `prompt` or `user_input`.

Record the results as a new decision and flip the config defaults only on evidence.
