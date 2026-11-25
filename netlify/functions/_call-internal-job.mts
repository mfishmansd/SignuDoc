// Calls one of the app's /api/internal jobs the way Vercel's cron does: a
// GET with CRON_SECRET as a bearer token. Shared by the scheduled functions
// beside it, which are Netlify's stand-in for the crons in vercel.json.

export async function callInternalJob(path: string): Promise<Response> {
  const siteUrl = process.env.URL ?? process.env.APP_URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl) {
    console.error(`[${path}] neither URL nor APP_URL is set; nothing called.`);
    return new Response(null, { status: 500 });
  }

  if (!secret) {
    console.error(
      `[${path}] CRON_SECRET is not set. Set it in the site's environment so the job runs as a trusted caller.`,
    );
    return new Response(null, { status: 500 });
  }

  const response = await fetch(new URL(path, siteUrl), {
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await response.text().catch(() => "");

  if (!response.ok) {
    console.error(
      `[${path}] answered ${String(response.status)}: ${body.slice(0, 500)}`,
    );
  } else {
    console.log(`[${path}] ${String(response.status)} ${body.slice(0, 500)}`);
  }

  return new Response(null, { status: response.ok ? 200 : 502 });
}
