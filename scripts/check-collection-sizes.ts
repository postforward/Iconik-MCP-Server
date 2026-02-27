#!/usr/bin/env npx tsx

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const collectionId = process.argv.slice(2).filter(a => !a.startsWith('--'))[0] || '43c67a0c-0450-11f1-9646-ca893459883b';

interface File {
  id: string;
  name: string;
  size: number;
  status: string;
  storage_id: string;
}

interface CollectionContent {
  id: string;
  object_type: string;
  title?: string;
}

async function main() {
  const contents = await iconikRequest<{ objects: CollectionContent[] }>(
    `assets/v1/collections/${collectionId}/contents/?per_page=10`
  );

  for (const item of contents.objects || []) {
    if (item.object_type === 'assets') {
      console.log('Asset:', item.title);

      const files = await iconikRequest<{ objects: File[] }>(`files/v1/assets/${item.id}/files/`);
      for (const f of files.objects || []) {
        console.log('  File:', f.name, '| Size:', f.size, '| Status:', f.status);
      }
      console.log('');
    }
  }
}

main().catch(console.error);
