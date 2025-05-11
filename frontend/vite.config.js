// frontend/vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [
    react({
      // Enables fast refresh and inlining of environment variables prefixed with VITE_
      fastRefresh: true
    })
  ],

  // 1) Dev server settings
  server: {
    port: 3000,        // cambia si quieres otro puerto
    open: true,        // abre http://localhost:3000 al arrancar
    proxy: {
      // redirige /auth, /auth/callback y /run-now al backend Flask
      '/auth': 'http://localhost:5000',
      '/auth/callback': 'http://localhost:5000',
      '/run-now': 'http://localhost:5000'
    }
  },

  // 2) Import alias para src/ → permite import Foo from '@/components/Foo'
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },

  // 3) Define build options
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development'
  },

  // 4) Exposición de variables de entorno VITE_*
  define: {
    'process.env': {}
  }
}))
