# Security

## Reporting

Please don't open a public issue for a security problem. Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability), or contact the maintainer, [@dextracker](https://github.com/dextracker), privately. You'll get an acknowledgement within a few days.

## Things to know when using forkit

- **forkit's built-in keys are public.** The default 4337 executor and utility keys, and every key the examples and tests derive from fixed strings, are for forks only. Never send real funds to them, and never reuse them on a live network.
- **Impersonation only works on the fork.** `prank`, `deal` and the bridge simulators use anvil's cheat RPCs, which a real node refuses.
- **Recordings contain what the RPC and APIs returned.** `@condensate_dev/forkit/http` redacts secrets from headers and URLs before it writes a fixture, but it doesn't redact response bodies. Review `.forkit-http/` fixtures before you commit them. Fork-cache recordings (`.forkit-cache/`) hold public chain state only.
- **RPC URLs** are redacted in forkit's errors and run events. Pass paid-RPC keys through `FORKIT_RPC_URL_<chainId>`, not in code.
