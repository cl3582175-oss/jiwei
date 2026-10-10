import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/knowledgeSchema.ts',
  out: './resources/migrations'
})
