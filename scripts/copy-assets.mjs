import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/widget/assets', { recursive: true });
await cp('assets', 'dist/widget/assets', { recursive: true });
