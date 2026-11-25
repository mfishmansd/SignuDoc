import type { Config } from "@netlify/functions";

import { callInternalJob } from "./_call-internal-job.mts";

// Daily cleanup: retention, deadlines, reminders, abandoned uploads.
const runRetentionJob = () => callInternalJob("/api/internal/retention");

export default runRetentionJob;

export const config: Config = { schedule: "0 9 * * *" };
