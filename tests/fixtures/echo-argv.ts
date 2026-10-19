/**
 * P05 test fixture: harmless subprocess that echoes its arguments as JSON.
 *
 * Used through the runner's private spawn seam to prove the exact argv reaches
 * the child without shell splitting or expansion. Exits 0.
 */
const args = process.argv.slice(2);
console.log(JSON.stringify(args));
process.exit(0);
