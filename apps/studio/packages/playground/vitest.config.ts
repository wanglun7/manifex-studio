import path from 'node:path';
import { defineConfig } from 'vitest/config';

const scopedAtAliasPlugin = () => {
  const playgroundSrc = path.resolve(__dirname, './src');
  const playgroundUiSrc = path.resolve(__dirname, '../playground-ui/src');

  return {
    name: 'scoped-at-alias',
    enforce: 'pre' as const,
    async resolveId(source: string, importer?: string) {
      if (!source.startsWith('@/')) {
        return;
      }

      const baseDir = importer?.includes('/packages/playground-ui/src/') ? playgroundUiSrc : playgroundSrc;
      return this.resolve(path.resolve(baseDir, source.slice(2)), importer, { skipSelf: true });
    },
  };
};

export default defineConfig({
  plugins: [scopedAtAliasPlugin()],
  resolve: {
    alias: [
      {
        find: /^@internal\/core\/(.+)$/,
        replacement: path.resolve(__dirname, '../_internal-core/src/$1/index.ts'),
      },
      {
        find: /^@internal\/ai-sdk-v4\/(.+)$/,
        replacement: path.resolve(__dirname, '../_vendored/ai_v4/src/$1.ts'),
      },
      {
        find: '@internal/ai-sdk-v4',
        replacement: path.resolve(__dirname, '../_vendored/ai_v4/src/index.ts'),
      },
      {
        find: /^@internal\/ai-sdk-v5\/(.+)$/,
        replacement: path.resolve(__dirname, '../_vendored/ai_v5/src/$1.ts'),
      },
      {
        find: '@internal/ai-sdk-v5',
        replacement: path.resolve(__dirname, '../_vendored/ai_v5/src/index.ts'),
      },
      {
        find: /^@internal\/ai-v6\/(.+)$/,
        replacement: path.resolve(__dirname, '../_vendored/ai_v6/src/$1.ts'),
      },
      {
        find: '@internal/ai-v6',
        replacement: path.resolve(__dirname, '../_vendored/ai_v6/src/index.ts'),
      },
      {
        find: '@internal/external-types',
        replacement: path.resolve(__dirname, '../_external-types/src/index.ts'),
      },
      {
        find: '@mastra/core/a2a/client',
        replacement: path.resolve(__dirname, '../core/src/a2a/client.ts'),
      },
      {
        find: '@mastra/core/package.json',
        replacement: path.resolve(__dirname, '../core/package.json'),
      },
      {
        find: /^@mastra\/core\/(.+)$/,
        replacement: path.resolve(__dirname, '../core/src/$1/index.ts'),
      },
      {
        find: '@mastra/core',
        replacement: path.resolve(__dirname, '../core/src/index.ts'),
      },
      {
        find: /^@mastra\/ai-sdk\/(.+)$/,
        replacement: path.resolve(__dirname, '../../client-sdks/ai-sdk/src/$1.ts'),
      },
      {
        find: '@mastra/ai-sdk',
        replacement: path.resolve(__dirname, '../../client-sdks/ai-sdk/src/index.ts'),
      },
      {
        find: /^@mastra\/schema-compat\/adapters\/(.+)$/,
        replacement: path.resolve(__dirname, '../schema-compat/src/standard-schema/adapters/$1.ts'),
      },
      {
        find: /^@mastra\/schema-compat\/(.+)$/,
        replacement: path.resolve(__dirname, '../schema-compat/src/$1.ts'),
      },
      {
        find: '@mastra/schema-compat',
        replacement: path.resolve(__dirname, '../schema-compat/src/index.ts'),
      },
      {
        find: '@mastra/client-js',
        replacement: path.resolve(__dirname, '../../client-sdks/client-js/src/index.ts'),
      },
      {
        find: '@mastra/react',
        replacement: path.resolve(__dirname, '../../client-sdks/react/src/index.ts'),
      },
      {
        find: '@mastra/playground-ui/style.css',
        replacement: path.resolve(__dirname, '../playground-ui/src/index.css'),
      },
      {
        find: '@mastra/playground-ui/theme.css',
        replacement: path.resolve(__dirname, '../playground-ui/theme.css'),
      },
      {
        find: '@mastra/playground-ui/tokens',
        replacement: path.resolve(__dirname, '../playground-ui/src/ds/tokens/index.ts'),
      },
      {
        find: '@mastra/playground-ui/utils',
        replacement: path.resolve(__dirname, '../playground-ui/src/utils.ts'),
      },
      {
        find: /^@mastra\/playground-ui\/components\/(.+)$/,
        replacement: path.resolve(__dirname, '../playground-ui/src/ds/components/$1/index.ts'),
      },
      {
        find: '@mastra/playground-ui',
        replacement: path.resolve(__dirname, '../playground-ui/src/index.ts'),
      },
    ],
  },
  test: {
    name: 'unit:packages/playground',
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', '**/node_modules/**'],
  },
});
