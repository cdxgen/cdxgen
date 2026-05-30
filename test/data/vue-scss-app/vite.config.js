import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Globally inject element-plus theme variables so every component can
        // reference them without an explicit import.  This is a common pattern
        // in Vue 3 / Vite projects that customise Element Plus styles.
        additionalData: `@use "element-plus/theme-chalk/src/common/var.scss" as *;`,
      },
      less: {
        additionalData: `@import "@/styles/variables.less";`,
      },
    },
  },
})
