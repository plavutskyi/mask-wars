import localFont from 'next/font/local';

// The brand's fonts from packages/brand, cut to what the site draws (packages/brand/scripts/fonts.py):
// Hubot Sans for words at weight 800 only, width 85–125; Mona Sans for numbers and lines, weight 400–800, width 85–125.
export const hubot = localFont({
  src: '../../../packages/brand/fonts/hubot-sans.woff2',
  variable: '--font-hubot',
  weight: '800',
  display: 'swap',
  declarations: [{ prop: 'font-stretch', value: '85% 125%' }],
  fallback: ['system-ui', 'sans-serif'],
});

export const mona = localFont({
  src: '../../../packages/brand/fonts/mona-sans.woff2',
  variable: '--font-mona',
  weight: '400 800',
  display: 'swap',
  declarations: [{ prop: 'font-stretch', value: '85% 125%' }],
  fallback: ['system-ui', 'sans-serif'],
});
