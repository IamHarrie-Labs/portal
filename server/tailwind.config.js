/** Build-time config for the static demo/assets/tailwind.css bundle.
 * Run: npx tailwindcss -c tailwind.config.js -i ./tailwind.input.css -o ../demo/assets/tailwind.css --minify
 */
module.exports = {
  content: ['../demo/*.html'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
      },
      colors: { gold: '#f4b728', orange: '#f7931a', ink: '#0b0d12', panel: '#0e1017' },
    },
  },
  plugins: [],
};
