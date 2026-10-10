import { defineConfig } from 'drizzle-kit'

// 个人库原有记忆迁移继续由 profile.ts 的 user_version 管理。
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/personalSchema.ts',
  out: './resources/profile-migrations'
})
