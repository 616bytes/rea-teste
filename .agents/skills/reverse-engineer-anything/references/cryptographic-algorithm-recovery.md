# Cryptographic algorithm recovery from execution traces

Identify, and where the evidence allows reconstruct, a cryptographic, signing,
or encoding algorithm from a recorded execution trace or passive runtime
observation of a shipped binary. Use this when a claim depends on *how* a
ciphertext, header, token, MAC, or signature was produced and that behavior is
not established by available source. The output is an Evidence-backed
identification or reconstruction with explicit limitations, not a guarantee.

This workflow pairs with [runtime observation](runtime-observation.md) for
capturing behavior and [evidence workflows](evidence-workflows.md) for recording
findings, comparisons, and unknowns. Static-only inputs (a disassembly region,
a decompiled function) follow [native and artifacts](native-and-artifacts.md).

## Scope boundary

This is an identification-and-evidence workflow. Recognizing and reporting a
protection (packer, control-flow obfuscation, VM, white-box) is in scope;
defeating it is not. Do not use this document to recover automatically
protected code, lift a VM's bytecode into cleartext logic, extract a white-box's
embedded key for bypass, or forge a signature or token. When a target's
algorithm sits behind such protection, identify and report the protection, then
stop and `record_unknown`. Algorithm understanding for interoperability,
verification, or evidence stays in scope; protection defeat does not.

## Evidence discipline

Answer only from trace evidence. Never invent instructions, register values,
memory bytes, function boundaries, keys, constants, field semantics, branch
outcomes, or call relations. Cite the `evidence_id` or trace anchor behind every
structural claim. A fingerprint or matching pattern is a hypothesis, not causal
proof of which algorithm ran.

Before concluding a high-confidence identification, run an adversarial pass
against your own claim: list the observations that would be present if you were
wrong, confirm they are absent in the trace rather than merely unmentioned, and
keep every residual gap in `record_unknown` with its required authority or
coverage. A conclusion that no counter-evidence was sought is not high
confidence.

## Multi-signal correlation

No single signal identifies an algorithm on a hardened target. Correlate at
least two of: constant fingerprints, instruction fingerprints, data-flow shape
(key schedule, round count, block size, table lookups), and the I/O boundary
(input bytes in, output bytes out). Treat agreement across independent signals
as the evidence, not any one hit.

- **Zero constant hits is not absence.** Constants may be computed at runtime,
  loaded from a data section the trace never reads as immediates, masked by a
  modification, broadcast through SIMD lanes rather than scalar loads, or hidden
  by a white-box table. Enumerate the benign explanations before concluding
  "no crypto."
- **An instruction fingerprint is strong but not final.** ARM Crypto Extensions
  (`aes*`, `sha1*`, `sha256*`, `sha512*`, `pmull`/`pmull2`, `crc32*`) pin the
  primitive family but not the mode, key, or whether the primitive is load-
  bearing versus incidental. Confirm the surrounding data flow.
- **A primitive can run without a recognizable mnemonic** — table-driven
  software AES, a bitsliced implementation, or a NEON-vectorized core. Absence
  of the mnemonic does not rule the primitive out; look for the table or the
  lane pattern instead.
- **ALU-only "hits" are usually false positives.** A constant that appears only
  as the result of arithmetic, never as a loaded immediate or a memory read, is
  typically a collision. Weight real immediate/memory evidence over ALU
  coincidence, and SIMD-broadcast evidence (e.g. HMAC ipad/opad across lanes)
  as its own class.

## Four-phase recovery

**A — Locate.** Find the crypto region from the I/O boundary: the trace window
where the known input is consumed and the known output is produced. Bound it by
call-frame entry/exit so later phases reason over a finite region, not the whole
trace.

**B — Reconstruct data flow.** Within the region, recover the key schedule
(how key material expands across rounds), the round function and round count,
and any table lookups (sbox, T-tables, permutation tables). Record block size,
endianness, and padding from observed bytes, not assumption.

**C — Identify and check for modification.** Match the recovered structure
against candidates (cheat sheet below). When the structure matches a known
algorithm but a constant, rotation amount, sbox entry, or round count differs,
report it as "<algorithm>-like with modifications" and name the specific
deviation and its anchor. A modified algorithm shares the shape, not the test
vectors.

**D — Closed-loop verification.** An identification is unverified until a
reference implementation, driven with the trace's observed inputs and
parameters, reproduces the trace's observed output byte-for-byte. A partial or
structural-only match is a candidate; say so. If verification is impossible with
available inputs, deliver the candidate and `record_unknown` for the missing
input or parameter rather than overstating the result.

## Constant and structure fingerprints

Identification evidence only; presence of a fingerprint is a hypothesis to
corroborate, never a conclusion on its own.

- **Hash:** MD5 (init + 64-entry T table), SHA-1, SHA-256 (init + K table),
  SHA-512, SM3 (init + T_j round constants), SHA-3/Keccak round constants,
  CRC32, FNV-1a. In an active hashing region the main-loop constants (T/K/T_j)
  dominate the signal, not the IV. Count per compression block: each table
  entry typically appears once per block across its rounds, so an entry's hit
  count tracks block count, not round count.
- **Symmetric:** AES (sbox / Te tables), SM4, DES/3DES (SP-boxes), TEA/XTEA
  (delta `0x9E3779B9`), ChaCha20/Salsa20 ("expand 32-byte k").
- **MAC / AEAD:** HMAC (ipad `0x36`/opad `0x5C`, scalar or SIMD-broadcast),
  Poly1305, SipHash; AEAD is a composition — identify the primitive plus the
  mode (GCM via `pmull` + `ghash`, ChaCha20-Poly1305 via the two sub-primitives
  together) rather than a single marker.
- **ECC:** P-256 / secp256k1 / Ed25519 / Curve25519 field primes and base
  points.
- **Rolling / derived token schemes** (common in mobile risk-control headers):
  a seed plus repeated keyed derivation; identify the primitive per round and
  the chaining, and verify the full derivation end-to-end, not one round.

## Protection detection (identify, then defer)

Recognize and report these; do not attempt defeat or automated recovery.

- **Code virtualization (VMP/Themida/Code Virtualizer/custom VM):** a dispatch
  loop, a handler table, and a bytecode/context structure appearing together.
  Report the fingerprint and stop; recovering the handler semantics or lifting
  the bytecode is out of scope here.
- **Control-flow obfuscation (OLLVM):** flattening (a dispatcher switching on a
  state variable), bogus control flow, instruction substitution. Report that
  the region is obfuscated and which pass is indicated.
- **White-box crypto:** large embedded lookup tables standing in for the key, no
  recognizable key schedule, primitive structure present but key material
  absent. Report as white-box and record the key recovery as out of scope.

## Delivery and discipline

Deliver the identification or reconstruction, the evidence anchors behind it,
the verification result (byte-exact, partial, or none), and the residual
unknowns. When three consecutive steps in one direction yield no progress,
switch signal or phase rather than repeating. Keep the investigation bounded to
the user's actual question; do not expand into protection defeat or unrequested
targets.
