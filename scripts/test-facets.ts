/**
 * TEST FACETS
 *
 * Test script for the Iconik search API facets. Performs a basic search
 * query and logs the facets structure returned by the API.
 */

import "dotenv/config";

async function test() {
  const res = await fetch("https://app.iconik.io/API/search/v1/search/", {
    method: "POST",
    headers: {
      "App-ID": process.env.ICONIK_APP_ID!,
      "Auth-Token": process.env.ICONIK_AUTH_TOKEN!,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "*",
      doc_types: ["assets"],
      per_page: 1,
      facets: ["media_type"]
    })
  });
  const data = await res.json();
  console.log("Facets structure:", JSON.stringify(data.facets, null, 2));
}
test();
