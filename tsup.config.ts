import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  clean: true,
  splitting: false,
  minify: true,
  // DECISION: keepNames is on, not off, because a user-reported stack trace must still name the function it failed in; it costs a few KB per bundle (T922).
  keepNames: true,
  sourcemap: false,
  dts: false,
});
