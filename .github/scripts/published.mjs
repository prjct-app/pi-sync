import { readFile, appendFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const url = `https://registry.npmjs.org/${manifest.name.replace('/', '%2F')}/${manifest.version}`;
const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
if (response.status === 404) {
  await appendFile(process.env.GITHUB_OUTPUT, 'published=false\n');
} else {
  if (!response.ok) throw new Error(`Registry check failed: ${response.status}`);
  const published = await response.json();
  if (published.pi?.image !== manifest.pi?.image) throw new Error('The existing npm version has different preview metadata; bump the package version.');
  await appendFile(process.env.GITHUB_OUTPUT, 'published=true\n');
  console.log(`${manifest.name}@${manifest.version} is already published with the expected cover metadata.`);
}
