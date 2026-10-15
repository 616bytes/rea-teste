import type {
  MipsElfMetadata,
  MipsGnuAttributes,
} from "../../../src/domain/binaryTargetTypes.js";

export declare function parsePspReadelfMips(
  text: string,
): MipsElfMetadata & { readonly gnuAttributes: MipsGnuAttributes | null };
