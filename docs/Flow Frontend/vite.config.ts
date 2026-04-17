import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    minify: "terser",
    terserOptions: {
      module: true,
      compress: {
        passes: 3,
        toplevel: true,
      },
      mangle: {
        toplevel: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (id.includes("sonner")) {
            return "vendor-toast"
          }
          if (id.includes("recharts") || id.includes("victory-vendor") || id.includes("d3-")) {
            return "vendor-charts"
          }
          if (id.includes("@azure/msal-browser")) {
            return "vendor-msal"
          }
          if (id.includes("react-router")) {
            return "vendor-router"
          }
          if (
            id.includes("@mui/") ||
            id.includes("@emotion/") ||
            id.includes("@popperjs/")
          ) {
            return "vendor-mui"
          }
          if (
            id.includes("@radix-ui/") ||
            id.includes("cmdk") ||
            id.includes("vaul")
          ) {
            return "vendor-radix"
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons"
          }
          if (
            id.includes("motion") ||
            id.includes("react-dnd") ||
            id.includes("react-slick") ||
            id.includes("embla-carousel-react")
          ) {
            return "vendor-interactions"
          }
          return "vendor-misc"
        },
      },
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
