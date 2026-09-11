#!/usr/bin/env npx tsx
/**
 * Register / list / disable / delete an iconik Custom Action.
 *
 *   npx tsx scripts/register-custom-action.ts --profile=<profile> --context=ASSET \
 *     --title="Send to ElevenLabs (transcribe)" --url=https://<your-n8n-host>/webhook/elevenlabs-send \
 *     [--metadata-view=<view uuid>]          # iconik shows this view as a form before POSTing
 *     [--type=POST|OPEN]                     # OPEN = iconik opens the URL in a new tab (default POST)
 *   npx tsx scripts/register-custom-action.ts --profile=<profile> --context=ASSET --list
 *   npx tsx scripts/register-custom-action.ts --profile=<profile> --context=ASSET --disable=<action id>   (or --enable=)
 *   npx tsx scripts/register-custom-action.ts --profile=<profile> --context=ASSET --delete=<action id>
 *
 * Notes: context is uppercase (ASSET|COLLECTION|BULK|...). Do NOT pass app_id (500). Updates must use the
 * context-scoped PUT /custom_actions/{context}/{id}/ with a full body (the unscoped path 404s).
 */
import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

initializeProfile(getProfileFromArgs());
const args = process.argv.slice(2);
const arg = (n: string, d?: string) => args.find(a => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") ?? d;
const context = arg("context", "COLLECTION")!;
const title = arg("title", "Custom Action")!;
const url = arg("url");
const metadataView = arg("metadata-view");
const actionType = (arg("type", "POST") || "POST").toUpperCase();

async function setDisabled(id: string, disabled: boolean) {
  const cur = await iconikRequest<any>(`assets/v1/custom_actions/${context}/${id}/`);
  const { id: _i, date_created, date_modified, last_error, ...rest } = cur;
  const res = await iconikRequest<any>(`assets/v1/custom_actions/${context}/${id}/`, { method: "PUT", body: JSON.stringify({ ...rest, disabled }) });
  console.log(`${disabled ? "Disabled" : "Enabled"}: ${res.id} [${res.context}] ${res.title}`);
}

(async () => {
  if (args.includes("--list")) {
    const res = await iconikRequest<any>(`assets/v1/custom_actions/${context}/`);
    for (const a of (res.objects || [])) console.log(`${a.id}  [${a.context}] ${a.title}  -> ${a.url}  (${a.type}${a.metadata_view ? `, view ${a.metadata_view}` : ""}${a.disabled ? ", DISABLED" : ""})`);
    return;
  }
  if (arg("disable")) return setDisabled(arg("disable")!, true);
  if (arg("enable")) return setDisabled(arg("enable")!, false);
  if (arg("delete")) {
    await iconikRequest(`assets/v1/custom_actions/${context}/${arg("delete")}/`, { method: "DELETE" });
    console.log(`Deleted custom action ${arg("delete")}`);
    return;
  }
  if (!url) { console.error("--url is required (the n8n webhook URL)"); process.exit(1); }
  const body: Record<string, unknown> = { title, url, type: actionType, context };
  if (metadataView) body.metadata_view = metadataView;
  const res = await iconikRequest<any>(`assets/v1/custom_actions/${context}/`, { method: "POST", body: JSON.stringify(body), noRetry5xx: true } as any);
  console.log("Created custom action:");
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => { console.error("Error:", e instanceof Error ? e.message : e); process.exit(1); });
