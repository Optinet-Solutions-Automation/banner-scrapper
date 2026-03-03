import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        slate: {
          750: '#293548',
          850: '#172033',
          950: '#0a0f1a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
