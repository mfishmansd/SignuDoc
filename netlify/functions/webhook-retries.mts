import type { Config } from "@netlify/functions";

import { callInternalJob } from "./_call-internal-job.mts";

// Sends webhook deliveries that are due for another try. Netlify's
// scheduled functions run as often as every minute on any plan, so this
// runs every five minutes rather than Vercel Hobby's once a day.
const retryWebhooks = () => callInternalJob("/api/internal/webhooks");

export default retryWebhooks;

export const config: Config = { schedule: "*/5 * * * *" };
