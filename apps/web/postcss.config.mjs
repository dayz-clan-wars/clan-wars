// Tailwind v4 is a PostCSS plugin; Next picks this file up with no other wiring.
// ⚠️ .mjs, so smoke.test.ts's ROOT_FILES filter must scan .mjs too — a config
// file scanned by nothing is exactly the hole that test keeps falling into.
export default { plugins: { "@tailwindcss/postcss": {} } };
