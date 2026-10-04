import { z } from "zod";

/**
 * zod 4 compiles object parsers with `new Function` when it can, and probes for that on first use.
 * Our CSP has no 'unsafe-eval', so the probe fails anyway, but browsers still report it as a
 * policy violation. Turn the feature off before any schema runs: no probe, no eval, same results.
 */
z.config({ jitless: true });
