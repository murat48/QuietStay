// The two ZK packages ship JavaScript only. These declare the parts this
// repository calls, and nothing more.

declare module "ffjavascript" {
  export function getCurveFromName(
    name: string,
    singleThread?: boolean,
  ): Promise<{ Fr: unknown; terminate(): Promise<void> }>;
}

declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const wtns: {
    calculate(input: Record<string, unknown>, wasmFile: string, wtnsFile: string): Promise<void>;
    check(r1csFile: string, wtnsFile: string): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkeyFile: string): Promise<unknown>;
  };
}
