import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Go metadata is independent of active native-analysis providers and host toolchains. */
export const GO_TOOL_CONTRACTS = [
  {
    name: "inspect_go_binary",
    ...toolContractMetadata("inspect_go_binary"),
    kind: "artifact-provider",
    description:
      "Inspect embedded Go compiler/module/build metadata in an explicit local ELF, PE or thin Mach-O image. With functions:true, also reads compiler-declared function names, entry addresses and verified file offsets from named Go 1.20-layout .gopclntab sections in ELF64 little-endian amd64 executables. Functions default to not-requested, avoiding table work and output. Returns artifact SHA-256 and exact metadata source ranges as observed Evidence. Requested function coverage is explicitly complete or unavailable; absent metadata does not establish absence of Go code. Requires no Go installation or disassembler and never executes the target, writes temporary files or accesses the network. Does not recover source mappings, types, inline functions or runtime behavior. Resource guards bound files to 256 MiB, embedded strings and cumulative function-name work to 1 MiB each, structural tables to 16 MiB and complete inline reports to 8 MiB; oversized reports fail without partial success.",
    inputSchema: inspectGoBinaryInputSchema,
    outputSchema: evidenceResultOf(goBinarySchema),
    examples: [
      {
        title: "Inspect embedded build provenance",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
