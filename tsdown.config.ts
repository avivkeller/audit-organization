import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['./src/index.ts'],
	format: ['esm'],
	platform: 'node',
	target: 'node20',
	clean: true,
	shims: true,
	dts: false,
	outDir: 'dist',
	minify: false,
	sourcemap: false,
	deps: {
		alwaysBundle: [/.*/],
	},
});
