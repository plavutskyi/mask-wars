// Types for nep330.mjs, which the race's tests import to check the code that goes to mainnet.
export const REPOSITORY: string;
export interface SourceMetadata {
  version: string | null;
  link: string | null;
  standards: { standard: string; version: string }[];
  build_info: {
    build_environment: string;
    build_command: string[];
    contract_path: string;
    source_code_snapshot: string;
    output_wasm_path: string | null;
  } | null;
}
export function codeHash(bytes: Uint8Array): string;
export function sourceMetadata(bytes: Uint8Array): Promise<SourceMetadata | null>;
export function faults(meta: SourceMetadata | null): string[];
