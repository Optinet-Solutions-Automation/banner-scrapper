import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        bg: '#07090f',
        surface: {
          DEFAULT: '#0c1120',
          2: '#101928',
          3: '#141f30',
        },
        border: {
          DEFAULT: '#1a2540',
          2: '#243452',
          hot: '#2e4880',
        },
        accent: {
          DEFAULT: '#4070d4',
          light: '#6090f0',
        },
      },
    },
  },
  plugins: [],
};

export default config;
