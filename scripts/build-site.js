// Builds the static website into site/dist (Netlify, GitHub Pages or any static host).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const site = new URL('site/', root);
const out = new URL('site/dist/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('assets/', out), { recursive: true });

// Everything in site/ except the output folder.
for (const name of readdirSync(site)) {
  if (name === 'dist') continue;
  cpSync(new URL(name, site), new URL(name, out), { recursive: true });
}
// Brand files and real product screenshots.
for (const f of ['handshake.css', 'mark.svg', 'logo.svg']) cpSync(new URL(`brand/${f}`, root), new URL(`assets/${f}`, out));
for (const f of ['consent.png', 'my-tools.png', 'install.png']) {
  const src = new URL(`docs/images/${f}`, root);
  if (existsSync(src)) cpSync(src, new URL(`assets/${f}`, out));
}
console.log(`Built ${out.pathname}`);
