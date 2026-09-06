import {copyFileSync,mkdirSync} from 'node:fs';
mkdirSync('public/maplibre',{recursive:true});
for(const file of ['maplibre-gl-worker.mjs','maplibre-gl-shared.mjs'])copyFileSync(`node_modules/maplibre-gl/dist/${file}`,`public/maplibre/${file}`);
