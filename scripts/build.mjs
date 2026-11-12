import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/web/', import.meta.url);
const output = new URL('../dist/', import.meta.url);

await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, filter: path => !path.endsWith('README.md') });
console.log('Browserbestanden gebouwd in dist/. Voor de AI- en FFmpeg-routes gebruik je npm start.');
