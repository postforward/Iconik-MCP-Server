/**
 * TEST SEARCH
 *
 * Test script for Iconik search API filter syntax. Tests multiple filter
 * format variations (operator/terms vs array format) and logs results
 * for debugging search capabilities.
 */

import "dotenv/config";

async function test() {
  // First, test basic search to see what fields are available
  const res = await fetch('https://app.iconik.io/API/search/v1/search/', {
    method: 'POST',
    headers: {
      'App-ID': process.env.ICONIK_APP_ID!,
      'Auth-Token': process.env.ICONIK_AUTH_TOKEN!,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: '*',
      doc_types: ['assets'],
      per_page: 5
    })
  });
  const data = await res.json();
  console.log('Total assets:', data.total);
  console.log('\nSample asset:');
  if (data.objects?.[0]) {
    const asset = data.objects[0];
    console.log('  archive_status:', asset.archive_status);
    console.log('  status:', asset.status);
    console.log('  is_online:', asset.is_online);
  }

  // Now test filter syntax
  console.log('\n--- Testing filter syntax ---\n');

  // Try different filter formats
  const filterTests = [
    {
      name: 'filter.operator with terms',
      filter: {
        operator: "AND",
        terms: [{ name: "archive_status", value: "FAILED_TO_ARCHIVE" }]
      }
    },
    {
      name: 'filter array format',
      filter: [{ name: "archive_status", value: "FAILED_TO_ARCHIVE" }]
    }
  ];

  for (const test of filterTests) {
    console.log(`Testing: ${test.name}`);
    try {
      const filterRes = await fetch('https://app.iconik.io/API/search/v1/search/', {
        method: 'POST',
        headers: {
          'App-ID': process.env.ICONIK_APP_ID!,
          'Auth-Token': process.env.ICONIK_AUTH_TOKEN!,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: '*',
          doc_types: ['assets'],
          filter: test.filter,
          per_page: 5
        })
      });
      const filterData = await filterRes.json();
      if (filterRes.ok) {
        console.log(`  ✅ Success! Found ${filterData.total} assets`);
      } else {
        console.log(`  ❌ Error:`, JSON.stringify(filterData.errors || filterData, null, 2));
      }
    } catch (e) {
      console.log(`  ❌ Exception:`, e);
    }
  }
}

test();
