section: Added
- `.github/workflows/copilot-setup-steps.yml`: installs Node 22 in the GitHub
  Copilot coding agent's container before it starts. Forge's PreToolUse
  guards are Node scripts; without `node` on PATH they failed to spawn and
  the harness blocked every Bash, Edit and Write call — the agent could not
  work at all. Installing Node makes the guards run for the coding agent
  rather than exempting it: it is an actor with push access, exactly what
  merge-gate exists to gate. The job also proves `pre-bash.js` spawns, so a
  regression shows up as a red setup job, not a silent block.
