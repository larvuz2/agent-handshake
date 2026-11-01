// Builds the static website into site/dist (used by the GitHub Pages workflow).
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = new URL('../site/dist/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('assets/', out), { recursive: true });
cpSync(new URL('../site/index.html', import.meta.url), new URL('index.html', out));
for (const f of ['handshake.css', 'mark.svg', 'logo.svg']) cpSync(new URL(`../brand/${f}`, import.meta.url), new URL(`assets/${f}`, out));
console.log(`Built ${out.pathname}`);
