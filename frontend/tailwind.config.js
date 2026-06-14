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
          bg: '#0A0B0E',
          card: '#14161C',
          hover: '#1C1F28',
          border: '#2A2D37',
          text: '#E8E6E3',
          'text-secondary': '#8B8985',
        },
        bronze: {
          DEFAULT: '#C49A6C',
          dim: '#8B7345',
          light: '#D4B88A',
          glow: 'rgba(196, 154, 108, 0.15)',
        },
      },
      fontFamily: {
        display: ['"DM Serif Display"', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'bronze': '0 0 20px rgba(196, 154, 108, 0.15)',
        'bronze-sm': '0 0 10px rgba(196, 154, 108, 0.1)',
      },
      animation: {
        'bronze-pulse': 'bronzePulse 2s ease-in-out infinite',
      },
      keyframes: {
        bronzePulse: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(196, 154, 108, 0.2)' },
          '50%': { boxShadow: '0 0 20px rgba(196, 154, 108, 0.4)' },
        },
      },
    },
  },
  plugins: [],
}
