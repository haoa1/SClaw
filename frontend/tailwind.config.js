/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        stock: {
          up: '#ef4444',
          down: '#22c55e',
          flat: '#6b7280',
          bg: '#0f172a',
          card: '#1e293b',
          hover: '#334155',
        },
      },
    },
  },
  plugins: [],
}
