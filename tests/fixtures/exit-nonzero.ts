/**
 * P05 test fixture: harmless subprocess that writes diagnostics and exits 3.
 */
process.stderr.write("fixture: nonzero exit\n");
process.exit(3);
