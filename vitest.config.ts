import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		restoreMocks: true,
		clearMocks: true,
		include: ['src/**/*.test.ts', '__tests__/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.test.ts',
				'src/__fixtures__/**',
				'src/index.ts',
				'src/types.ts',
				'src/octokit.ts',
				'src/logging.ts',
			],
			thresholds: {
				lines: 85,
				statements: 85,
				functions: 80,
				branches: 75,
			},
		},
	},
});
