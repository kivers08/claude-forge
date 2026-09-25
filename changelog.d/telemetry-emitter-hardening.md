section: Fixed
- Telemetry flush now honors an `accepted:false` acknowledgment: a 2xx response whose JSON body has `accepted === false` is treated as a transient rejection and its records are retained (empty/non-JSON/other bodies still count as success).
- Telemetry flush rotates the buffer atomically (rename to a unique `.sending` sibling) before reading, so records appended by concurrent hooks during a flush are no longer lost; unsent records are appended back to the live buffer, never overwritten.
- Telemetry flush groups buffered records by their own `session_id` and sends one batch per session, so a shared cross-session buffer no longer mixes sessions into a single batch.
- Telemetry flush splits each session's records into size-bounded chunks (new `telemetry.maxBatchBytes` config, default 90000) so an oversized POST cannot be permanently rejected; a single record larger than the cap is dropped and noted via the telemetry log.
