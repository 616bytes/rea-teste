import type { MipsElfMetadata } from "../../../src/domain/binaryTargetTypes.js";

export declare function parsePspReadelfMips(
  text: string,
): MipsElfMetadata & { readonly gnuAttributes: null };
