import { writeFileSync } from 'node:fs';
import { tokensCss } from '../src/tokens.ts';

writeFileSync(new URL('../tokens.css', import.meta.url), tokensCss());
